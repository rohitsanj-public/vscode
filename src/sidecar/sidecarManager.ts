// sidecar manager module

import { spawn } from "child_process";
import fs from "fs";

import sidecarExecutablePath, { version as currentSidecarVersion } from "ide-sidecar";
import * as vscode from "vscode";

import { Configuration, HandshakeResourceApi, SidecarVersionResponse } from "../clients/sidecar";
import { Logger } from "../logging";
import { getStorageManager } from "../storage";
import { checkSidecarOsAndArch } from "./checkArchitecture";
import {
  SIDECAR_BASE_URL,
  SIDECAR_LOGFILE_PATH,
  SIDECAR_PORT,
  SIDECAR_PROCESS_ID_HEADER,
  WORKSPACE_PROCESS_ID_HEADER,
} from "./constants";
import { ErrorResponseMiddleware } from "./middlewares";
import { SidecarHandle } from "./sidecarHandle";

import { normalize } from "path";
import { Tail } from "tail";

/**
 * Output channel for viewing sidecar logs.
 * @remarks We aren't using a `LogOutputChannel` since we could end up doubling the timestamp+level info.
 */
export const sidecarOutputChannel: vscode.OutputChannel =
  vscode.window.createOutputChannel("Confluent (Sidecar)");

const SIDECAR_AUTH_TOKEN_SECRET_KEY = "CONFLUENT_SIDECAR_AUTH_SECRET";
const MOMENTARY_PAUSE_MS = 500; // half a second.

const logger = new Logger("sidecarManager");

// Internal singleton class manageing starting / restarting sidecar process and handing back a reference to an API client (SidecarHandle)
// which should be used for a single action and then discarded. Not retained for multiple actions, otherwise
// we won't be in position to restart / rehandshake with the sidecar if needed.
export class SidecarManager {
  // Counters for logging purposes.
  private getHandleCallNumSource: number = 0;
  private handleIdSource: number = 0;

  // We want at most one sidecar process attempted to be started up at a time.
  private pendingHandlePromise: Promise<SidecarHandle> | null = null;

  private myPid: string = process.pid.toString();

  // tail -F actor for the sidecar log file.
  private logTailer: Tail | null = null;

  private sidecarContacted: boolean = false;

  /** Construct or return reference to already running sidecar process.
   * Code should _not_ retain the return result here for more than a single direct action, in that
   * the sidecar process may need to be restarted at any time.
   **/
  public getHandle(): Promise<SidecarHandle> {
    const callnum = this.getHandleCallNumSource++;

    // 0. If we're in the process of starting up the sidecar, defer to it
    if (this.pendingHandlePromise) {
      return this.pendingHandlePromise;
    } else {
      // Make a new promise, retain it, return it.
      this.pendingHandlePromise = this.getHandlePromise(callnum);
      return this.pendingHandlePromise;
    }
  }

