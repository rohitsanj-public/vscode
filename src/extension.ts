// Import this first!
import * as Sentry from "@sentry/node";
/**
 * Initialize Sentry for error tracking (and future performance monitoring?).
 * Sentry.init needs to be run first before any other code so that Sentry can capture all errors.
 * `process.env.SENTRY_DSN` is fetched & defined during production builds only for Confluent official release process
 *
 * @see https://docs.sentry.io/platforms/node/
 */
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: 1.0, //  Capture 100% of the transactions
    profilesSampleRate: 1.0,
    integrations: [Sentry.rewriteFramesIntegration()],
    ignoreErrors: [
      "The request failed and the interceptors did not return an alternative response",
    ],
  });
}

import * as vscode from "vscode";
import { checkTelemetrySettings } from "./telemetry";
if (process.env.SENTRY_DSN) {
  Sentry.addEventProcessor(checkTelemetrySettings);
}

import { ConfluentCloudAuthProvider, getAuthProvider, getAuthSession } from "./authProvider";
import { registerCommandWithLogging } from "./commands";
import { commands as connectionCommands } from "./commands/connections";
import { commands as debugCommands } from "./commands/debugtools";
import { commands as diffCommands } from "./commands/diffs";
import { commands as environmentCommands } from "./commands/environments";
import { commands as extraCommands } from "./commands/extra";
import { commands as kafkaClusterCommands } from "./commands/kafkaClusters";
import { commands as organizationCommands } from "./commands/organizations";
import { commands as schemaRegistryCommands } from "./commands/schemaRegistry";
import { commands as schemaCommands } from "./commands/schemas";
import { commands as supportCommands } from "./commands/support";
import { commands as topicCommands } from "./commands/topics";
import { AUTH_PROVIDER_ID, AUTH_PROVIDER_LABEL } from "./constants";
import { activateMessageViewer } from "./consume";
import { setExtensionContext } from "./context";
import { SchemaDocumentProvider } from "./documentProviders/schema";
import { Logger, outputChannel } from "./logging";
import { registerProjectGenerationCommand } from "./scaffold";
import { sidecarOutputChannel } from "./sidecar";
import { StorageManager } from "./storage";
import { migrateStorageIfNeeded } from "./storage/migrationManager";
import { getTelemetryLogger } from "./telemetry";
import { getUriHandler } from "./uriHandler";
import { ResourceViewProvider } from "./viewProviders/resources";
import { SchemasViewProvider } from "./viewProviders/schemas";
import { SupportViewProvider } from "./viewProviders/support";
import { TopicViewProvider } from "./viewProviders/topics";

const logger = new Logger("extension");

// This method is called when your extension is activated based on the activation events
// defined in package.json
// ref: https://code.visualstudio.com/api/references/activation-events
export async function activate(context: vscode.ExtensionContext): Promise<vscode.ExtensionContext> {
  logger.info(`Extension ${context.extension.id}" activate() triggered.`);
  try {
    context = await _activateExtension(context);
    logger.info("Extension fully activated");
  } catch (e) {
    logger.error("Error activating extension", e);
    throw e;
  }
  // XXX: used for testing; do not remove
  return context;
}

/**
 * Activate the extension by setting up all the necessary components and registering commands.
 * @remarks This is the try/catch wrapped function called from the extension's .activate() method
 * to ensure that any errors are caught and logged properly.
 */
async function _activateExtension(
  context: vscode.ExtensionContext,
): Promise<vscode.ExtensionContext> {
  getTelemetryLogger().logUsage("Extension Activated");

  // must be done first to allow any other downstream callers to call `getExtensionContext()`
  // (e.g. StorageManager for secrets/states, webviews for extension root path, etc)
  setExtensionContext(context);

  context = await setupDebugHelpers(context);
  await setupContextValues();

  // these two need to be in order because they depend on each other
  context = await setupStorage(context);
  const authProviderDisposables = await setupAuthProvider();
  context.subscriptions.push(...authProviderDisposables);

  context = setupViewProviders(context);
  context = setupCommands(context);
  context = await setupDocumentProviders(context);

  // these are also just handling command registration and setting disposables
  activateMessageViewer(context);
  registerProjectGenerationCommand(context);

  return context;
}

