import {
  ComponentResourceOptions,
  Output,
  ProviderResource,
  all,
  output,
  runtime,
  secret,
} from "@pulumi/pulumi";
import { createHash } from "node:crypto";
import * as azureApp from "@pulumi/azure-native/app/index.js";
import * as azureAuthorization from "@pulumi/azure-native/authorization/index.js";
import * as azureResources from "@pulumi/azure-native/resources/index.js";
import { DevCommand } from "../experimental/dev-command.js";
import type { ImageArgs as DockerBuildImageArgs } from "@pulumi/docker-build";
import { Component, Transform, transform } from "../component.js";
import { ServiceIdentity, createServiceIdentity } from "./identity.js";
import { VisibleError } from "../error.js";
import {
  RegistryHandle,
  buildContainerImage,
  getBorrowedRegistry,
  getSharedRegistry,
  resolveAzureProvider,
  serviceNeedsRegistry,
} from "./registry.js";
import { Input } from "../input.js";
import { Link } from "../link.js";
import { containerAppName, managedEnvironmentName } from "./naming.js";
import {
  NormalizedServiceArgs,
  assertNoMixedContainerSettings,
  normalizeServiceArgs,
} from "./validation.js";

export interface AzureImageArgs {
  /**
   * Docker build context, relative to the SST config directory.
   * @default "."
   */
  context?: Input<string>;
  /**
   * Dockerfile path, relative to `context`.
   * @default "Dockerfile"
   */
  dockerfile?: Input<string>;
  /** Build arguments passed to Buildx; values can appear in image metadata, so do not put secrets here. */
  args?: Input<Record<string, Input<string>>>;
  /**
   * BuildKit secrets, passed separately from build args. BuildKit does not persist mounted values
   * by default; do not copy or print a secret in the Dockerfile.
   */
  secrets?: Input<Record<string, Input<string>>>;
  /** Additional tags pushed to this service container's private repository. */
  tags?: Input<Input<string>[]>;
  /** Multistage Dockerfile target. */
  target?: Input<string>;
  /**
   * Enable local Buildx cache.
   * @default true
   */
  cache?: Input<boolean>;
}

export interface AzureProbeArgs {
  /** HTTP probes require a path; TCP probes only connect to the selected port. */
  type: "http" | "tcp";
  /** Container port. Defaults are assigned for ingress probes by the Service. */
  port?: Input<number>;
  /** HTTP request path, beginning with `/`. */
  path?: Input<string>;
  /** HTTP-only scheme. */
  scheme?: Input<"HTTP" | "HTTPS">;
  initialDelaySeconds?: Input<number>;
  periodSeconds?: Input<number>;
  timeoutSeconds?: Input<number>;
  failureThreshold?: Input<number>;
  successThreshold?: Input<number>;
}

export interface AzureContainerArgs {
  /** Lowercase Container Apps container name; required for entries in `containers`. */
  name: Input<string>;
  /**
   * An existing image reference, or Docker build settings. A dynamic string `Output` remains a
   * prebuilt reference; automatic registry ownership is inferred only from a literal build object.
   * When omitted, SST builds `Dockerfile` from `context: "."`.
   */
  image?: Input<string | AzureImageArgs>;
  /**
   * CPU allocation using SST's familiar units. Defaults to `"0.25 vCPU"`.
   * Azure receives this as a number (`0.25`). Consumption allocations use 0.25-vCPU
   * increments up to 2 vCPU per replica.
   */
  cpu?: Input<`${number} vCPU`>;
  /**
   * Memory allocation using SST's familiar units. Defaults to `"0.5 GB"`.
   * Azure receives the numeric value as GiB (`"0.5 GB"` becomes `"0.5Gi"`).
   * Consumption requires 2 GiB per vCPU; the combined per-replica limit is 2 vCPU / 4 GiB.
   */
  memory?: Input<`${number} GB`>;
  /** Docker CMD override. */
  command?: Input<Input<string>[]>;
  /** Docker ENTRYPOINT override. */
  entrypoint?: Input<Input<string>[]>;
  /** Environment variables for this container. `AZURE_CLIENT_ID`, `SST_DEV`, `SST_RESOURCE_*`, and `SST_RESOURCES_JSON` are reserved. */
  environment?: Input<Record<string, Input<string>>>;
  /** Local process configuration; a command is required to start this container in `sst dev`. */
  dev?: AzureDevArgs;
  /** Azure Container Apps Startup, Readiness, and Liveness probes. */
  probes?: Input<{
    startup?: Input<AzureProbeArgs>;
    readiness?: Input<AzureProbeArgs>;
    liveness?: Input<AzureProbeArgs>;
  }>;
}