  /**
   * Inner function to actually gain reference to a happy running sidecar.
   * @param callnum What call number this is, for logging purposes.
   * @returns Promise<SidecarHandle> A promise that will resolve with a SidecarHandle object
   *          for actual sidecar interaction.
   */
  private async getHandlePromise(callnum: number): Promise<SidecarHandle> {
    // Try to make a request to the sidecar to see if it's running.
    // If it's not, start it.
    // If it replies with a 401, then we need to restart it because we're out of sync with the access token.

    // Try to make hit to the healthcheck endpoint. One of three things will happen, in order of likelyhood):
    // 1. The sidecar is running and healthy, in which case we're done.
    // 2. The sidecar is not running, in which case we need to start it.
    // 3. The sidecar is running but rejects our access token, in which case we need to restart it.
    //   (the 401 should include the sidecar's PID in the response headers, so we can kill it by PID)
    //
    // (When starting the extension from scratch, we'll go through path two and then later on path one. Path three only needed
    //  if something goes wrong with managing the access token or someone )

    // TODO: We don't need to get the access token from secret store every time?
    let accessToken: string | undefined = await this.getAuthTokenFromSecretStore();

    if (this.logTailer == null) {
      this.startTailingSidecarLogs();
    }

    for (let i = 0; i < 10; i++) {
      // Get our current auth header out of the secret store
      // (If it's not there, will return empty string, and we'll end up down either path 2. or 3. below)

      const logPrefix = `getHandlePromise(${callnum} loop ${i})`;

      try {
        if (await this.healthcheck(accessToken)) {
          // 1. The sidecar is running and healthy, in which case we're probably done.
          // (this is the only path that may resolve this promise successfully)
          const handle = new SidecarHandle(accessToken, this.myPid, this.handleIdSource++);

          if (!this.sidecarContacted) {
            // Do the one-time-only things re/this sidecar process, whether or not
            // we had to start it up or was already running.
            await this.firstSidecarContactActions(handle);
          }

          // This client is good to go. Resolve the promise with it.
          this.pendingHandlePromise = null;

          return handle;
        }
      } catch (e) {
        try {
          if (e instanceof NoSidecarRunningError) {
            // 2. The sidecar is not running (we got ECONNREFUSED), in which case we need to start it.
            logger.info(`${logPrefix}: No sidecar running, starting sidecar`);
            accessToken = await this.startSidecar(callnum);

            // Now jump back to the top of loop, try healthcheck / authentication again.
            continue;
          } else if (e instanceof WrongAuthSecretError) {
            // 3. The sidecar is running but rejects our access token, in which case we need to kill + start it.
            logger.info(`${logPrefix}:  Wrong access token, restarting sidecar`);
            // Kill the process, pause an iota, restart it, then try again.
            try {
              this.killSidecar(e.sidecar_process_id);
            } catch (e: any) {
              logger.error(
                `${logPrefix}: failed to kill sidecar process ${e.sidecar_process_id}: ${e}`,
              );
              throw e;
            }

            await this.pause();

            // Start new sidecar proces.
            accessToken = await this.startSidecar(callnum);
            logger.info(`${logPrefix}: Started new sidecar, got new access token.`);

            // Now jump back to the top, try healthcheck / authentication again.
            continue;
          } else {
            logger.error(`${logPrefix}: unhandled error`, e);
            this.pendingHandlePromise = null;
            throw e;
          }
        } catch (e) {
          // as thrown by startSidecar()
          if (e instanceof NoSidecarExecutableError) {
            logger.error(`${logPrefix}: sidecar executable not found`, e);
          } else if (e instanceof SidecarFatalError) {
            logger.error(`${logPrefix}: sidecar process failed to start`, e);
          }
          this.pendingHandlePromise = null;
          throw e;
        }
      } // end catch.
    } // end for loop.
    // If we get here, we've tried 10 times and failed. Return an error.
    this.pendingHandlePromise = null;
    throw new Error(`getHandlePromise(${callnum}): failed to start sidecar`);
  }

  /**
   * Perform actions that should only be done once per workspace + sidecar process:
   *  - When we know we just started up new sidecar,
   *  - or when this workspace is doing first contact with an already-running sidecar.
   **/
  private async firstSidecarContactActions(handle: SidecarHandle): Promise<void> {
    // Check the sidecar version, if it's not the same as the extension, show a warning.
    // This is a non-fatal issue, but we want the user to know and have the option to restart the sidecar.
    // If sidecar gets restarted, then we won't complete successfully, and a new sidecar will be started up
    // outside of this function.
    var version_result: SidecarVersionResponse | undefined = undefined;
    try {
      version_result = await handle.VersionResourceApi().gatewayV1VersionGet();
      logger.info(`Sidecar version: ${version_result.version}`);
    } catch (e) {
      // Some devs may have sidecars running that don't have the version endpoint (Pinnipeds especially)
      logger.error(`Failed to get sidecar version: ${e}`);
      version_result = { version: "pre-history" };
    }

    if (version_result.version !== currentSidecarVersion) {
      logger.warn("Shutting down existing sidecar process due to version mismatch...");
      this.killSidecar(await handle.getSidecarPid());
      // Allow the old one a little bit of time to die off.
      await this.pause();
      if (this.pendingHandlePromise != null) {
        // clear out the old promise and start fresh
        this.pendingHandlePromise = null;
      }
      // Ask to get a new handle, which will start a new sidecar process,
      // which will end up calling firstSidecarContactActions() again (eventually).
      logger.info("Restarting sidecar after shutting down old version...");
      await this.getHandle();
    }

    this.sidecarContacted = true;
  }