async function setupDebugHelpers(
  context: vscode.ExtensionContext,
): Promise<vscode.ExtensionContext> {
  // automatically display and focus the Confluent extension output channel in development mode
  // to avoid needing to keep the main window & Debug Console tab open alongside the extension dev
  // host window during debugging
  if (process.env.LOGGING_MODE === "development") {
    await vscode.commands.executeCommand("confluent.showOutputChannel");
  }
  context.subscriptions.push(outputChannel, sidecarOutputChannel);
  logger.info("Output channel disposables added");
  // set up debugging commands before anything else, in case we need to reset global/workspace state
  // or there's a problem further down with extension activation
  context.subscriptions.push(...debugCommands);
  logger.info("Debug command disposables added");
  return context;
}

/** Configure any starting contextValues to use for view/menu controls during activation. */
async function setupContextValues() {
  // require re-selecting a cluster for the Topics/Schemas views on extension (re)start
  const kafkaClusterSelected = vscode.commands.executeCommand(
    "setContext",
    "confluent.kafkaClusterSelected",
    false,
  );
  const schemaRegistrySelected = vscode.commands.executeCommand(
    "setContext",
    "confluent.schemaRegistrySelected",
    false,
  );
  // enables the "Select for Compare" / "Compare with Selected" commands
  const diffResources = vscode.commands.executeCommand(
    "setContext",
    "confluent.readOnlyDiffableResources",
    ["ccloud-schema"],
  );
  // enables the "View in Confluent Cloud" command; these resources must have the "ccloudUrl" property
  // and the `contextValue` in their *TreeItem classes must match the `contextValue` listed below
  const openInCCloudResources = vscode.commands.executeCommand(
    "setContext",
    "confluent.ccloudResources",
    [
      "ccloud-environment",
      "ccloud-kafka-cluster",
      "ccloud-kafka-topic",
      "ccloud-kafka-topic-with-schema",
      "ccloud-schema-registry-cluster",
      "ccloud-schema",
    ],
  );
  // allow for easier matching using "in" clauses for our Resources/Topics/Schemas views
  const viewsWithResources = vscode.commands.executeCommand(
    "setContext",
    "confluent.viewsWithResources",
    ["confluent-resources", "confluent-topics", "confluent-schemas"],
  );
  // enables the "Copy ID" command; these resources must have the "id" property
  const resourcesWithIds = vscode.commands.executeCommand(
    "setContext",
    "confluent.resourcesWithIDs",
    [
      "ccloud-environment",
      "ccloud-kafka-cluster",
      "ccloud-schema-registry-cluster", // only ID, no name
      "ccloud-schema",
      "local-kafka-cluster",
    ],
  );
  const resourcesWithNames = vscode.commands.executeCommand(
    "setContext",
    "confluent.resourcesWithNames",
    [
      "ccloud-environment",
      "ccloud-kafka-cluster",
      "ccloud-kafka-topic", // only name, no ID
      "ccloud-kafka-topic-with-schema", // only name, no ID
      "local-kafka-cluster",
      "local-kafka-topic", // only name, no ID
      "local-kafka-topic-with-schema", // only name, no ID
    ],
  );
  await Promise.all([
    kafkaClusterSelected,
    schemaRegistrySelected,
    diffResources,
    openInCCloudResources,
    viewsWithResources,
    resourcesWithIds,
    resourcesWithNames,
  ]);
}

async function setupStorage(context: vscode.ExtensionContext): Promise<vscode.ExtensionContext> {
  // initialize singleton storage manager instance so other parts of the extension can access the
  // globalState, workspaceState, and secrets without needing to pass the extension context around
  const manager = StorageManager.getInstance();
  // Handle any storage migrations that need to happen before the extension can proceed.
  await migrateStorageIfNeeded(manager);
  logger.info("Storage manager initialized and migrations completed");
  return context;
}

