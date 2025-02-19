import * as vscode from "vscode";
import { registerCommandWithLogging } from ".";
import { ConnectionsResourceApi } from "../clients/sidecar";
import { CCLOUD_CONNECTION_ID, CCLOUD_CONNECTION_SPEC } from "../constants";
import { ccloudOrganizationChanged } from "../emitters";
import { getCurrentOrganization } from "../graphql/organizations";
import { CCloudOrganization } from "../models/organization";
import { organizationQuickPick } from "../quickpicks/organizations";
import { getSidecar } from "../sidecar";
import { clearCurrentCCloudResources, getCCloudConnection } from "../sidecar/connections";

async function useOrganizationCommand() {
  if (!(await getCCloudConnection())) {
    return;
  }
  const organization: CCloudOrganization | undefined = await organizationQuickPick();
  if (!organization) {
    return;
  }
  const currentOrg = await getCurrentOrganization();
  if (currentOrg && currentOrg.id === organization.id) {
    // no change needed
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Setting "${organization.name}" as the current organization...`,
      cancellable: true,
    },
    async () => {
      const client: ConnectionsResourceApi = (await getSidecar()).getConnectionsResourceApi();
      await client.gatewayV1ConnectionsIdPut({
        id: CCLOUD_CONNECTION_ID,
        ConnectionSpec: {
          ...CCLOUD_CONNECTION_SPEC,
          ccloud_config: {
            organization_id: organization.id,
          },
        },
      });

      await clearCurrentCCloudResources();

      ccloudOrganizationChanged.fire();
    },
  );
}

export const commands = [
  registerCommandWithLogging("confluent.organizations.use", useOrganizationCommand),
];
