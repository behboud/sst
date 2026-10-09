import {
  ComponentResourceOptions,
  Input,
  Output,
  Resource,
  all,
} from "@pulumi/pulumi";
import * as authorization from "@pulumi/azure-native/authorization/index.js";
import * as managedidentity from "@pulumi/azure-native/managedidentity/index.js";
import * as resources from "@pulumi/azure-native/resources/index.js";
import { Component } from "../component.js";
import { Link } from "../link.js";
import { VisibleError } from "../error.js";
import { RegistryHandle } from "./registry.js";
import {
  AzurePermission,
  BLOB_DATA_CONTRIBUTOR_ROLE_ID,
  BLOB_DATA_READER_ROLE_ID,
} from "./link.js";
import { roleAssignmentGuid, userAssignedIdentityName } from "./naming.js";

export const ACR_PULL_ROLE_ID =
  "/providers/Microsoft.Authorization/roleDefinitions/7f951dda-4ed3-4680-a7ca-43fe172d538d";

export interface ServiceIdentity {
  readonly resource: managedidentity.UserAssignedIdentity;
  readonly id: Output<string>;
  readonly clientId: Output<string>;
  readonly principalId: Output<string>;
  readonly grants: authorization.RoleAssignment[];
  /** Resources every Container App must depend on before it can become ready. */
  readonly dependencies: Resource[];
}

export interface IdentityRequest {
  parent: Component;
  name: string;
  app: string;
  stage: string;
  resourceGroupName: Input<string>;
  location?: Input<string>;
  opts?: ComponentResourceOptions;
  registry?: RegistryHandle;
  link?: Input<Link.Linkable[]>;
}

function canonicalScope(scope: string) {
  return scope.trim().replace(/\/+$/, "").toLowerCase();
}

export function validateAzurePermissionScope(input: {
  scope: string;
  resourceGroupName: string;
  subscriptionId: string;
}) {
  const scope = input.scope.trim().replace(/\/+$/, "");
  const prefix = `/subscriptions/${input.subscriptionId}/resourcegroups/${input.resourceGroupName}/providers/`;
  if (
    !scope.toLowerCase().startsWith(prefix.toLowerCase()) ||
    scope.slice(prefix.length).split("/").filter(Boolean).length < 2
  ) {
    throw new VisibleError(
      `Azure permission scope "${input.scope}" must be a resource ID inside approved resource group "${input.resourceGroupName}" and subscription "${input.subscriptionId}".`,
    );
  }
  return scope;
}

function collectPermissions(links?: Input<Link.Linkable[]>): AzurePermission[] {
  if (links === undefined) return [];
  if (!Array.isArray(links)) {
    throw new VisibleError(
      'Azure Service "link" must be a literal array so role assignments can be planned and reviewed.',
    );
  }

  const permissions: AzurePermission[] = [];
  const seenStrings = new Set<string>();
  const seenOutputs = new WeakMap<object, Set<string>>();
  for (const link of links) {
    if (!link) {
      throw new VisibleError(
        "An undefined link was passed into an Azure Service.",
      );
    }
    if (!Link.isLinkable(link)) continue;
    const includes = link.getSSTLink().include ?? [];
    for (const include of includes) {
      if (include.type !== "azure.permission") continue;
      const permission = include as AzurePermission;
      const role = permission.roleDefinitionId
        .trim()
        .replace(/\/+$/, "")
        .split("/")
        .at(-1)!
        .toLowerCase();
      if (
        role !== BLOB_DATA_READER_ROLE_ID &&
        role !== BLOB_DATA_CONTRIBUTOR_ROLE_ID
      ) {
        throw new VisibleError(
          `Azure Service links only support Storage Blob Data Reader and Storage Blob Data Contributor in v1; role "${permission.roleDefinitionId}" is not allowed.`,
        );
      }
      if (typeof permission.scope === "string") {
        const key = `${canonicalScope(permission.scope)}|${role}`;
        if (seenStrings.has(key)) continue;
        seenStrings.add(key);
      } else if (permission.scope && typeof permission.scope === "object") {
        const keys = seenOutputs.get(permission.scope) ?? new Set<string>();
        if (keys.has(role)) continue;
        keys.add(role);
        seenOutputs.set(permission.scope, keys);
      }
      permissions.push({
        ...permission,
        roleDefinitionId: `/providers/Microsoft.Authorization/roleDefinitions/${role}`,
      });
    }
  }
  return permissions;
}

function roleAssignmentOptions(
  request: IdentityRequest,
  dependsOn: managedidentity.UserAssignedIdentity[],
): ComponentResourceOptions {
  return {
    parent: request.parent,
    dependsOn,
    protect: request.opts?.protect,
    retainOnDelete: request.opts?.retainOnDelete ?? false,
  };
}

