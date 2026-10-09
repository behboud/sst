import { execFileSync } from "node:child_process";

export const REQUIRED_PROVIDERS = [
  "Microsoft.App",
  "Microsoft.ContainerRegistry",
  "Microsoft.ManagedIdentity",
  "Microsoft.Authorization",
  "Microsoft.Storage",
];

// This covers create/update and scoped role-assignment work for the fresh v1
// deployment. Delete actions are intentionally absent: this example must not
// remove resources from its shared Resource Group.
export const REQUIRED_ACTIONS = [
  "Microsoft.Resources/subscriptions/resourceGroups/read",
  "Microsoft.App/managedEnvironments/write",
  "Microsoft.App/managedEnvironments/join/action",
  "Microsoft.App/containerApps/write",
  "Microsoft.ContainerRegistry/registries/write",
  "Microsoft.ManagedIdentity/userAssignedIdentities/write",
  "Microsoft.ManagedIdentity/userAssignedIdentities/assign/action",
  "Microsoft.Authorization/roleDefinitions/read",
  "Microsoft.Authorization/roleAssignments/read",
  "Microsoft.Authorization/roleAssignments/write",
  "Microsoft.Storage/storageAccounts/write",
  "Microsoft.Storage/storageAccounts/blobServices/containers/write",
];

function matchesAction(pattern, action) {
  const escaped = pattern
    .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "i").test(action);
}

export function isActionGranted(permissionBlocks, action) {
  return permissionBlocks.some((permission) => {
    const included = (permission.actions ?? []).some((pattern) =>
      matchesAction(pattern, action),
    );
    const excluded = (permission.notActions ?? []).some((pattern) =>
      matchesAction(pattern, action),
    );
    return included && !excluded;
  });
}

export function missingActions(
  permissionBlocks,
  requiredActions = REQUIRED_ACTIONS,
) {
  return requiredActions.filter(
    (action) => !isActionGranted(permissionBlocks, action),
  );
}

function az(args) {
  const command = args[0] ?? "<unknown>";
  try {
    return execFileSync("az", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }).trim();
  } catch (error) {
    const timedOut = error?.killed || error?.code === "ETIMEDOUT";
    const reason = timedOut
      ? "timed out after 30 seconds"
      : `exit ${error?.status ?? "unknown"}`;
    throw new Error(`Azure CLI command '${command}' failed (${reason}).`);
  }
}

function azJson(args) {
  const result = az([...args, "--output", "json"]);
  try {
    return JSON.parse(result);
  } catch {
    throw new Error(`Azure CLI command '${args[0]}' returned invalid JSON.`);
  }
}

function requireEnvironment() {
  const values = {
    AZURE_RESOURCE_GROUP: process.env.AZURE_RESOURCE_GROUP,
    SST_AZURE_APPROVED_SUBSCRIPTION_ID:
      process.env.SST_AZURE_APPROVED_SUBSCRIPTION_ID,
    SST_AZURE_APPROVED_TENANT_ID: process.env.SST_AZURE_APPROVED_TENANT_ID,
    SST_AZURE_APPROVED_PRINCIPAL_ID:
      process.env.SST_AZURE_APPROVED_PRINCIPAL_ID,
  };
  const missing = Object.entries(values)
    .filter(([, value]) => !value?.trim())
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(
      `Set the approved preflight values: ${missing.join(", ")}.`,
    );
  }
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, value.trim()]),
  );
}

function checkIdentity(expected) {
  const account = azJson([
    "account",
    "show",
    "--query",
    "{subscriptionId:id,tenantId:tenantId,userType:user.type}",
  ]);
  const principalId = az([
    "ad",
    "signed-in-user",
    "show",
    "--query",
    "id",
    "--output",
    "tsv",
  ]);
  const mismatches = [];
  if (
    account.subscriptionId?.toLowerCase() !==
    expected.SST_AZURE_APPROVED_SUBSCRIPTION_ID.toLowerCase()
  ) {
    mismatches.push(
      "active subscription does not match the approved subscription",
    );
  }
  if (
    account.tenantId?.toLowerCase() !==
    expected.SST_AZURE_APPROVED_TENANT_ID.toLowerCase()
  ) {
    mismatches.push("active tenant does not match the approved tenant");
  }
  if (
    principalId.toLowerCase() !==
    expected.SST_AZURE_APPROVED_PRINCIPAL_ID.toLowerCase()
  ) {
    mismatches.push("signed-in user does not match the approved principal");
  }
  if (account.userType !== "user") {
    mismatches.push(
      "the Azure Native example requires an interactive user principal",
    );
  }
  if (mismatches.length) {
    throw new Error(`Identity check failed: ${mismatches.join("; ")}.`);
  }
}

