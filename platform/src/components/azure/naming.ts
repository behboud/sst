import { createHash } from "node:crypto";
import { VisibleError } from "../error.js";

const ROLE_ASSIGNMENT_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

function clean(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Create a globally unique, ACR-valid name without adopting a colliding registry. */
export function acrResourceName(input: {
  app: string;
  stage: string;
  resourceGroupName: string;
  subscriptionId: string;
}) {
  const stem = clean(`${input.app}${input.stage}`).slice(0, 20) || "sst";
  const hash = createHash("sha256")
    .update(
      `${input.subscriptionId.toLowerCase()}|${input.resourceGroupName.toLowerCase()}|${
        input.app
      }|${input.stage}`,
    )
    .digest("hex")
    .slice(0, 20);
  const name = `${stem}${hash}`;
  if (!/^[a-z0-9]{5,50}$/.test(name)) {
    throw new VisibleError(
      `Generated invalid Azure Container Registry name "${name}".`,
    );
  }
  return name;
}

/** Stable UUIDv5 suitable for Azure roleAssignmentName fields. */
export function managedEnvironmentName(input: {
  app: string;
  stage: string;
  resourceGroupName: string;
  subscriptionId: string;
}) {
  const stem = clean(`${input.app}${input.stage}`).slice(0, 36) || "sst";
  const hash = createHash("sha256")
    .update(
      `${input.subscriptionId.toLowerCase()}|${input.resourceGroupName.toLowerCase()}|${
        input.app
      }|${input.stage}`,
    )
    .digest("hex")
    .slice(0, 16);
  return `sst${stem}${hash}`;
}

export function containerAppName(input: {
  app: string;
  stage: string;
  service: string;
}) {
  const stem =
    clean(`${input.app}${input.stage}${input.service}`).slice(0, 21) ||
    "service";
  const hash = createHash("sha256")
    .update(`${input.app}|${input.stage}|${input.service}`)
    .digest("hex")
    .slice(0, 8);
  return `${stem}-${hash}`;
}

export function userAssignedIdentityName(input: {
  app: string;
  stage: string;
  service: string;
}) {
  const stem =
    clean(`${input.app}-${input.stage}-${input.service}`).slice(0, 36) ||
    "service";
  const hash = createHash("sha256")
    .update(`${input.app}|${input.stage}|${input.service}`)
    .digest("hex")
    .slice(0, 12);
  return `sst-${stem}-${hash}`;
}

export function roleAssignmentGuid(input: {
  principalId: string;
  scope: string;
  roleDefinitionId: string;
}) {
  const namespace = Buffer.from(
    ROLE_ASSIGNMENT_NAMESPACE.replaceAll("-", ""),
    "hex",
  );
  const name = [
    input.principalId.trim().toLowerCase(),
    input.scope.trim().replace(/\/+$/, "").toLowerCase(),
    input.roleDefinitionId.trim().toLowerCase(),
  ].join("|");
  const digest = createHash("sha1")
    .update(Buffer.concat([namespace, Buffer.from(name)]))
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function parseRegistryResourceId(id: string) {
  const match = id.match(
    /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.ContainerRegistry\/registries\/([^/]+)\/?$/i,
  );
  if (!match) {
    throw new VisibleError(
      `Invalid Azure Container Registry resource ID "${id}". Expected a registry ID scoped to a resource group.`,
    );
  }
  return {
    subscriptionId: match[1],
    resourceGroupName: match[2],
    registryName: match[3],
  };
}
