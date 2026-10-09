import { Input } from "../input.js";
import { Linkable } from "../linkable.js";
import { VisibleError } from "../error.js";

export const BLOB_DATA_READER_ROLE_ID = "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1";
export const BLOB_DATA_CONTRIBUTOR_ROLE_ID =
  "ba92f5b4-2d11-453d-a403-e96b0029c9fe";

const BLOB_ROLES = new Set([
  BLOB_DATA_READER_ROLE_ID,
  BLOB_DATA_CONTRIBUTOR_ROLE_ID,
]);

export interface AzurePermission {
  type: "azure.permission";
  scope: Input<string>;
  roleDefinitionId: string;
}

export function permission(input: {
  scope: Input<string>;
  roleDefinitionId: string;
}): AzurePermission {
  const roleDefinitionId = input.roleDefinitionId
    .trim()
    .replace(/\/+$/, "")
    .split("/")
    .at(-1)!
    .toLowerCase();
  if (!BLOB_ROLES.has(roleDefinitionId)) {
    throw new VisibleError(
      `Azure Service links only support Storage Blob Data Reader and Storage Blob Data Contributor in v1; role "${input.roleDefinitionId}" is not allowed.`,
    );
  }
  return {
    type: "azure.permission",
    scope: input.scope,
    roleDefinitionId: `/providers/Microsoft.Authorization/roleDefinitions/${roleDefinitionId}`,
  };
}

export function blob(
  name: string,
  args: {
    accountUrl: Input<string>;
    containerName: Input<string>;
    containerId: Input<string>;
    access: "read" | "readWrite";
  },
) {
  if (args.access !== "read" && args.access !== "readWrite") {
    throw new VisibleError(
      'Azure Blob link access must be "read" or "readWrite".',
    );
  }
  return new Linkable(name, {
    properties: {
      accountUrl: args.accountUrl,
      containerName: args.containerName,
    },
    include: [
      permission({
        scope: args.containerId,
        roleDefinitionId:
          args.access === "read"
            ? BLOB_DATA_READER_ROLE_ID
            : BLOB_DATA_CONTRIBUTOR_ROLE_ID,
      }),
    ],
  });
}