  /**
   * Make a healthcheck request to the sidecar. Returns true if the sidecar is healthy.
   * Will find out if the sidecar is healthy, or if it's not running, or if it's running but rejects our auth token.
   **/
  private async healthcheck(accessToken: string): Promise<boolean> {
    try {
      // This and handshake() are the most useful places to inject our PID as a header. No need
      // to do it in every toplevel request since we healthcheck() every time a sidecar handle is requested.
      const response = await fetch(`${SIDECAR_BASE_URL}/gateway/v1/health/live`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          [WORKSPACE_PROCESS_ID_HEADER]: this.myPid,
        },
      });
      if (response.status === 200) {
        return true;
      } else if (response.status === 401) {
        // Unauthorized. Will need to restart sidecar.
        // print out the response headers
        logger.error(
          `GET ${SIDECAR_BASE_URL}/gateway/v1/health/live returned 401 with headers: ${JSON.stringify(response.headers)}`,
        );
        // Take note of the PID in the response headers.
        const sidecar_pid = response.headers.get(SIDECAR_PROCESS_ID_HEADER);
        if (sidecar_pid) {
          const sidecar_pid_int = parseInt(sidecar_pid);
          if (sidecar_pid_int > 0) {
            // Have enough trustworthy info to throw a specific error that will cause
            // us to kill the sidecar process and start a new one.
            throw new WrongAuthSecretError(
              `GET ${SIDECAR_BASE_URL}/gateway/v1/health/live returned 401.`,
              sidecar_pid_int,
            );
          } else {
            // sidecar quarkus dev mode may skip initialization and still return 401 and this header, but
            // with PID 0, which we will never want to try to kill -- kills whole process group!
            throw new Error(
              `GET ${SIDECAR_BASE_URL}/gateway/v1/health/live returned 401, but claimed PID ${sidecar_pid_int} in the response headers!`,
            );
          }
        } else {
          throw new Error(
            `GET ${SIDECAR_BASE_URL}/gateway/v1/health/live returned 401, but without a PID in the response headers!`,
          );
        }
      } else {
        throw new Error(
          `GET ${SIDECAR_BASE_URL}/gateway/v1/health/live returned unhandled status ${response.status}`,
        );
      }
    } catch (e) {
      if (e instanceof TypeError) {
        // ECONNREFUSED
        throw new NoSidecarRunningError(
          `GET ${SIDECAR_BASE_URL}/gateway/v1/health/live failed with ECONNREFUSED`,
        );
      } else {
        throw e;
      }
    }
  }

  sidecarArchitectureBlessed: boolean | null = null;
  /**
   *  Actually spawn the sidecar process, handshake with it, return its auth token string.
   **/
  private async startSidecar(callnum: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      (async () => {
        const logPrefix = `startSidecar(${callnum})`;
        logger.info(`${logPrefix}: Starting new sidecar process`);

        let executablePath = sidecarExecutablePath;
        // check platform and adjust the path, so we don't end up with paths like:
        // "C:/c:/Users/.../ide-sidecar-0.26.0-runner.exe"
        if (process.platform === "win32") {
          executablePath = normalize(executablePath.replace(/^[/\\]+/, ""));
        }
        this.sidecarContacted = false;

        if (this.sidecarArchitectureBlessed === null) {
          // check to see if the sidecar file exists
          logger.info(`exe path ${executablePath}, version ${currentSidecarVersion}`);
          try {
            fs.accessSync(executablePath);
          } catch (e) {
            logger.error(`${logPrefix}: component ${executablePath} does not exist`, e);
            reject(new NoSidecarExecutableError(`Component ${executablePath} does not exist`));
          }

          // Now check to see if is cooked for the right OS + architecture
          try {
            checkSidecarOsAndArch(executablePath);
            this.sidecarArchitectureBlessed = true;
          } catch (e) {
            this.sidecarArchitectureBlessed = false;
            logger.error(`${logPrefix}: component has wrong architecture`, e);
            reject(new SidecarFatalError((e as Error).message));
            return;
          }
        } else if (this.sidecarArchitectureBlessed === false) {
          // We already know the sidecar architecture is wrong, so don't bother trying to start it.
          reject(new SidecarFatalError(`${logPrefix}: component has wrong architecture`));
          return;
        }

        // Start up the sidecar process, daemonized no stdio.
        // Set up the environment for the sidecar process.
        const sidecar_env = constructSidecarEnv(process.env);

        try {
          const sidecarProcess = spawn(executablePath, [], {
            detached: true,
            stdio: "ignore",
            env: sidecar_env,
          });
          logger.info(
            `${logPrefix}: started sidecar process with pid ${sidecarProcess.pid}, logging to ${sidecar_env["QUARKUS_LOG_FILE_PATH"]}`,
          );
          sidecarProcess.unref();

          // May think about a  sidecarProcess.on("exit", (code: number) => { ... }) here to catch early exits,
          // but the sidecar file architecture check above should catch most of those cases.
        } catch (e) {
          // Failure to spawn the process. Reject and return (we're the main codepath here).
          // (TODO -- test if OSX intel gets this codepath if / when trying an ARM sidecar)
          // (ARM Mac that has Rosetta2 fails with early process death above due to Rosetta2 trying
          // to run the intel binary, but Rosetta2 lacks certain CPU features that the binary expects and
          // the process logs a specific error message to that effect and exits(1), but isn't a spawn error.)
          logger.error(`${logPrefix}: sidecar component spawn fatal error`, e);
          reject(e);
          return;
        }

        // The sidecar access token, as learned from the handshake endpoint.
        let accessToken = "";

        // Pause after spawning (so as to let the sidecar initialize and bind to its port),
        // then try to hit the handshake endpoint. It may fail a few times while
        // the sidecar process is coming online.
        for (let i = 0; i < 10; i++) {
          try {
            await this.pause();

            logger.info(
              `${logPrefix}(attempt ${i}): done pausing, on to hitting handshake endpoint`,
            );

            accessToken = await this.doHandshake();
            logger.warn(`${logPrefix}(attempt ${i}): handshake successful, got auth token.`);
            break;
          } catch (e) {
            // We expect ECONNREFUSED while the sidecar is coming up, but log other unexpected errors.
            if (!wasConnRefused(e)) {
              logger.error(`${logPrefix}(attempt ${i}): handshake failed with unexpected error`, e);
            }
            if (i < 9) {
              logger.info(`${logPrefix}(attempt ${i}): pausing, retrying handshake`);
            }
          }
        }
        await getStorageManager().setSecret(SIDECAR_AUTH_TOKEN_SECRET_KEY, accessToken);
        logger.debug(`${logPrefix}: Stored new auth token in secret store.`);

        resolve(accessToken);
      })();
    });
  }

  /**
   * Hit the handshake endpoint on the sidecar to get an auth token.
   * @returns The auth token string.
   */
  private async doHandshake(): Promise<string> {
    const config = new Configuration({
      basePath: `http://localhost:${SIDECAR_PORT}`,
      headers: { [WORKSPACE_PROCESS_ID_HEADER]: process.pid.toString() },
      middleware: [new ErrorResponseMiddleware()],
    });
    const api = new HandshakeResourceApi(config);
    const { auth_secret } = await api.gatewayV1HandshakeGet();
    if (auth_secret == null) throw new Error("Unable to receive auth token from sidecar");
    return auth_secret;
  }

  /**
   * Set up tailing the sidecar log file onto the vscode output channel.
   **/
  private startTailingSidecarLogs() {
    // Create sidecar's log file if it doesn't exist so that we can
    // start tailing it right away before the sidecar process may exist.
    try {
      fs.accessSync(SIDECAR_LOGFILE_PATH);
    } catch {
      fs.writeFileSync(SIDECAR_LOGFILE_PATH, "");
    }

    this.logTailer = new Tail(SIDECAR_LOGFILE_PATH);

    sidecarOutputChannel.appendLine(
      `Tailing the extension's sidecar logs from "${SIDECAR_LOGFILE_PATH}" ...`,
    );

    // Take note of the start of exception lines in the log file, show as toast (if user has allowed via config)
    // Define a regex pattern to find "ERROR", a parenthesized thread name, and capture everything after it
    const regex = /ERROR.*\(([^)]+)\)\s*(.*)$/;

    this.logTailer.on("line", (data: any) => {
      const line: string = data.toString();
      const errorMatch = line.match(regex);
      if (errorMatch) {
        const config = vscode.workspace.getConfiguration();
        const notifySidecarExceptions = config.get(
          "confluent.debugging.showSidecarExceptions",
          false,
        );
        if (notifySidecarExceptions) {
          vscode.window.showErrorMessage(`Sidecar error: ${errorMatch[2]}`);
        }
      }
      sidecarOutputChannel.appendLine(line);
    });

    this.logTailer.on("error", (data: any) => {
      sidecarOutputChannel.appendLine(`Error: ${data.toString()}`);
    });
  }

  /**
   * Get the auth token secret from the storage manager. Returns empty string if none found.
   **/
  async getAuthTokenFromSecretStore(): Promise<string> {
    const existing_secret = await getStorageManager().getSecret(SIDECAR_AUTH_TOKEN_SECRET_KEY);
    if (existing_secret) {
      return existing_secret;
    }
    return "";
  }

  /**
   * Kill the sidecar process by PID.
   * @todo: Currently only works on Unix-like systems. Needs Windows support.
   * @param process_id The sidecar's process id.
   */
  private killSidecar(process_id: number) {
    // TODO: How to do this on Windows also?
    process.kill(process_id, "SIGTERM");
    logger.debug(`Killed old sidecar process ${process_id}`);
  }

  /**
   * Pause for a moment.
   */
  private async pause(): Promise<void> {
    // pause an iota
    await new Promise((timeout_resolve) => setTimeout(timeout_resolve, MOMENTARY_PAUSE_MS));
  }
}