export interface AzureDevArgs {
  /** Command to start this container locally. The process uses the developer's Azure CLI identity; it does not receive the cloud user-assigned identity's permissions. */
  command?: Input<string>;
  /** Whether the local process starts automatically. Defaults to true. */
  autostart?: Input<boolean>;
  /** Working directory for the local command. */
  directory?: Input<string>;
}

export interface AzureServiceDevArgs extends AzureDevArgs {
  /** Explicit local URL exposed through the Service link in dev mode. */
  url?: Input<string>;
}

export interface AzureRegistryReference {
  /** Resource ID of an existing ACR in the Service resource group and subscription. */
  id: Input<string>;
}

export interface ServiceArgs {
  /** Existing Azure Resource Group containing all v1 resources. */
  resourceGroupName: Input<string>;
  /** Override the existing resource group's location. */
  location?: Input<string>;
  /**
   * Docker image string or build settings for a single-container service. Dynamic string Outputs
   * are treated as prebuilt references; automatic registry ownership requires a literal build object.
   *
   * Docker defaults match `sst.aws.Service`: context is `"."` relative to the SST config
   * directory, and the Dockerfile is `"Dockerfile"` relative to that context. If `image` is
   * omitted, SST builds those defaults. The Azure adaptation keeps `context`, `dockerfile`,
   * `args`, `secrets`, `tags`, `target`, and `cache`; it does not expose AWS architecture,
   * cluster, EFS, logging, SSM, or ECS health-check settings.
   */
  image?: Input<string | AzureImageArgs>;
  /** Multiple sidecars sharing one Container App identity and allocation. */
  containers?: Input<Input<AzureContainerArgs>[]>;
  /**
   * CPU allocation for the single-container form. Defaults to `"0.25 vCPU"` and maps to
   * Azure's numeric CPU field (0.25). Consumption CPU increments are 0.25 through 2 per replica.
   */
  cpu?: Input<`${number} vCPU`>;
  /**
   * Memory allocation for the single-container form. Defaults to `"0.5 GB"` and maps to
   * Azure's GiB string (`"0.5 GB"` becomes `"0.5Gi"`). Consumption requires 2 GiB per vCPU
   * and caps each replica at 2 vCPU / 4 GiB.
   */
  memory?: Input<`${number} GB`>;
  /** Docker CMD override for the single-container form. */
  command?: Input<Input<string>[]>;
  /** Docker ENTRYPOINT override for the single-container form. */
  entrypoint?: Input<Input<string>[]>;
  /** Startup, Readiness, and Liveness probe overrides for the single container. */
  probes?: AzureContainerArgs["probes"];
  /** Environment variables for the single-container form. `AZURE_CLIENT_ID`, `SST_DEV`, `SST_RESOURCE_*`, and `SST_RESOURCES_JSON` are reserved. */
  environment?: Input<Record<string, Input<string>>>;
  /**
   * Existing ACR to borrow instead of owning a shared stage registry. SST never changes its
   * permissions or authentication policy. The publisher must already have registry-scoped AcrPush.
   */
  registry?: AzureRegistryReference;
  /**
   * Narrow transforms for the generated Buildx image, Container App, and shared Managed
   * Environment. The same Environment transform function must be reused by every Service in a
   * stage; a shared environment cannot have per-Service variants.
   */
  transform?: {
    image?: Transform<DockerBuildImageArgs>;
    containerApp?: Transform<azureApp.ContainerAppArgs>;
    environment?: Transform<azureApp.ManagedEnvironmentArgs>;
  };
  /**
   * Resources linked to the cloud containers. Permission-bearing link arrays must be literal so
   * SST can create and review role assignments before the Container App is declared.
   */
  link?: Input<Link.Linkable[]>;
  /**
   * Start explicit local commands instead of provisioning this Service during `sst dev`.
   * Local processes use the developer's Azure CLI identity, never the cloud managed identity.
   * Pass `false` to force the remote Container App path during `sst dev`. A `dev.url` may be
   * supplied as a local placeholder for links; it does not change the local process or identity.
   */
  dev?: false | AzureServiceDevArgs;
  /**
   * Create managed HTTPS ingress on the Container App's default hostname.
   * This does not create a separately managed load balancer.
   */
  ingress?: Input<{
    /** Public ingress defaults to true. */
    external?: Input<boolean>;
    /** Port on the primary container. */
    targetPort: Input<number>;
  }>;
  /**
   * Container Apps scale rules. HTTP concurrency requires `ingress`.
   * With ingress and no explicit scaling config, the defaults are 0–2 replicas and
   * 10 concurrent requests per replica. Without ingress, the default is one replica.
   */
  scaling?: Input<{
    minReplicas?: Input<number>;
    maxReplicas?: Input<number>;
    http?: Input<{ concurrentRequests: Input<number> }>;
  }>;
}

