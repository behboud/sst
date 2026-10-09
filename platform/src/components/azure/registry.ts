import {
  ComponentResourceOptions,
  Input,
  Output,
  ProviderResource,
  all,
  output,
  runtime,
  secret,
} from "@pulumi/pulumi";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as authorization from "@pulumi/azure-native/authorization/index.js";
import * as containerregistry from "@pulumi/azure-native/containerregistry/index.js";
import * as resources from "@pulumi/azure-native/resources/index.js";
import * as dockerBuild from "@pulumi/docker-build";
import { ComponentResource } from "@pulumi/pulumi";
import { ImageArgs as DockerBuildImageArgs } from "@pulumi/docker-build";
import { imageBuilder } from "../aws/helpers/container-builder.js";
import { Transform, transform } from "../component.js";
import { NormalizedContainer, NormalizedImage } from "./validation.js";
import { Component } from "../component.js";
import { VisibleError } from "../error.js";
import {
  acrResourceName,
  parseRegistryResourceId,
  roleAssignmentGuid,
} from "./naming.js";

const ACR_PUSH_ROLE_ID =
  "/providers/Microsoft.Authorization/roleDefinitions/8311e382-0749-4cb8-b61a-304f252e45ec";

export interface RegistryRequest {
  app: string;
  stage: string;
  resourceGroupName: Input<string>;
  location?: Input<string>;
  opts?: ComponentResourceOptions;
}

export interface RegistryHandle {
  readonly id: Output<string>;
  readonly name: Output<string>;
  readonly loginServer: Output<string>;
  readonly resourceGroupName: Output<string>;
  readonly location: Output<string>;
  readonly owned: boolean;
  readonly publisherObjectId: Output<string>;
  readonly tenantId: Output<string>;
  readonly subscriptionId: Output<string>;
  /** Resolves only after the stack's services agree on the shared registry scope. */
  readonly validation: Output<void>;
  readonly root?: Component;
  readonly registry?: containerregistry.Registry;
  readonly publisherGrant?: authorization.RoleAssignment;
}

const shared = new Map<
  string,
  RegistryHandle & { provider?: ProviderResource }
>();

/** Images are build inputs when they are objects or omitted; literal strings are prebuilt refs. */
export function serviceNeedsRegistry(args: {
  image?: unknown;
  containers?: unknown;
}) {
  const containers = args.containers;
  if (containers !== undefined && !Array.isArray(containers)) return false;
  const images = containers
    ? containers.flatMap((container: any) =>
        !container ||
        typeof container !== "object" ||
        "apply" in container ||
        "then" in container
          ? []
          : [container.image],
      )
    : [args.image];
  return images.some((image) => {
    if (image === undefined) return true;
    if (typeof image === "string") return false;
    if (
      image &&
      typeof image === "object" &&
      ("apply" in image || "then" in image)
    ) {
      return false;
    }
    if (!image || typeof image !== "object" || Array.isArray(image)) {
      throw new VisibleError(
        "Azure Service image must be a string or Docker settings object.",
      );
    }
    return true;
  });
}

export function resolveAzureProvider(opts?: ComponentResourceOptions) {
  if (opts?.provider) return opts.provider;
  if (!opts?.providers) return undefined;
  if (Array.isArray(opts.providers)) {
    return opts.providers.find(
      (provider) =>
        (provider as unknown as { __pulumiType?: string }).__pulumiType ===
        "pulumi:providers:azure-native",
    );
  }
  return (opts.providers as Record<string, ProviderResource>)["azure-native"];
}

class RegistryRoot extends Component {
  constructor(provider?: ProviderResource) {
    super(
      "sst:azure:Registry",
      "AzureRegistry",
      {},
      {
        ...(provider ? { provider } : {}),
      },
    );
  }

  complete(registryId: Output<string>) {
    this.registerOutputs({ registry: registryId });
  }
}

function childResourceOptions(
  parent: Component,
  provider?: ProviderResource,
  extras: Partial<ComponentResourceOptions> = {},
): ComponentResourceOptions {
  return {
    parent,
    ...(provider ? { provider } : {}),
    ...extras,
  };
}