/** Sidecar is not currently running (better start a new one!) */
class NoSidecarRunningError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** Sidecar could not start up successfully */
class SidecarFatalError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 *  If the auth token we have on record for the sidecar is rejected, will need to
 * restart it. Fortunately it tells us its PID in the response headers, so we know
 * what to kill.
 */
class WrongAuthSecretError extends Error {
  public sidecar_process_id: number;

  constructor(message: string, sidecar_process_id: number) {
    super(message);
    this.sidecar_process_id = sidecar_process_id;
  }
}

/** Could not find the sidecar executable. */
class NoSidecarExecutableError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// The following functions exported for testing purposes.
/** Introspect into an exception's cause stack to discern if was ultimately caused by ECONNREFUSED. */
export function wasConnRefused(e: any): boolean {
  // They don't make this easy, do they? Have to dig into a few layers of causes, then also
  // array of aggregated errors to find the root cause expressed as `code == 'ECONNREFUSED'`.

  if (e == null) {
    // null or undefined?
    return false;
  } else if (e.code) {
    return e.code === "ECONNREFUSED";
  } else if (e.cause) {
    return wasConnRefused(e.cause);
  } else if (e.errors) {
    // Fortunately when happens in real life, it's always within the first error in the array.
    return wasConnRefused(e.errors[0]);
  } else {
    // If we can't find it in the main eager branching above, then it wasn't ECONNREFUSED.
    return false;
  }
}

/**
 * Construct the environment for the sidecar process.
 * @param env The current environment, parameterized for test purposes.
 * @returns The environment object for the sidecar process.
 */
export function constructSidecarEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sidecar_env = Object.create(env);
  sidecar_env["QUARKUS_LOG_FILE_ENABLE"] = "true";
  sidecar_env["QUARKUS_LOG_FILE_ROTATION_ROTATE_ON_BOOT"] = "false";
  sidecar_env["QUARKUS_LOG_FILE_PATH"] = SIDECAR_LOGFILE_PATH;

  // If we are running within WSL, then need to have sidecar
  // bind to 0.0.0.0 instead of its default localhost so that
  // browsers running on Windows can connect to it during oauth
  // flow. The server port will still be guarded by the firewall.
  if (env.WSL_DISTRO_NAME) {
    sidecar_env["QUARKUS_HTTP_HOST"] = "0.0.0.0";
  }

  return sidecar_env;
}