interface EnvironmentRequest {
  app: string;
  stage: string;
  resourceGroupName: Input<string>;
  location?: Input<string>;
  opts?: ComponentResourceOptions;
  transform?: Transform<azureApp.ManagedEnvironmentArgs>;
}

interface EnvironmentHandle {
  resource: azureApp.ManagedEnvironment;
  id: Output<string>;
  location: Output<string>;
  resourceGroupName: Output<string>;
  validation: Output<void>;
  provider?: ProviderResource;
  transform?: Transform<azureApp.ManagedEnvironmentArgs>;
}

const sharedEnvironments = new Map<string, EnvironmentHandle>();

class EnvironmentRoot extends Component {
  constructor(provider?: ProviderResource) {
    super(
      "sst:azure:ManagedEnvironment",
      "AzureEnvironment",
      {},
      provider ? { provider } : {},
    );
  }

  complete(id: Output<string>) {
    this.registerOutputs({ environment: id });
  }
}

function azureErrorText(error: unknown) {
  return `${String((error as { code?: unknown })?.code ?? "")} ${String(
    (error as Error)?.message ?? error,
  )}`;
}

export function canonicalAzureLocation(location: string) {
  return location.toLowerCase().replace(/[\s_-]/g, "");
}

export function isConsumptionOnlyWorkloadProfiles(
  profiles: Array<{ name?: string; workloadProfileType?: string }> | undefined,
) {
  return (
    profiles?.every((profile) => {
      const type = profile.workloadProfileType?.toLowerCase();
      return type
        ? type === "consumption"
        : profile.name?.toLowerCase() === "consumption";
    }) ?? true
  );
}