function canonicalId(id: string) {
  return id.trim().replace(/\/+$/, "").toLowerCase();
}

function armAuthenticationStatus(policies: Record<string, any> | undefined) {
  return (
    policies?.azureADAuthenticationAsArmPolicy ??
    policies?.azureAdAuthenticationAsArmPolicy
  )?.status;
}

function assertSameScope(
  id: string,
  resourceGroupName: string,
  subscriptionId: string,
) {
  const parsed = parseRegistryResourceId(id);
  if (parsed.subscriptionId.toLowerCase() !== subscriptionId.toLowerCase()) {
    throw new VisibleError(
      `Borrowed Azure Container Registry subscription ${parsed.subscriptionId} does not match the configured Azure provider subscription ${subscriptionId}.`,
    );
  }
  if (
    parsed.resourceGroupName.toLowerCase() !== resourceGroupName.toLowerCase()
  ) {
    throw new VisibleError(
      `Borrowed Azure Container Registry must be in the Service resource group "${resourceGroupName}"; found "${parsed.resourceGroupName}".`,
    );
  }
}

/**
 * Validate borrowed registry settings that are exposed by the pinned Azure Native SDK.
 * roleAssignmentMode is not present in this SDK's generated Registry schema; the ACR CLI
 * token path also verifies it before obtaining a build credential.
 */
export function validateBorrowedRegistry(input: {
  id: string;
  resourceGroupName: string;
  subscriptionId: string;
  metadata: Record<string, any>;
}) {
  assertSameScope(input.id, input.resourceGroupName, input.subscriptionId);
  if (canonicalId(input.metadata.id ?? "") !== canonicalId(input.id)) {
    throw new VisibleError(
      `Borrowed ACR lookup returned a different resource ID than requested (${input.id}).`,
    );
  }
  if (input.metadata.adminUserEnabled !== false) {
    throw new VisibleError(
      `Borrowed ACR "${input.metadata.name}" must have admin authentication disabled; SST will not change registry authentication policy.`,
    );
  }
  const armStatus = armAuthenticationStatus(input.metadata.policies);
  if (String(armStatus).toLowerCase() !== "enabled") {
    throw new VisibleError(
      `Borrowed ACR "${input.metadata.name}" must have ARM-audience Azure AD authentication enabled; SST will not change registry policy.`,
    );
  }
  const mode = input.metadata.roleAssignmentMode;
  if (mode !== undefined && mode !== "LegacyRegistryPermissions") {
    throw new VisibleError(
      `Borrowed ACR "${input.metadata.name}" uses unsupported role-assignment mode "${mode}". V1 requires RBAC Registry Permissions; ABAC repository permissions are not supported.`,
    );
  }
}

export function borrowedRegistryPushPrerequisite(registryName: string) {
  return new VisibleError(
    `Cannot publish to borrowed ACR "${registryName}": the configured Azure CLI principal needs an existing registry-scoped AcrPush role assignment. SST never creates or modifies publisher grants on a borrowed registry.`,
  );
}

/**
 * Get the app/stage-owned publisher registry. The singleton root is deliberately independent
 * of any Service component so service declaration order/removal cannot transfer ownership.
 */
