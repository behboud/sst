import { VisibleError } from "../error.js";
import type {
  ServiceArgs,
  AzureContainerArgs,
  AzureImageArgs,
} from "./service.js";

export const DEFAULT_CPU = "0.25 vCPU" as const;
export const DEFAULT_MEMORY = "0.5 GB" as const;

export interface NormalizedAllocation {
  cpu: number;
  memory: `${number}Gi`;
  cpuUnits: number;
  memoryGi: number;
}

export interface NormalizedImage extends AzureImageArgs {
  context: string;
  dockerfile: string;
}

export interface NormalizedContainer
  extends Omit<AzureContainerArgs, "image" | "cpu" | "memory"> {
  name: string;
  image: string | NormalizedImage;
  cpu: number;
  memory: `${number}Gi`;
}

export interface NormalizedServiceArgs
  extends Omit<ServiceArgs, "containers" | "image" | "cpu" | "memory"> {
  containers: NormalizedContainer[];
}

const CPU_VALUES = new Map<string, number>([
  ["0.25 vCPU", 0.25],
  ["0.5 vCPU", 0.5],
  ["0.75 vCPU", 0.75],
  ["1 vCPU", 1],
  ["1.25 vCPU", 1.25],
  ["1.5 vCPU", 1.5],
  ["1.75 vCPU", 1.75],
  ["2 vCPU", 2],
]);

const MEMORY_VALUES = new Set([
  "0.5 GB",
  "1 GB",
  "1.5 GB",
  "2 GB",
  "2.5 GB",
  "3 GB",
  "3.5 GB",
  "4 GB",
]);

export function normalizeAllocation(
  cpu: string | undefined,
  memory: string | undefined,
): NormalizedAllocation {
  const cpuValue = cpu ?? DEFAULT_CPU;
  const memoryValue = memory ?? DEFAULT_MEMORY;
  const cpuUnits = CPU_VALUES.get(cpuValue);
  if (cpuUnits === undefined) {
    throw new VisibleError(
      `Unsupported Azure Container Apps CPU allocation "${cpuValue}". Supported values: ${[
        ...CPU_VALUES.keys(),
      ].join(", ")}.`,
    );
  }
  if (!MEMORY_VALUES.has(memoryValue)) {
    throw new VisibleError(
      `Unsupported Azure Container Apps memory allocation "${memoryValue}". Supported values: ${[
        ...MEMORY_VALUES,
      ].join(", ")}.`,
    );
  }
  const memoryGi = Number.parseFloat(memoryValue);
  if (memoryGi !== cpuUnits * 2) {
    throw new VisibleError(
      `Azure Container Apps Consumption allocations require 2 GiB per vCPU; "${cpuValue}" must be paired with "${
        cpuUnits * 2
      } GB".`,
    );
  }
  return {
    cpu: cpuUnits,
    memory: `${memoryGi}Gi`,
    cpuUnits,
    memoryGi,
  };
}

export function assertNoMixedContainerSettings(args: ServiceArgs) {
  if (
    args.containers &&
    (args.image !== undefined ||
      args.command !== undefined ||
      args.entrypoint !== undefined ||
      args.probes !== undefined ||
      args.environment !== undefined ||
      args.cpu !== undefined ||
      args.memory !== undefined ||
      (typeof args.dev === "object" &&
        args.dev !== null &&
        (args.dev.command !== undefined ||
          args.dev.autostart !== undefined ||
          args.dev.directory !== undefined)))
  ) {
    throw new VisibleError(
      'Azure Service cannot combine "containers" with top-level "image", "command", "entrypoint", "probes", "environment", "cpu", "memory", or local dev command settings. Put those settings on each container; "dev: false" and "dev.url" remain service-level settings.',
    );
  }
}