function getSharedEnvironment(request: EnvironmentRequest): EnvironmentHandle {
  const key = `${request.app.toLowerCase()}|${request.stage.toLowerCase()}`;
  const provider = resolveAzureProvider(request.opts);
  const current = sharedEnvironments.get(key);
  if (current) {
    if (
      current.provider !== provider ||
      current.transform !== request.transform
    ) {
      throw new VisibleError(
        "All Azure Services in an app stage must use the same Azure Native provider for their Managed Environment.",
      );
    }
    const validation = all([
      current.resourceGroupName,
      request.resourceGroupName,
      current.location,
      request.location ?? current.location,
    ]).apply(
      ([currentGroup, requestedGroup, currentLocation, requestedLocation]) => {
        if (currentGroup.toLowerCase() !== requestedGroup.toLowerCase()) {
          throw new VisibleError(
            `Azure Services sharing the stage Managed Environment must use one Resource Group; got "${currentGroup}" and "${requestedGroup}".`,
          );
        }
        if (
          canonicalAzureLocation(currentLocation) !==
          canonicalAzureLocation(requestedLocation)
        ) {
          throw new VisibleError(
            `Azure Services sharing the stage Managed Environment must use one location; got "${currentLocation}" and "${requestedLocation}".`,
          );
        }
      },
    );
    return {
      ...current,
      id: all([current.id, validation]).apply(([id]) => id),
      validation,
    };
  }

  const root = new EnvironmentRoot(provider);
  const invokeOptions = provider ? { provider } : undefined;
  const group = azureResources.getResourceGroupOutput(
    { resourceGroupName: request.resourceGroupName },
    invokeOptions,
  );
  const client = azureAuthorization.getClientConfigOutput(invokeOptions);
  const name = all([client.subscriptionId, request.resourceGroupName]).apply(
    ([subscriptionId, resourceGroupName]) =>
      managedEnvironmentName({
        app: request.app,
        stage: request.stage,
        resourceGroupName,
        subscriptionId,
      }),
  );
  const checkedName = all([
    name,
    request.resourceGroupName,
    group.location,
    request.location ?? group.location,
  ]).apply(
    async ([environmentName, resourceGroupName, , requestedLocation]) => {
      try {
        const existing = await azureApp.getManagedEnvironment(
          { environmentName, resourceGroupName },
          invokeOptions,
        );
        if (!existing.id) return environmentName;
        const owned =
          existing.tags?.["sst:app"]?.toLowerCase() ===
            request.app.toLowerCase() &&
          existing.tags?.["sst:stage"]?.toLowerCase() ===
            request.stage.toLowerCase() &&
          existing.tags?.["sst:owner"] === "sst.azure.Service";
        if (!owned) {
          throw new VisibleError(
            `Generated Managed Environment name "${environmentName}" is already occupied by a resource SST does not own. SST will not adopt or modify it.`,
          );
        }
        if (
          canonicalAzureLocation(existing.location) !==
          canonicalAzureLocation(requestedLocation)
        ) {
          throw new VisibleError(
            `Managed Environment "${environmentName}" already exists in location "${existing.location}" and cannot be moved to "${requestedLocation}".`,
          );
        }
        const logDestination =
          existing.appLogsConfiguration?.destination?.toLowerCase();
        if (
          !isConsumptionOnlyWorkloadProfiles(existing.workloadProfiles) ||
          existing.vnetConfiguration?.infrastructureSubnetId ||
          existing.vnetConfiguration?.internal ||
          existing.vnetConfiguration?.dockerBridgeCidr ||
          existing.vnetConfiguration?.platformReservedCidr ||
          existing.vnetConfiguration?.platformReservedDnsIP ||
          (logDestination && logDestination !== "none") ||
          existing.publicNetworkAccess?.toLowerCase() !== "enabled"
        ) {
          throw new VisibleError(
            `Managed Environment "${environmentName}" is not the reviewed Consumption-only, no-VNet, no-persistent-log configuration with public networking enabled. Revise it outside SST before reuse.`,
          );
        }
        return environmentName;
      } catch (error) {
        if (error instanceof VisibleError) throw error;
        if (
          /404|ResourceNotFound|ManagedEnvironmentNotFound|not found/i.test(
            azureErrorText(error),
          )
        ) {
          return environmentName;
        }
        throw new VisibleError(
          `Unable to verify that Managed Environment name "${environmentName}" is available. Refusing to risk changing a resource outside this SST stage.`,
        );
      }
    },
  );
  const requestedLocation = request.location ?? group.location;
  const [resourceName, resourceArgs, resourceOpts] = transform(
    request.transform,
    "AzureEnvironment-Managed",
    {
      environmentName: checkedName,
      resourceGroupName: request.resourceGroupName,
      location: requestedLocation,
      publicNetworkAccess: "Enabled",
      zoneRedundant: false,
      tags: {
        "sst:app": request.app,
        "sst:stage": request.stage,
        "sst:owner": "sst.azure.Service",
      },
    },
    {
      parent: root,
      ...(provider ? { provider } : {}),
      protect: request.opts?.protect,
      retainOnDelete: request.opts?.retainOnDelete ?? true,
    },
  );
  const environmentTags = resourceArgs.tags as
    | Record<string, unknown>
    | undefined;
  if (
    resourceArgs.environmentName !== checkedName ||
    resourceArgs.resourceGroupName !== request.resourceGroupName ||
    resourceArgs.location !== requestedLocation ||
    resourceArgs.workloadProfiles !== undefined ||
    resourceArgs.vnetConfiguration !== undefined ||
    resourceArgs.infrastructureResourceGroup !== undefined ||
    resourceArgs.appLogsConfiguration !== undefined ||
    resourceArgs.publicNetworkAccess !== "Enabled" ||
    resourceArgs.zoneRedundant !== false ||
    environmentTags?.["sst:app"] !== request.app ||
    environmentTags?.["sst:stage"] !== request.stage ||
    environmentTags?.["sst:owner"] !== "sst.azure.Service"
  ) {
    throw new VisibleError(
      "Azure Service Managed Environment transforms cannot change its generated identity, Resource Group, location, Consumption-only profile, public networking, or no-persistent-log policy.",
    );
  }
  const resource = new azureApp.ManagedEnvironment(
    resourceName,
    resourceArgs,
    resourceOpts,
  );
  const handle: EnvironmentHandle = {
    resource,
    id: resource.id,
    location: output(resource.location),
    resourceGroupName: output(request.resourceGroupName),
    validation: output(undefined),
    provider,
    transform: request.transform,
  };
  root.complete(resource.id);
  sharedEnvironments.set(key, handle);
  return handle;
}

export interface RevisionStatus {
  latestRevisionName?: string;
  latestReadyRevisionName?: string;
  provisioningState?: string;
}