function createRoleAssignment(
  request: IdentityRequest,
  identity: managedidentity.UserAssignedIdentity,
  input: {
    scope: Input<string>;
    roleDefinitionId: string;
    logicalName: string;
    description: string;
    subscriptionId: Output<string>;
  },
) {
  const scope = all([
    input.scope,
    request.resourceGroupName,
    input.subscriptionId,
  ]).apply(([scope, resourceGroupName, subscriptionId]) =>
    validateAzurePermissionScope({
      scope,
      resourceGroupName,
      subscriptionId,
    }),
  );
  const roleAssignmentName = all([identity.principalId, scope]).apply(
    ([principalId, scope]) =>
      roleAssignmentGuid({
        principalId,
        scope,
        roleDefinitionId: input.roleDefinitionId,
      }),
  );
  const expectedDescription = input.description.slice(0, 240);
  const checkedName = all([
    roleAssignmentName,
    scope,
    identity.principalId,
  ]).apply(async ([name, scope, principalId]) => {
    try {
      const existing = await authorization.getRoleAssignment(
        { roleAssignmentName: name, scope },
        { parent: request.parent },
      );
      if (!existing.id) return name;
      if (
        existing.name.toLowerCase() === name.toLowerCase() &&
        canonicalScope(existing.scope) === canonicalScope(scope) &&
        existing.principalId.toLowerCase() === principalId.toLowerCase() &&
        existing.roleDefinitionId
          .toLowerCase()
          .endsWith(input.roleDefinitionId.split("/").at(-1)!.toLowerCase()) &&
        existing.description === expectedDescription
      ) {
        return name;
      }
      throw new VisibleError(
        `Azure role assignment ${name} already exists at "${scope}" but is not owned by this SST Service. Resolve the conflict manually; SST will not adopt or delete it.`,
      );
    } catch (error) {
      if (error instanceof VisibleError) throw error;
      const message = `${String(
        (error as { code?: unknown })?.code ?? "",
      )} ${String((error as Error)?.message ?? error)}`;
      if (
        /404|RoleAssignmentNotFound|ResourceNotFound|not found/i.test(message)
      ) {
        return name;
      }
      const reason = message.replace(/\s+/g, " ").slice(0, 240);
      throw new VisibleError(
        `Unable to verify Azure role assignment ${name} at "${scope}" (${reason}). Refusing to risk changing a pre-existing assignment.`,
      );
    }
  });

  return new authorization.RoleAssignment(
    input.logicalName,
    {
      roleAssignmentName: checkedName,
      principalId: identity.principalId,
      principalType: "ServicePrincipal",
      roleDefinitionId: input.roleDefinitionId,
      scope,
      description: expectedDescription,
    },
    roleAssignmentOptions(request, [identity]),
  );
}

export function createServiceIdentity(
  request: IdentityRequest,
): ServiceIdentity {
  const group = resources.getResourceGroupOutput(
    { resourceGroupName: request.resourceGroupName },
    { parent: request.parent },
  );
  const identity = new managedidentity.UserAssignedIdentity(
    `${request.name}Identity`,
    {
      resourceGroupName: request.resourceGroupName,
      location: request.location ?? group.location,
      resourceName: userAssignedIdentityName({
        app: request.app,
        stage: request.stage,
        service: request.name,
      }),
      tags: {
        "sst:app": request.app,
        "sst:stage": request.stage,
        "sst:service": request.name,
      },
    },
    {
      parent: request.parent,
      protect: request.opts?.protect,
      retainOnDelete: request.opts?.retainOnDelete,
    },
  );
  const client = authorization.getClientConfigOutput({
    parent: request.parent,
  });
  const grants: authorization.RoleAssignment[] = [];

  if (request.registry) {
    grants.push(
      createRoleAssignment(request, identity, {
        scope: request.registry.id,
        roleDefinitionId: ACR_PULL_ROLE_ID,
        logicalName: `${request.name}AcrPull`,
        description: `sst:azure.Service ${request.app}/${request.stage}/${request.name} ACR pull`,
        subscriptionId: client.subscriptionId,
      }),
    );
  }

  const permissions = collectPermissions(request.link);
  permissions.forEach((permission, index) => {
    grants.push(
      createRoleAssignment(request, identity, {
        scope: permission.scope,
        roleDefinitionId: permission.roleDefinitionId,
        logicalName: `${request.name}Permission${index + 1}`,
        description: `sst:azure.Service ${request.app}/${request.stage}/${request.name} linked data access`,
        subscriptionId: client.subscriptionId,
      }),
    );
  });

  return {
    resource: identity,
    id: identity.id,
    clientId: identity.clientId,
    principalId: identity.principalId,
    grants,
    dependencies: [identity, ...grants],
  };
}