export function getSharedRegistry(request: RegistryRequest): RegistryHandle {
  const key = `${request.app.toLowerCase()}|${request.stage.toLowerCase()}`;
  const provider = resolveAzureProvider(request.opts);
  const current = shared.get(key);
  if (current) {
    if (current.provider !== provider) {
      throw new VisibleError(
        "All image-building Azure Services in an app stage must use the same Azure Native provider.",
      );
    }
    const validation = all([
      current.resourceGroupName,
      request.resourceGroupName,
    ]).apply(([existingGroup, requestedGroup]) => {
      if (existingGroup.toLowerCase() !== requestedGroup.toLowerCase()) {
        throw new VisibleError(
          `Azure Services sharing the stage registry must use one Resource Group; got "${existingGroup}" and "${requestedGroup}".`,
        );
      }
    });
    return {
      ...current,
      id: all([current.id, validation]).apply(([id]) => id),
      validation,
    };
  }

  const root = new RegistryRoot(provider);
  const invokeOptions = provider ? { provider } : undefined;
  const client = authorization.getClientConfigOutput(invokeOptions);
  const group = resources.getResourceGroupOutput(
    { resourceGroupName: request.resourceGroupName },
    invokeOptions,
  );
  const registryName = all([
    client.subscriptionId,
    request.resourceGroupName,
  ]).apply(([subscriptionId, resourceGroupName]) =>
    acrResourceName({
      app: request.app,
      stage: request.stage,
      resourceGroupName,
      subscriptionId,
    }),
  );

  const checkedRegistryName = all([
    registryName,
    request.resourceGroupName,
  ]).apply(async ([name, resourceGroupName]) => {
    try {
      const existing = await containerregistry.getRegistry(
        { registryName: name, resourceGroupName },
        invokeOptions,
      );
      if (!existing.id) return name;
      if (
        existing.tags?.["sst:app"]?.toLowerCase() ===
          request.app.toLowerCase() &&
        existing.tags?.["sst:stage"]?.toLowerCase() ===
          request.stage.toLowerCase() &&
        existing.tags?.["sst:owner"] === "sst.azure.Service"
      ) {
        return name;
      }
      throw new VisibleError(
        `Generated ACR name "${name}" is already occupied by a registry SST does not own. Choose another app/stage name; SST will not adopt or modify it.`,
      );
    } catch (error) {
      if (error instanceof VisibleError) throw error;
      const message = `${String(
        (error as { code?: unknown })?.code ?? "",
      )} ${String((error as Error)?.message ?? error)}`;
      if (/404|ResourceNotFound|RegistryNotFound|not found/i.test(message)) {
        return name;
      }
      throw new VisibleError(
        `Unable to verify that generated ACR name "${name}" is available. Refusing to risk changing a registry owned outside this SST stage.`,
      );
    }
  });

  const registry = new containerregistry.Registry(
    "AzureRegistry-ContainerRegistry",
    {
      registryName: checkedRegistryName,
      resourceGroupName: request.resourceGroupName,
      location: request.location ?? group.location,
      sku: { name: "Basic" },
      adminUserEnabled: false,
      anonymousPullEnabled: false,
      policies: {
        azureADAuthenticationAsArmPolicy: { status: "enabled" },
      },
      tags: {
        "sst:app": request.app,
        "sst:stage": request.stage,
        "sst:owner": "sst.azure.Service",
      },
    },
    childResourceOptions(root, provider, {
      protect: request.opts?.protect,
      retainOnDelete: request.opts?.retainOnDelete ?? true,
    }),
  );

  const assignmentName = all([client.objectId, registry.id]).apply(
    ([principalId, scope]) =>
      roleAssignmentGuid({
        principalId,
        scope,
        roleDefinitionId: ACR_PUSH_ROLE_ID,
      }),
  );
  const publisherGrant = new authorization.RoleAssignment(
    "AzureRegistry-PublisherPush",
    {
      roleAssignmentName: assignmentName,
      principalId: client.objectId,
      principalType: "User",
      roleDefinitionId: ACR_PUSH_ROLE_ID,
      scope: registry.id,
    },
    childResourceOptions(root, provider, {
      dependsOn: [registry],
      protect: request.opts?.protect,
      retainOnDelete: request.opts?.retainOnDelete ?? false,
    }),
  );

  const handle: RegistryHandle & { provider?: ProviderResource } = {
    id: registry.id,
    name: registry.name,
    loginServer: registry.loginServer,
    resourceGroupName: output(request.resourceGroupName),
    location: output(registry.location),
    owned: true,
    publisherObjectId: output(client.objectId),
    tenantId: output(client.tenantId),
    subscriptionId: output(client.subscriptionId),
    validation: output(undefined),
    root,
    registry,
    publisherGrant,
    provider,
  };
  root.complete(registry.id);
  shared.set(key, handle);
  return handle;
}