export type RevisionReader = () => Promise<RevisionStatus>;
export type RevisionSleep = (milliseconds: number) => Promise<void>;

const sleep: RevisionSleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function waitForReadyRevision(input: {
  serviceName: string;
  expectedRevisionName: string;
  reader: RevisionReader;
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: RevisionSleep;
}) {
  const timeoutMs = input.timeoutMs ?? 10 * 60 * 1000;
  const pollIntervalMs = input.pollIntervalMs ?? 15 * 1000;
  const pause = input.sleep ?? sleep;
  const deadline = Date.now() + timeoutMs;
  let latestRevisionName: string | undefined;
  let latestReadyRevisionName: string | undefined;
  do {
    let status: RevisionStatus;
    try {
      status = await input.reader();
    } catch (error) {
      if (
        !/404|ResourceNotFound|ContainerAppNotFound|not found/i.test(
          azureErrorText(error),
        )
      ) {
        throw new VisibleError(
          `Unable to inspect Azure Service "${input.serviceName}" revision readiness.`,
        );
      }
      if (Date.now() >= deadline) break;
      await pause(Math.min(pollIntervalMs, deadline - Date.now()));
      continue;
    }
    latestRevisionName = status.latestRevisionName;
    latestReadyRevisionName = status.latestReadyRevisionName;
    if (status.provisioningState?.toLowerCase() === "failed") {
      throw new VisibleError(
        `Azure Service "${input.serviceName}" revision "${
          latestRevisionName ?? "unknown"
        }" failed provisioning; latest ready revision is "${
          latestReadyRevisionName ?? "none"
        }".`,
      );
    }
    if (
      latestRevisionName === input.expectedRevisionName &&
      latestReadyRevisionName === input.expectedRevisionName
    ) {
      return input.expectedRevisionName;
    }
    if (Date.now() >= deadline) break;
    await pause(Math.min(pollIntervalMs, deadline - Date.now()));
  } while (Date.now() <= deadline);
  throw new VisibleError(
    `Azure Service "${input.serviceName}" did not make revision "${input.expectedRevisionName}" ready within ${Math.ceil(
      timeoutMs / 60000,
    )} minutes; latest ready revision remains "${
      latestReadyRevisionName ?? "none"
    }".`,
  );
}

function containerSecretName(containerName: string, key: string) {
  const stem =
    `${containerName}-${key}`
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 42) || "environment";
  const hash = createHash("sha256")
    .update(`${containerName}|${key}`)
    .digest("hex")
    .slice(0, 8);
  return `sst-${stem}-${hash}`;
}

function buildEnvironment(
  container: NormalizedServiceArgs["containers"][number],
  linkedEnvironment: Record<string, string>,
  clientId: Output<string>,
) {
  const secrets: Array<{ name: string; value: Output<string> }> = [];
  const env: Array<Record<string, unknown>> = [];
  const values = {
    ...linkedEnvironment,
    ...((container.environment ?? {}) as Record<string, string>),
  };
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const secretName = containerSecretName(container.name, name);
    secrets.push({ name: secretName, value: secret(value) });
    env.push({ name, secretRef: secretName });
  }
  env.push({ name: "AZURE_CLIENT_ID", value: clientId });
  return { env, secrets };
}

function buildProbe(probe: any, label: string, fallbackPort?: number) {
  const port = probe.port ?? fallbackPort;
  if (!port) {
    throw new VisibleError(
      `Azure Service probe "${label}" needs a port; only ingress-container probes default to ingress.targetPort.`,
    );
  }
  const result: Record<string, unknown> = {
    type:
      label === "startup"
        ? "Startup"
        : label === "readiness"
          ? "Readiness"
          : "Liveness",
    initialDelaySeconds: probe.initialDelaySeconds,
    periodSeconds: probe.periodSeconds,
    timeoutSeconds: probe.timeoutSeconds,
    successThreshold: probe.successThreshold,
    ...(probe.failureThreshold !== undefined
      ? { failureThreshold: probe.failureThreshold }
      : {}),
  };
  if (probe.type === "http") {
    result.httpGet = {
      path: probe.path ?? "/",
      port,
      scheme: probe.scheme ?? "HTTP",
    };
  } else {
    result.tcpSocket = { port };
  }
  return result;
}