export function normalizeServiceArgs(
  args: Record<string, any>,
): NormalizedServiceArgs {
  assertNoMixedContainerSettings(args as ServiceArgs);
  if (
    typeof args.resourceGroupName !== "string" ||
    !args.resourceGroupName.trim()
  ) {
    throw new VisibleError(
      'Azure Service requires a non-empty "resourceGroupName".',
    );
  }

  const containers: Record<string, any>[] = args.containers ?? [
    {
      name: "app",
      image: args.image,
      command: args.command,
      entrypoint: args.entrypoint,
      probes: args.probes,
      environment: args.environment,
      cpu: args.cpu,
      memory: args.memory,
      dev: args.dev,
    },
  ];
  if (!Array.isArray(containers) || containers.length === 0) {
    throw new VisibleError(
      'Azure Service "containers" must be a non-empty array.',
    );
  }

  const names = new Set<string>();
  let totalCpu = 0;
  let totalMemory = 0;
  const normalized = containers.map((container, index): NormalizedContainer => {
    if (!container || typeof container !== "object") {
      throw new VisibleError(
        `Azure Service container ${index + 1} must be an object.`,
      );
    }
    const name = container.name;
    if (
      typeof name !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(name)
    ) {
      throw new VisibleError(
        `Invalid Azure container name "${String(
          name,
        )}". Use 1–32 lowercase letters, numbers, or internal hyphens.`,
      );
    }
    if (names.has(name)) {
      throw new VisibleError(
        `Azure Service has duplicate container name "${name}".`,
      );
    }
    names.add(name);

    const allocation = normalizeAllocation(
      container.cpu as string | undefined,
      container.memory as string | undefined,
    );
    totalCpu += allocation.cpuUnits;
    totalMemory += allocation.memoryGi;

    const image = normalizeImage(container.image);
    validateContainerOptions(container as AzureContainerArgs, name);
    return {
      ...container,
      name,
      image,
      cpu: allocation.cpu,
      memory: allocation.memory,
    };
  });

  if (totalCpu > 2 || totalMemory > 4) {
    throw new VisibleError(
      `Azure Container Apps Consumption allocation exceeds the v1 per-replica limit of 2 vCPU / 4 GiB (requested ${totalCpu} vCPU / ${totalMemory} GiB).`,
    );
  }
  validateAzureOptions(args);
  return { ...args, containers: normalized } as NormalizedServiceArgs;
}

function normalizeImage(image: any): string | NormalizedImage {
  if (typeof image === "string") {
    if (!image.trim() || image !== image.trim()) {
      throw new VisibleError(
        "Azure Service image cannot be empty or padded with whitespace.",
      );
    }
    return image;
  }
  if (
    image !== undefined &&
    (image === null || typeof image !== "object" || Array.isArray(image))
  ) {
    throw new VisibleError(
      "Azure Service image must be an image string or Docker build settings object.",
    );
  }
  const value = image ?? {};
  const context = value.context ?? ".";
  const dockerfile = value.dockerfile ?? "Dockerfile";
  if (
    typeof context !== "string" ||
    typeof dockerfile !== "string" ||
    !context.trim() ||
    !dockerfile.trim()
  ) {
    throw new VisibleError(
      'Azure Service image "context" and "dockerfile" must be non-empty paths.',
    );
  }
  if (value.tags !== undefined && !Array.isArray(value.tags)) {
    throw new VisibleError(
      'Azure Service image "tags" must be an array of tag strings.',
    );
  }
  return { ...value, context, dockerfile };
}

export function validateReservedEnvironment(
  environment: unknown,
  containerName = "",
) {
  if (!environment || typeof environment !== "object") return;
  for (const key of Object.keys(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new VisibleError(
        `Container "${
          containerName || "app"
        }" has invalid environment variable name "${key}".`,
      );
    }
    const normalized = key.toUpperCase();
    if (
      normalized === "AZURE_CLIENT_ID" ||
      normalized === "SST_DEV" ||
      normalized === "SST_RESOURCES_JSON" ||
      normalized.startsWith("SST_RESOURCE_")
    ) {
      throw new VisibleError(
        `Container "${
          containerName || "app"
        }" cannot override reserved environment variable "${key}".`,
      );
    }
  }
}

function validateContainerOptions(container: AzureContainerArgs, name: string) {
  if (container.probes) {
    for (const [kind, probe] of Object.entries(container.probes)) {
      if (kind !== "startup" && kind !== "readiness" && kind !== "liveness") {
        throw new VisibleError(
          `Unknown Azure Service probe "${name}.${kind}"; use startup, readiness, or liveness.`,
        );
      }
      if (!probe) continue;
      validateProbe(probe, `${name}.${kind}`);
    }
  }
  validateReservedEnvironment(container.environment, name);
}