/** Read and validate, but never own or modify, a customer-provided ACR. */
export function getBorrowedRegistry(
  request: RegistryRequest & { id: Input<string> },
): RegistryHandle {
  const provider = resolveAzureProvider(request.opts);
  const invokeOptions = provider ? { provider } : undefined;
  const client = authorization.getClientConfigOutput(invokeOptions);
  const parsedId = output(request.id).apply(parseRegistryResourceId);
  const registry = containerregistry.getRegistryOutput(
    {
      registryName: parsedId.apply((id) => id.registryName),
      resourceGroupName: parsedId.apply((id) => id.resourceGroupName),
    },
    invokeOptions,
  );
  const validation = all([
    output(request.id),
    output(request.resourceGroupName),
    client,
    registry,
  ]).apply(([id, resourceGroupName, clientConfig, metadata]) => {
    validateBorrowedRegistry({
      id,
      resourceGroupName,
      subscriptionId: clientConfig.subscriptionId,
      metadata: metadata as unknown as Record<string, any>,
    });
  });
  return {
    id: all([registry.id, validation]).apply(([id]) => id),
    name: registry.name,
    loginServer: registry.loginServer,
    resourceGroupName: output(request.resourceGroupName),
    location: output(registry.location),
    owned: false,
    publisherObjectId: output(client.objectId),
    tenantId: output(client.tenantId),
    subscriptionId: output(client.subscriptionId),
    validation,
  };
}

export interface RegistryToken {
  username: string;
  password: string;
}

export interface RegistryTokenRequest {
  name: string;
  id: string;
  loginServer: string;
  resourceGroupName: string;
  principalId: string;
  tenantId: string;
  subscriptionId: string;
  owned: boolean;
}

export type RegistryTokenReader = (
  request: RegistryTokenRequest,
) => Promise<RegistryToken>;

function runAzureCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "az",
      args,
      { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 30_000 },
      (error, stdout) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          reject(
            new VisibleError(
              `Azure CLI az ${args[0]} failed${
                code ? ` (${code})` : ""
              }. Command output is suppressed to avoid exposing credentials.`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function requiredApprovedValue(name: string, actual: string) {
  const expected = process.env[name];
  if (!expected) {
    throw new VisibleError(
      `Image publishing is blocked until the approved Azure preflight identity is set in ${name}.`,
    );
  }
  if (expected.toLowerCase() !== actual.toLowerCase()) {
    throw new VisibleError(
      `Azure identity mismatch: ${name} does not match the configured provider and Azure CLI session.`,
    );
  }
}

function isAcrPush(roleDefinitionId: string) {
  return roleDefinitionId
    .toLowerCase()
    .endsWith("/8311e382-0749-4cb8-b61a-304f252e45ec");
}

function scopeMatchesRegistry(scope: string, registryId: string) {
  return canonicalId(scope) === canonicalId(registryId);
}

export function hasRegistryScopedAcrPush(
  assignments: Array<{ roleDefinitionId?: string; scope?: string }>,
  registryId: string,
) {
  return assignments.some(
    (assignment) =>
      assignment.roleDefinitionId &&
      assignment.scope &&
      isAcrPush(assignment.roleDefinitionId) &&
      scopeMatchesRegistry(assignment.scope, registryId),
  );
}

/** Obtain a fresh, short-lived ACR token from the approved Azure CLI identity. */
export const readAcrToken: RegistryTokenReader = async (request) => {
  requiredApprovedValue(
    "SST_AZURE_APPROVED_SUBSCRIPTION_ID",
    request.subscriptionId,
  );
  requiredApprovedValue("SST_AZURE_APPROVED_TENANT_ID", request.tenantId);
  requiredApprovedValue("SST_AZURE_APPROVED_PRINCIPAL_ID", request.principalId);

  let account: { id?: string; tenantId?: string; userType?: string };
  try {
    account = JSON.parse(
      await runAzureCli([
        "account",
        "show",
        "--query",
        "{id:id,tenantId:tenantId,userType:user.type}",
        "--output",
        "json",
      ]),
    );
  } catch (error) {
    if (error instanceof VisibleError) throw error;
    throw new VisibleError(
      "Unable to read the active Azure CLI account; run az login and retry.",
    );
  }
  if (
    account.id?.toLowerCase() !== request.subscriptionId.toLowerCase() ||
    account.tenantId?.toLowerCase() !== request.tenantId.toLowerCase() ||
    account.userType !== "user"
  ) {
    throw new VisibleError(
      "Azure CLI must be signed in as the approved interactive user in the same tenant and subscription as the Azure Native provider.",
    );
  }

  let cliPrincipalId: string;
  try {
    cliPrincipalId = (
      await runAzureCli([
        "ad",
        "signed-in-user",
        "show",
        "--query",
        "id",
        "--output",
        "tsv",
      ])
    ).trim();
  } catch (error) {
    if (error instanceof VisibleError) throw error;
    throw new VisibleError(
      "Unable to verify the signed-in Azure CLI user object ID. Directory read access is required before image publishing.",
    );
  }
  if (cliPrincipalId.toLowerCase() !== request.principalId.toLowerCase()) {
    throw new VisibleError(
      "Azure Native provider principal does not match the signed-in Azure CLI user. Refusing to publish with a different identity.",
    );
  }

  let registry: Record<string, any>;
  try {
    registry = JSON.parse(
      await runAzureCli([
        "acr",
        "show",
        "--name",
        request.name,
        "--resource-group",
        request.resourceGroupName,
        "--output",
        "json",
      ]),
    );
  } catch (error) {
    if (error instanceof VisibleError) throw error;
    throw new VisibleError(
      `Unable to read ACR "${request.name}". Confirm the registry exists in the approved resource group.`,
    );
  }
  if (canonicalId(registry.id ?? "") !== canonicalId(request.id)) {
    throw new VisibleError(
      `Azure CLI resolved ACR "${request.name}" to a different resource ID than the configured provider.`,
    );
  }
  if (registry.adminUserEnabled !== false) {
    throw new VisibleError(
      `ACR "${request.name}" must have admin authentication disabled; SST will not use admin credentials.`,
    );
  }
  if (registry.roleAssignmentMode !== "LegacyRegistryPermissions") {
    throw new VisibleError(
      `ACR "${request.name}" role-assignment mode is "${
        registry.roleAssignmentMode ?? "unknown"
      }". V1 requires RBAC Registry Permissions; ABAC repository permissions are unsupported.`,
    );
  }
  if (
    String(armAuthenticationStatus(registry.policies)).toLowerCase() !==
    "enabled"
  ) {
    throw new VisibleError(
      `ACR "${request.name}" must have ARM-audience Azure AD authentication enabled.`,
    );
  }

  if (!request.owned) {
    let assignments: Array<{ roleDefinitionId?: string; scope?: string }>;
    try {
      assignments = JSON.parse(
        await runAzureCli([
          "role",
          "assignment",
          "list",
          "--assignee",
          request.principalId,
          "--scope",
          request.id,
          "--include-inherited",
          "--all",
          "--output",
          "json",
        ]),
      );
    } catch (error) {
      if (error instanceof VisibleError) throw error;
      throw new VisibleError(
        `Unable to verify existing AcrPush access on borrowed ACR "${request.name}".`,
      );
    }
    if (!hasRegistryScopedAcrPush(assignments, request.id)) {
      throw borrowedRegistryPushPrerequisite(request.name);
    }
  }

  let token: { accessToken?: string; loginServer?: string };
  try {
    token = JSON.parse(
      await runAzureCli([
        "acr",
        "login",
        "--name",
        request.name,
        "--expose-token",
        "--output",
        "json",
      ]),
    );
  } catch (error) {
    if (error instanceof VisibleError) throw error;
    throw new VisibleError(
      `Could not obtain an ACR token for "${request.name}". Verify the approved publisher's AcrPush access and retry after RBAC propagation.`,
    );
  }
  if (
    !token.accessToken ||
    token.loginServer?.toLowerCase() !== request.loginServer.toLowerCase()
  ) {
    throw new VisibleError(
      `Azure CLI returned incomplete or mismatched registry credentials for "${request.name}".`,
    );
  }
  return {
    username: "00000000-0000-0000-0000-000000000000",
    password: token.accessToken,
  };
};

/** Return ephemeral Buildx credentials; previews never invoke the token reader. */
export function imageRegistryCredentials(
  registry: RegistryHandle,
  tokenReader: RegistryTokenReader = readAcrToken,
  isPreview = runtime.isDryRun(),
): Output<any[]> {
  if (isPreview) return output([] as any[]);
  return all([
    registry.publisherGrant?.id ?? output(""),
    registry.validation,
  ]).apply(() =>
    all([
      registry.name,
      registry.id,
      registry.loginServer,
      registry.resourceGroupName,
      registry.publisherObjectId,
      registry.tenantId,
      registry.subscriptionId,
    ]).apply(
      async ([
        name,
        id,
        loginServer,
        resourceGroupName,
        principalId,
        tenantId,
        subscriptionId,
      ]) => {
        const token = await tokenReader({
          name,
          id,
          loginServer,
          resourceGroupName,
          principalId,
          tenantId,
          subscriptionId,
          owned: registry.owned,
        });
        return [
          {
            address: loginServer,
            username: token.username,
            password: secret(token.password),
          },
        ];
      },
    ),
  );
}

export const REQUIRED_DOCKER_EXCLUSIONS = [
  ".sst",
  ".env*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.tfstate*",
  "Pulumi.*.yaml",
  "secrets/",
] as const;

function globMatches(pattern: string, value: string) {
  let regex = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      regex += ".*";
      index++;
    } else if (char === "*") {
      regex += "[^/]*";
    } else if (char === "?") {
      regex += "[^/]";
    } else {
      regex += char.replace(/[\\^$+?.()|{}[\]]/g, "\\$&");
    }
  }
  return new RegExp(`${regex}$`, "i").test(value);
}