function buildContainerProbes(
  container: NormalizedServiceArgs["containers"][number],
  index: number,
  ingress?: { targetPort: number },
) {
  const configured = (container.probes ?? {}) as Record<string, any>;
  const primaryPort = index === 0 ? ingress?.targetPort : undefined;
  const output: Record<string, unknown>[] = [];
  for (const kind of ["startup", "readiness", "liveness"] as const) {
    const explicit = configured[kind];
    let probe = explicit;
    if (!probe && primaryPort && kind === "startup") {
      // Omit failureThreshold so ACA applies its documented Startup default (240).
      probe = {
        type: "tcp",
        port: primaryPort,
        initialDelaySeconds: 1,
        periodSeconds: 1,
        timeoutSeconds: 3,
        successThreshold: 1,
      };
    } else if (!probe && primaryPort && kind === "readiness") {
      // Omit failureThreshold so ACA applies its documented Readiness default (48).
      probe = {
        type: "tcp",
        port: primaryPort,
        initialDelaySeconds: 3,
        periodSeconds: 5,
        timeoutSeconds: 5,
        successThreshold: 1,
      };
    }
    if (probe) output.push(buildProbe(probe, kind, primaryPort));
  }
  return output.length ? output : undefined;
}

export function localDevCommandArgs(
  serviceName: string,
  container: NormalizedServiceArgs["containers"][number],
  containerCount: number,
  link?: Input<Link.Linkable[]>,
) {
  const dev = container.dev as AzureDevArgs | undefined;
  if (typeof dev?.command !== "string" || !dev.command.trim()) return undefined;
  const title =
    containerCount === 1 ? serviceName : `${serviceName}${container.name}`;
  return {
    link,
    dev: {
      title,
      autostart: dev.autostart ?? true,
      command: dev.command,
      directory:
        dev.directory ??
        (typeof container.image === "object"
          ? container.image.context
          : undefined),
    },
    environment: {
      ...((container.environment ?? {}) as Record<string, Input<string>>),
      SST_DEV: "true",
    },
  };
}

function buildScale(normalized: NormalizedServiceArgs) {
  const ingress = normalized.ingress as { targetPort: number } | undefined;
  const scaling = normalized.scaling as
    | {
        minReplicas?: number;
        maxReplicas?: number;
        http?: { concurrentRequests: number };
      }
    | undefined;
  const hasDefaults = !scaling && !ingress;
  const rules = scaling?.http
    ? [
        {
          name: "http-concurrency",
          http: {
            metadata: {
              concurrentRequests: String(scaling.http.concurrentRequests),
            },
          },
        },
      ]
    : ingress && !scaling
      ? [
          {
            name: "http-concurrency",
            http: { metadata: { concurrentRequests: "10" } },
          },
        ]
      : undefined;
  return {
    minReplicas: hasDefaults ? 1 : scaling?.minReplicas ?? 0,
    maxReplicas: hasDefaults ? 1 : scaling?.maxReplicas ?? 2,
    cooldownPeriod: 300,
    pollingInterval: 30,
    rules,
  };
}

/**
 * Azure Container Apps service component. It adapts the AWS Service image/container vocabulary
 * while replacing its cluster with an existing Azure Resource Group.
 */
export class Service extends Component {
  /** @internal Resolved and validated Service inputs shared by resource-graph builders. */
  readonly normalized: Output<NormalizedServiceArgs>;
  /** @internal Shared owned or validated borrowed registry, when needed by the image inputs. */
  readonly registry?: RegistryHandle;
  /** Image references by container name; built images resolve to immutable repository digests. */
  readonly imageRefs: Output<Record<string, string>>;
  /** @internal Dedicated workload identity and SST-managed role assignments. */
  readonly identity?: ServiceIdentity;
  /** Shared app/stage Consumption Managed Environment; absent in local dev mode. */
  readonly environment?: azureApp.ManagedEnvironment;
  /** The deployed Container App; absent in local dev mode. */
  readonly containerApp?: azureApp.ContainerApp;
  private readonly localDev: boolean;
  /** HTTPS URL when ingress is configured. */
  readonly url: Output<string | undefined>;
  readonly latestRevisionName: Output<string | undefined>;
  readonly latestReadyRevisionName: Output<string | undefined>;
  /** Resolves only when Azure reports the latest revision ready; skipped in preview. */
  readonly readyRevision: Output<string | undefined>;