function validateProbe(probe: Record<string, any>, label: string) {
  if (probe.type !== "http" && probe.type !== "tcp") {
    throw new VisibleError(`Probe "${label}" type must be "http" or "tcp".`);
  }
  if (
    probe.port !== undefined &&
    (!Number.isInteger(probe.port) || probe.port < 1 || probe.port > 65535)
  ) {
    throw new VisibleError(
      `Probe "${label}" port must be an integer from 1 to 65535.`,
    );
  }
  if (probe.type === "http") {
    if (
      probe.path !== undefined &&
      (typeof probe.path !== "string" || !probe.path.startsWith("/"))
    ) {
      throw new VisibleError(`HTTP probe "${label}" path must start with "/".`);
    }
    if (
      probe.scheme !== undefined &&
      probe.scheme !== "HTTP" &&
      probe.scheme !== "HTTPS"
    ) {
      throw new VisibleError(
        `HTTP probe "${label}" scheme must be "HTTP" or "HTTPS".`,
      );
    }
  } else if (probe.path !== undefined || probe.scheme !== undefined) {
    throw new VisibleError(
      `TCP probe "${label}" cannot set "path" or "scheme".`,
    );
  }
  for (const field of [
    "initialDelaySeconds",
    "periodSeconds",
    "timeoutSeconds",
    "failureThreshold",
    "successThreshold",
  ]) {
    const value = probe[field];
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new VisibleError(
        `Probe "${label}" ${field} must be a non-negative integer.`,
      );
    }
  }
  if (
    probe.initialDelaySeconds !== undefined &&
    (probe.initialDelaySeconds < 1 || probe.initialDelaySeconds > 60)
  ) {
    throw new VisibleError(
      `Probe "${label}" initialDelaySeconds must be between 1 and 60.`,
    );
  }
  if (
    probe.periodSeconds !== undefined &&
    (probe.periodSeconds < 1 || probe.periodSeconds > 240)
  ) {
    throw new VisibleError(
      `Probe "${label}" periodSeconds must be between 1 and 240.`,
    );
  }
  if (
    probe.timeoutSeconds !== undefined &&
    (probe.timeoutSeconds < 1 || probe.timeoutSeconds > 240)
  ) {
    throw new VisibleError(
      `Probe "${label}" timeoutSeconds must be between 1 and 240.`,
    );
  }
  if (
    probe.failureThreshold !== undefined &&
    (probe.failureThreshold < 1 || probe.failureThreshold > 10)
  ) {
    throw new VisibleError(
      `Probe "${label}" failureThreshold must be between 1 and 10.`,
    );
  }
  if (
    probe.successThreshold !== undefined &&
    (probe.successThreshold < 1 || probe.successThreshold > 10)
  ) {
    throw new VisibleError(
      `Probe "${label}" successThreshold must be between 1 and 10.`,
    );
  }
  if (
    probe.successThreshold !== undefined &&
    !label.endsWith(".readiness") &&
    probe.successThreshold !== 1
  ) {
    throw new VisibleError(
      `Probe "${label}" successThreshold must be 1 except on readiness probes.`,
    );
  }
}

function validateAzureOptions(args: Record<string, any>) {
  const ingress = args.ingress;
  if (ingress) {
    if (
      !Number.isInteger(ingress.targetPort) ||
      ingress.targetPort < 1 ||
      ingress.targetPort > 65535
    ) {
      throw new VisibleError(
        'Azure Service "ingress.targetPort" must be an integer from 1 to 65535.',
      );
    }
    if (
      ingress.external !== undefined &&
      typeof ingress.external !== "boolean"
    ) {
      throw new VisibleError(
        'Azure Service "ingress.external" must be a boolean.',
      );
    }
  }

  const scaling = args.scaling;
  if (scaling) {
    const min = scaling.minReplicas ?? 0;
    const max = scaling.maxReplicas ?? 2;
    if (!Number.isInteger(min) || min < 0 || min > 300) {
      throw new VisibleError(
        'Azure Service "scaling.minReplicas" must be an integer from 0 to 300.',
      );
    }
    if (!Number.isInteger(max) || max < 1 || max > 300 || min > max) {
      throw new VisibleError(
        'Azure Service "scaling.maxReplicas" must be an integer from 1 to 300 and no less than minReplicas.',
      );
    }
    if (scaling.http) {
      if (!ingress) {
        throw new VisibleError(
          'Azure Service HTTP concurrency scaling requires "ingress" with a targetPort.',
        );
      }
      const concurrentRequests = scaling.http.concurrentRequests;
      if (
        !Number.isInteger(concurrentRequests) ||
        concurrentRequests < 1 ||
        concurrentRequests > 3000
      ) {
        throw new VisibleError(
          'Azure Service "scaling.http.concurrentRequests" must be an integer from 1 to 3000.',
        );
      }
    }
  }
}