async function setupAuthProvider(): Promise<vscode.Disposable[]> {
  const disposables: vscode.Disposable[] = [];

  const provider: ConfluentCloudAuthProvider = getAuthProvider();
  const providerDisposable = vscode.authentication.registerAuthenticationProvider(
    AUTH_PROVIDER_ID,
    AUTH_PROVIDER_LABEL,
    provider,
    {
      supportsMultipleAccounts: false, // this is the default, but just to be explicit
    },
  );

  const uriHandlerDisposable = vscode.window.registerUriHandler(getUriHandler());
  disposables.push(providerDisposable, uriHandlerDisposable);

  // set the initial connection states of our main views; these will be adjusted by the following:
  // - ccloudConnectionAvailable: `true/false` if the auth provider has a valid CCloud connection
  // - localKafkaClusterAvailable: `true/false` if the Resources view loads/refreshes and can find a
  //   local Kafka cluster (and CCloud connection changes will refresh the Resources view via the
  //   `ccloudConnected` event emitter)
  await Promise.all([
    vscode.commands.executeCommand("setContext", "confluent.ccloudConnectionAvailable", false),
    vscode.commands.executeCommand("setContext", "confluent.localKafkaClusterAvailable", false),
  ]);

  // attempt to get a session to trigger the initial auth badge for signing in
  await getAuthSession();

  return disposables;
}

function setupViewProviders(context: vscode.ExtensionContext): vscode.ExtensionContext {
  logger.info("Creating view providers...");

  try {
    const resourceViewProvider = ResourceViewProvider.getInstance();
    context.subscriptions.push(
      registerCommandWithLogging("confluent.resources.refresh", () => {
        resourceViewProvider.refresh();
      }),
    );
    logger.info("Resource view provider created");
  } catch (e) {
    logger.error("Error creating Resource view provider", e);
  }

  try {
    const topicViewProvider = TopicViewProvider.getInstance();
    context.subscriptions.push(
      registerCommandWithLogging("confluent.topics.refresh", () => {
        // Force a deep refresh from sidecar.
        topicViewProvider.refresh(true);
      }),
    );
    logger.info("Topics view provider created");
  } catch (e) {
    logger.error("Error creating Topics view provider", e);
  }

  try {
    const schemasViewProvider = SchemasViewProvider.getInstance();
    context.subscriptions.push(
      registerCommandWithLogging("confluent.schemas.refresh", () => {
        schemasViewProvider.refresh();
      }),
    );
    logger.info("Schemas view provider created");
  } catch (e) {
    logger.error("Error creating Schemas view provider", e);
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const supportViewProvider = new SupportViewProvider();
    logger.info("Support view provider created");
  } catch (e) {
    logger.error("Error creating Support view provider", e);
  }

  return context;
}

/**
 * This function is just for making sure the commands are disposed of properly when the extension is
 * deactivated. {@link registerCommandWithLogging()} is already handling the command registration to VSCode.
 */
function setupCommands(context: vscode.ExtensionContext): vscode.ExtensionContext {
  logger.info("Storing main command disposables...");
  context.subscriptions.push(
    ...connectionCommands,
    ...organizationCommands,
    ...kafkaClusterCommands,
    ...environmentCommands,
    ...schemaRegistryCommands,
    ...schemaCommands,
    ...supportCommands,
    ...topicCommands,
    ...diffCommands,
    ...extraCommands,
  );
  logger.info("Main command disposables stored");
  return context;
}

async function setupDocumentProviders(
  context: vscode.ExtensionContext,
): Promise<vscode.ExtensionContext> {
  try {
    const providerClasses = [SchemaDocumentProvider];
    for (const providerClass of providerClasses) {
      const provider = new providerClass();
      context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(provider.scheme, provider),
      );
    }
    logger.info("Schema viewer registered");
  } catch (e) {
    logger.error("Error registering schema viewer", e);
  }
  return context;
}

// This method is called when your extension is deactivated or when VSCode is shutting down
export function deactivate() {
  getTelemetryLogger().dispose();
}