  constructor(
    name: string,
    args: ServiceArgs,
    opts?: ComponentResourceOptions,
  ) {
    assertNoMixedContainerSettings(args);
    super("sst:azure:Service", name, args, opts);
    this.normalized = output(args).apply(normalizeServiceArgs);
    this.localDev = Boolean(
      typeof $dev !== "undefined" && $dev && args.dev !== false,
    );
    if (this.localDev) {
      this.identity = undefined;
      this.environment = undefined;
      this.containerApp = undefined;
      this.imageRefs = this.normalized.apply((normalized) =>
        Object.fromEntries(
          normalized.containers.flatMap((container) =>
            typeof container.image === "string"
              ? [[container.name, container.image]]
              : [],
          ),
        ),
      );
      const dev = args.dev === false ? undefined : args.dev;
      this.url = output(dev?.url);
      this.latestRevisionName = output(undefined);
      this.latestReadyRevisionName = output(undefined);
      this.readyRevision = output(undefined);
      this.normalized.apply((normalized) => {
        for (const container of normalized.containers) {
          const devArgs = localDevCommandArgs(
            name,
            container,
            normalized.containers.length,
            args.link,
          );
          if (!devArgs) continue;
          new DevCommand(`${devArgs.dev.title}Dev`, devArgs, {
            parent: this,
          });
        }
      });
      this.registerOutputs({
        imageRefs: this.imageRefs,
        url: this.url,
        latestRevisionName: this.latestRevisionName,
        latestReadyRevisionName: this.latestReadyRevisionName,
      });
      return;
    }
    if (args.registry !== undefined) {
      const registry = args.registry as AzureRegistryReference;
      if (!registry || typeof registry !== "object" || !registry.id) {
        throw new VisibleError(
          'Azure Service "registry" must include a resource "id".',
        );
      }
      this.registry = getBorrowedRegistry({
        app: $app.name,
        stage: $app.stage,
        resourceGroupName: args.resourceGroupName,
        location: args.location,
        id: registry.id,
        opts,
      });
    } else if (serviceNeedsRegistry(args)) {
      this.registry = getSharedRegistry({
        app: $app.name,
        stage: $app.stage,
        resourceGroupName: args.resourceGroupName,
        location: args.location,
        opts,
      });
    }
    const environment = getSharedEnvironment({
      app: $app.name,
      stage: $app.stage,
      resourceGroupName: args.resourceGroupName,
      location: args.location,
      opts,
      transform: args.transform?.environment,
    });
    this.environment = environment.resource;
    const identity = createServiceIdentity({
      parent: this,
      name,
      app: $app.name,
      stage: $app.stage,
      resourceGroupName: args.resourceGroupName,
      location: args.location,
      opts,
      registry: this.registry,
      link: args.link,
    });
    this.identity = identity;
    this.imageRefs = this.normalized.apply((normalized) => {
      const refs = normalized.containers.map((container) => {
        if (typeof container.image === "string") {
          return output(container.image);
        }
        if (!this.registry) {
          throw new VisibleError(
            `Azure Service container "${container.name}" resolved to Docker build settings, but no registry was planned. Use a literal image object for automatic stage-registry ownership or configure a borrowed registry explicitly.`,
          );
        }
        return buildContainerImage({
          parent: this,
          serviceName: name,
          app: $app.name,
          stage: $app.stage,
          container,
          registry: this.registry,
          transform: args.transform?.image,
        }).ref;
      });
      return all(refs).apply((values) =>
        Object.fromEntries(
          normalized.containers.map((container, index) => [
            container.name,
            values[index],
          ]),
        ),
      );
    });

    const physicalName = containerAppName({
      app: $app.name,
      stage: $app.stage,
      service: name,
    });
    const linkedEnvironment = Link.propertiesToEnv(
      Link.getProperties(args.link),
    );
    const appDefinition = all([
      this.normalized,
      this.imageRefs,
      linkedEnvironment,
    ]).apply(([normalized, imageRefs, linkEnvironment]) => {
      const secrets: Array<{ name: string; value: Output<string> }> = [];
      const ingress = normalized.ingress as
        | { external?: boolean; targetPort: number }
        | undefined;
      const containers = normalized.containers.map((container, index) => {
        const env = buildEnvironment(
          container,
          linkEnvironment,
          identity.clientId,
        );
        secrets.push(...env.secrets);
        return {
          name: container.name,
          image: imageRefs[container.name],
          imageType: "ContainerImage",
          command: container.entrypoint as any,
          args: container.command as any,
          resources: {
            cpu: container.cpu,
            memory: container.memory,
          },
          env: env.env,
          probes: buildContainerProbes(container, index, ingress),
        };
      });
      return {
        configuration: {
          activeRevisionsMode: ingress ? "Multiple" : "Single",
          ingress: ingress
            ? {
                external: ingress.external ?? true,
                targetPort: ingress.targetPort,
                allowInsecure: false,
                transport: "auto",
                traffic: [{ latestRevision: true, weight: 100 }],
              }
            : undefined,
          registries: this.registry
            ? [
                {
                  server: this.registry.loginServer,
                  identity: identity.id,
                },
              ]
            : undefined,
          secrets: secrets.length ? secrets : undefined,
        },
        template: {
          containers,
          scale: buildScale(normalized as NormalizedServiceArgs),
        },
      };
    });
    const appArgs: azureApp.ContainerAppArgs = {
      containerAppName: physicalName,
      resourceGroupName: args.resourceGroupName,
      location: environment.location,
      environmentId: environment.id,
      identity: {
        type: "UserAssigned",
        userAssignedIdentities: [identity.id],
      },
      configuration: appDefinition.apply((value) => value.configuration),
      template: appDefinition.apply((value) => value.template),
      tags: {
        "sst:app": $app.name,
        "sst:stage": $app.stage,
        "sst:service": name,
      },
    };
    const [resourceName, resourceArgs, resourceOpts] = transform(
      args.transform?.containerApp,
      `${name}ContainerApp`,
      appArgs,
      {
        parent: this,
        dependsOn: identity.dependencies,
        protect: opts?.protect,
        retainOnDelete: opts?.retainOnDelete,
      },
    );
    const appIdentity = resourceArgs.identity as
      | { type?: unknown; userAssignedIdentities?: unknown[] }
      | undefined;
    if (
      resourceArgs.resourceGroupName !== appArgs.resourceGroupName ||
      resourceArgs.environmentId !== appArgs.environmentId ||
      appIdentity?.type !== "UserAssigned" ||
      !Array.isArray(appIdentity.userAssignedIdentities) ||
      !appIdentity.userAssignedIdentities.includes(identity.id)
    ) {
      throw new VisibleError(
        "Azure Service Container App transforms cannot change its Resource Group, shared Managed Environment, or SST-managed user-assigned identity.",
      );
    }
    const requiredDependencies = identity.dependencies;
    const configuredDependencies = Array.isArray(resourceOpts.dependsOn)
      ? resourceOpts.dependsOn
      : [];
    resourceOpts.dependsOn = [
      ...configuredDependencies,
      ...requiredDependencies,
    ];
    const containerApp = new azureApp.ContainerApp(
      resourceName,
      resourceArgs,
      resourceOpts,
    );
    this.containerApp = containerApp;
    this.url = (
      args.ingress
        ? containerApp.latestRevisionFqdn.apply((fqdn) =>
            fqdn ? `https://${fqdn}` : undefined,
          )
        : output(undefined)
    ) as Output<string | undefined>;
    this.latestRevisionName = containerApp.latestRevisionName;
    this.latestReadyRevisionName = containerApp.latestReadyRevisionName;
    this.readyRevision = runtime.isDryRun()
      ? output(undefined)
      : all([
          containerApp.id,
          containerApp.latestRevisionName,
          args.resourceGroupName,
        ]).apply(([_, expectedRevisionName, resourceGroupName]) =>
          waitForReadyRevision({
            serviceName: name,
            expectedRevisionName,
            reader: async () => {
              const status = await azureApp.getContainerApp(
                {
                  containerAppName: physicalName,
                  resourceGroupName,
                },
                resolveAzureProvider(opts)
                  ? { provider: resolveAzureProvider(opts) }
                  : undefined,
              );
              return {
                latestRevisionName: status.latestRevisionName,
                latestReadyRevisionName: status.latestReadyRevisionName,
                provisioningState: status.provisioningState,
              };
            },
          }),
        );
    this.registerOutputs({
      imageRefs: this.imageRefs,
      url: this.url,
      latestRevisionName: this.latestRevisionName,
      latestReadyRevisionName: this.latestReadyRevisionName,
      readyRevision: this.readyRevision,
    });
  }

  get nodes() {
    if (!this.containerApp || !this.environment || !this.identity) {
      throw new VisibleError(
        "Azure Service nodes are unavailable in local dev mode; use them only for remote Container Apps deployments.",
      );
    }
    return {
      containerApp: this.containerApp,
      environment: this.environment,
      identity: this.identity.resource,
    };
  }

  public getSSTLink(): Link.Definition {
    return { properties: { url: this.url } };
  }
}