function checkResourceGroup(expected) {
  const group = azJson([
    "group",
    "show",
    "--name",
    expected.AZURE_RESOURCE_GROUP,
    "--query",
    "{id:id,name:name,location:location}",
  ]);
  const expectedPrefix = `/subscriptions/${expected.SST_AZURE_APPROVED_SUBSCRIPTION_ID}/resourcegroups/${expected.AZURE_RESOURCE_GROUP}`;
  if (
    group.name?.toLowerCase() !== expected.AZURE_RESOURCE_GROUP.toLowerCase() ||
    !group.id?.toLowerCase().startsWith(expectedPrefix.toLowerCase())
  ) {
    throw new Error(
      "The target Resource Group is outside the approved subscription.",
    );
  }
  return group;
}

function checkProviders() {
  const results = REQUIRED_PROVIDERS.map((namespace) => ({
    namespace,
    state: az([
      "provider",
      "show",
      "--namespace",
      namespace,
      "--query",
      "registrationState",
      "--output",
      "tsv",
    ]),
  }));
  return results.filter((provider) => provider.state !== "Registered");
}

function checkEffectivePermissions(subscriptionId, resourceGroup) {
  const url =
    `https://management.azure.com/subscriptions/${subscriptionId}` +
    `/resourceGroups/${encodeURIComponent(resourceGroup)}` +
    "/providers/Microsoft.Authorization/permissions?api-version=2022-04-01";
  const permissions = [];
  let page = azJson(["rest", "--method", "get", "--url", url]);
  permissions.push(...(page.value ?? []));
  while (page.nextLink) {
    page = azJson(["rest", "--method", "get", "--url", page.nextLink]);
    permissions.push(...(page.value ?? []));
  }
  return permissions;
}

export function runPreflight() {
  const expected = requireEnvironment();
  checkIdentity(expected);
  const group = checkResourceGroup(expected);
  const unregistered = checkProviders();
  const permissionBlocks = checkEffectivePermissions(
    expected.SST_AZURE_APPROVED_SUBSCRIPTION_ID,
    expected.AZURE_RESOURCE_GROUP,
  );
  const missing = missingActions(permissionBlocks);

  console.log(
    `Read-only Azure preflight: ${group.name} (${group.location}); active account and expected identity match.`,
  );
  if (unregistered.length) {
    console.error(
      `Unregistered resource providers: ${unregistered
        .map(({ namespace, state }) => `${namespace}=${state || "unknown"}`)
        .join(
          ", ",
        )}. Register them through an administrator; preflight will not register providers.`,
    );
  } else {
    console.log(
      `Required resource providers are registered (${REQUIRED_PROVIDERS.length}).`,
    );
  }

  if (missing.length) {
    console.error(
      "Missing effective Azure actions at the Resource Group scope:",
    );
    for (const action of missing) console.error(`  - ${action}`);
  } else {
    console.log(
      `Required effective Azure actions are present (${REQUIRED_ACTIONS.length}).`,
    );
  }

  console.log(
    "This is a fail-closed prerequisite check, not a deployment preview. It cannot prove role-assignment conditions, deny assignments, policy, quota, capacity, or runtime data-plane access. It performs no Azure writes and does not test deletion permissions.",
  );
  if (unregistered.length || missing.length) {
    throw new Error(
      "Azure preflight blocked; no deployment or sst dev was run.",
    );
  }
}

if (import.meta.main) {
  try {
    runPreflight();
    console.log("Azure preflight passed.");
  } catch (error) {
    console.error(`Azure preflight failed: ${error.message}`);
    process.exitCode = 1;
  }
}