function dockerIgnoreExcludes(lines: string[], candidate: string) {
  let excluded = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line === ".") continue;
    const negated = line.startsWith("!");
    const pattern = (negated ? line.slice(1) : line)
      .replace(/^\.\//, "")
      .replace(/^\/+|\/+$/g, "");
    const candidates = candidate.split("/");
    const matched =
      globMatches(pattern, candidate) ||
      candidates.some((_, index) => {
        const prefix = candidates.slice(0, index + 1).join("/");
        return globMatches(pattern, prefix);
      });
    if (matched) excluded = !negated;
  }
  return excluded;
}

export function resolveDockerContext(
  image: NormalizedImage,
  configRoot: string,
) {
  const contextPath = path.resolve(configRoot, image.context);
  if (!fs.existsSync(contextPath) || !fs.statSync(contextPath).isDirectory()) {
    throw new VisibleError(
      `Docker build context does not exist or is not a directory: ${contextPath}`,
    );
  }
  const dockerfilePath = path.resolve(contextPath, image.dockerfile);
  const relativeDockerfile = path.relative(contextPath, dockerfilePath);
  if (
    relativeDockerfile === ".." ||
    relativeDockerfile.startsWith(`..${path.sep}`)
  ) {
    throw new VisibleError(
      "Azure Service Dockerfile must be inside its configured build context.",
    );
  }
  if (!fs.existsSync(dockerfilePath) || !fs.statSync(dockerfilePath).isFile()) {
    throw new VisibleError(`Dockerfile not found: ${dockerfilePath}`);
  }

  const specificIgnore = `${dockerfilePath}.dockerignore`;
  const ignorePath = fs.existsSync(specificIgnore)
    ? specificIgnore
    : path.join(contextPath, ".dockerignore");
  const ignoreLines = fs.existsSync(ignorePath)
    ? fs.readFileSync(ignorePath, "utf8").split(/\r?\n/)
    : [];
  const sentinels = [
    ".sst/azure-build-marker",
    ".env",
    ".env.local",
    "private.pem",
    "private.key",
    "private.p12",
    "private.pfx",
    "terraform.tfstate",
    "Pulumi.dev.yaml",
    "secrets/credentials.json",
  ];
  const unsafe = sentinels.filter(
    (candidate) => !dockerIgnoreExcludes(ignoreLines, candidate),
  );
  if (unsafe.length) {
    throw new VisibleError(
      `Docker build context is missing required .dockerignore exclusions (${REQUIRED_DOCKER_EXCLUSIONS.join(
        ", ",
      )}). Add them to ${ignorePath} before building; SST will not modify it.`,
    );
  }
  return { contextPath, dockerfilePath, ignorePath };
}

export function buildKitSecrets(
  values: Input<Record<string, Input<string>>> | undefined,
) {
  return values ? secret(values) : undefined;
}

export interface ContainerImageBuild {
  parent: ComponentResource;
  serviceName: string;
  app: string;
  stage: string;
  container: NormalizedContainer;
  registry: RegistryHandle;
  tokenReader?: RegistryTokenReader;
  transform?: Transform<DockerBuildImageArgs>;
}

function repositorySegment(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "service"
  );
}

export function buildContainerImage(input: ContainerImageBuild) {
  if (typeof input.container.image === "string") {
    throw new VisibleError(
      "buildContainerImage only accepts Docker build settings, not image strings.",
    );
  }
  const image = input.container.image;
  const { contextPath, dockerfilePath } = resolveDockerContext(
    image,
    $cli.paths.root,
  );
  const repository = all([input.registry.loginServer, input.registry.id]).apply(
    ([loginServer]) =>
      `${loginServer}/sst/${repositorySegment(input.app)}/${repositorySegment(
        input.stage,
      )}/${repositorySegment(input.serviceName)}/${repositorySegment(
        input.container.name,
      )}`,
  );
  const tags = all([repository, image.tags ?? []]).apply(
    ([repo, extraTags]) => {
      const values = ["latest", ...extraTags];
      for (const tag of values) {
        if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) {
          throw new VisibleError(
            `Invalid Azure image tag "${tag}" for container "${input.container.name}". Supply only a tag suffix, not a registry/repository.`,
          );
        }
      }
      return [...new Set(values)].map((tag) => `${repo}:${tag}`);
    },
  );
  const childOpts: ComponentResourceOptions = {
    parent: input.parent,
    retainOnDelete: true,
    dependsOn: [
      ...(input.registry.registry ? [input.registry.registry] : []),
      ...(input.registry.publisherGrant ? [input.registry.publisherGrant] : []),
    ],
  };
  const resourceName = `${input.serviceName}Image${input.container.name}`;
  const imageArgs: DockerBuildImageArgs = {
    context: { location: contextPath },
    dockerfile: { location: dockerfilePath },
    buildArgs: image.args,
    secrets: buildKitSecrets(image.secrets),
    target: image.target,
    platforms: [dockerBuild.Platform.Linux_amd64],
    tags,
    registries: imageRegistryCredentials(input.registry, input.tokenReader),
    noCache: image.cache === false ? true : undefined,
    push: true,
    buildOnPreview: false,
  };
  const [transformedName, transformedArgs, transformedOpts] = transform(
    input.transform,
    resourceName,
    imageArgs,
    childOpts,
  );
  const resource = imageBuilder(
    transformedName,
    transformedArgs,
    transformedOpts,
  );
  const ref = resource.apply((built) =>
    all([repository, built.digest]).apply(
      ([repo, digest]) => `${repo}@${digest}`,
    ),
  );
  return { repository, resource, ref };
}

/** @internal Reset the in-process shared manager between isolated mock graphs. */
export function resetSharedRegistryCache() {
  shared.clear();
}
