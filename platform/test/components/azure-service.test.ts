import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { Link } from "../../src/components/link.js";
import {
  Service,
  canonicalAzureLocation,
  isConsumptionOnlyWorkloadProfiles,
  localDevCommandArgs,
  waitForReadyRevision,
} from "../../src/components/azure/service.js";
import {
  buildKitSecrets,
  resolveDockerContext,
} from "../../src/components/azure/registry.js";
import {
  BLOB_DATA_CONTRIBUTOR_ROLE_ID,
  BLOB_DATA_READER_ROLE_ID,
  blob,
  permission,
} from "../../src/components/azure/link.js";
import {
  ACR_PULL_ROLE_ID,
  validateAzurePermissionScope,
} from "../../src/components/azure/identity.js";
import {
  assertNoMixedContainerSettings,
  normalizeAllocation,
  normalizeServiceArgs,
} from "../../src/components/azure/validation.js";
import type { ServiceArgs } from "../../src/components/azure/service.js";

// @ts-ignore
(global as any).$app = { name: "app", stage: "test", providers: {} };
const testRoot = path.join("/tmp", `sst-azure-service-${process.pid}`);
for (const dir of [".", "app", "sidecar", "one", "two"]) {
  const context = path.join(testRoot, dir);
  fs.mkdirSync(context, { recursive: true });
  fs.writeFileSync(path.join(context, "Dockerfile"), "FROM scratch\n");
  fs.writeFileSync(
    path.join(context, ".dockerignore"),
    [
      ".sst",
      ".env*",
      "*.pem",
      "*.key",
      "*.p12",
      "*.pfx",
      "*.tfstate*",
      "Pulumi.*.yaml",
      "secrets/",
    ].join("\n"),
  );
}
// @ts-ignore
(global as any).$cli = { paths: { root: testRoot } };

const registered: pulumi.runtime.MockResourceArgs[] = [];
const invoked: string[] = [];
pulumi.runtime.setMocks(
  {
    newResource(args) {
      registered.push(args);
      const registryId =
        args.type === "azure-native:containerregistry:Registry"
          ? `/subscriptions/subscription-id/resourceGroups/approved-rg/providers/Microsoft.ContainerRegistry/registries/${args.inputs.registryName}`
          : args.name;
      return {
        id: registryId,
        state: {
          ...args.inputs,
          ...(args.type === "azure-native:managedidentity:UserAssignedIdentity"
            ? {
                principalId: `principal-${args.name}`,
                clientId: `client-${args.name}`,
                tenantId: "tenant-id",
              }
            : {}),
          id: registryId,
          name: args.inputs.registryName ?? args.name,
          loginServer: `${args.inputs.registryName ?? "mock"}.azurecr.io`,
          location: args.inputs.location ?? "eastus",
          digest: "sha256:mock-digest",
          ...(args.type === "azure-native:app:ContainerApp"
            ? {
                latestRevisionName: `${args.name}--revision1`,
                latestReadyRevisionName: `${args.name}--revision1`,
                latestRevisionFqdn: `${args.name}.azurecontainerapps.io`,
              }
            : {}),
        },
      };
    },
    call(args) {
      invoked.push(args.token);
      if (args.token === "azure-native:authorization:getClientConfig") {
        return {
          objectId: "publisher-object-id",
          subscriptionId: "subscription-id",
          tenantId: "tenant-id",
        };
      }
      if (args.token === "azure-native:resources:getResourceGroup") {
        return { name: args.inputs.resourceGroupName, location: "eastus" };
      }
      return args.inputs;
    },
  },
  "project",
  "stack",
  true,
);

const PULUMI_SECRET_SIG = "4dabf18193072939515e22adb298388d";
const PULUMI_SECRET_VALUE = "1b47061264138c4ac30d75fd1eb44270";

function unwrapMockSecret(value: any) {
  return value?.[PULUMI_SECRET_SIG] === PULUMI_SECRET_VALUE
    ? value.value
    : value;
}

function resolve<T>(value: pulumi.Output<T>) {
  return new Promise<T>((resolve) => {
    pulumi.all([value]).apply(([result]) => resolve(result as T));
  });
}

describe("Azure Service interface and validation", () => {
  it("normalizes equivalent Azure location labels", () => {
    expect(canonicalAzureLocation("Sweden Central")).toBe("swedencentral");
    expect(canonicalAzureLocation("West US 2")).toBe("westus2");
  });

  it("accepts Azure's default Consumption profile but rejects Dedicated profiles", () => {
    expect(
      isConsumptionOnlyWorkloadProfiles([
        { name: "Consumption", workloadProfileType: "Consumption" },
      ]),
    ).toBe(true);
    expect(
      isConsumptionOnlyWorkloadProfiles([
        { name: "Dedicated", workloadProfileType: "D4" },
      ]),
    ).toBe(false);
  });

  it("runs the minimal single-container form with AWS-compatible Docker defaults", async () => {
    const service = new Service("Single", {
      resourceGroupName: "approved-rg",
      image: {
        context: "./app",
        dockerfile: "Dockerfile",
        args: { BUILD_MARKER: "mock" },
        secrets: { BUILD_TOKEN: "hidden-build-secret" },
        tags: ["acceptance"],
        target: "runtime",
        cache: false,
      },
      environment: { API_TOKEN: "hidden-runtime-secret" },
    });
    const normalized = await resolve(service.normalized);
    expect(normalized.containers).toHaveLength(1);
    expect(normalized.containers[0]).toMatchObject({
      name: "app",
      image: { context: "./app", dockerfile: "Dockerfile" },
      cpu: 0.25,
      memory: "0.5Gi",
    });
    const imageRefs = await resolve(service.imageRefs);
    expect(imageRefs.app).toMatch(
      /\/sst\/app\/test\/single\/app@sha256:mock-digest$/,
    );
    const build = registered.find(
      (resource) =>
        resource.type === "docker-build:index:Image" &&
        resource.name === "SingleImageapp",
    )!;
    expect(build.inputs).toMatchObject({
      context: { location: path.join(testRoot, "app") },
      dockerfile: { location: path.join(testRoot, "app", "Dockerfile") },
      buildArgs: { BUILD_MARKER: "mock" },
      target: "runtime",
      platforms: ["linux/amd64"],
      push: true,
      buildOnPreview: false,
      noCache: true,
    });
    expect(build.inputs.tags).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /[a-z0-9]+\.azurecr\.io\/sst\/app\/test\/single\/app:acceptance$/,
        ),
      ]),
    );
    expect(build.inputs.secrets).toHaveProperty("BUILD_TOKEN");
    expect(
      await pulumi.isSecret(
        buildKitSecrets({ BUILD_TOKEN: "hidden-build-secret" })!,
      ),
    ).toBe(true);

    await resolve(service.containerApp!.id);
    const app = registered.find(
      (resource) =>
        resource.type === "azure-native:app:ContainerApp" &&
        resource.name === "SingleContainerApp",
    )!;
    expect(app.inputs.identity).toMatchObject({
      type: "UserAssigned",
      userAssignedIdentities: ["SingleIdentity"],
    });
    expect(app.inputs.configuration[PULUMI_SECRET_SIG]).toBe(
      PULUMI_SECRET_VALUE,
    );
    const configuration = unwrapMockSecret(app.inputs.configuration);
    expect(configuration).toMatchObject({
      activeRevisionsMode: "Single",
      registries: [
        {
          server: expect.stringMatching(/\.azurecr\.io$/),
          identity: "SingleIdentity",
        },
      ],
    });
    const template = unwrapMockSecret(app.inputs.template);
    expect(template).toMatchObject({
      scale: { minReplicas: 1, maxReplicas: 1 },
      containers: [
        {
          name: "app",
          image: imageRefs.app,
          imageType: "ContainerImage",
          resources: { cpu: 0.25, memory: "0.5Gi" },
        },
      ],
    });
    const appEnvironment = template.containers[0].env;
    expect(appEnvironment).toContainEqual({
      name: "AZURE_CLIENT_ID",
      value: "client-SingleIdentity",
    });
    expect(appEnvironment).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "SST_RESOURCE_App",
          secretRef: expect.any(String),
        }),
        expect.objectContaining({
          name: "API_TOKEN",
          secretRef: expect.any(String),
        }),
      ]),
    );
    expect(
      appEnvironment.find((variable: any) => variable.name === "API_TOKEN"),
    ).not.toHaveProperty("value");
    const environment = registered.find(
      (resource) => resource.type === "azure-native:app:ManagedEnvironment",
    )!;
    expect(environment.inputs).not.toHaveProperty("appLogsConfiguration");
    expect(environment.inputs).not.toHaveProperty("workloadProfiles");
    expect(environment.inputs).not.toHaveProperty("vnetConfiguration");
    expect(invoked).not.toContain("azure-native:app:getContainerApp");
  });

  it("runs the minimal two-container form without resources, dev, or probe props", async () => {
    const service = new Service("Multi", {
      resourceGroupName: "approved-rg",
      containers: [
        { name: "api", image: "nginx:latest" },
        { name: "sidecar", image: { context: "./sidecar" } },
      ],
    });
    const normalized = await resolve(service.normalized);
    expect(normalized.containers).toHaveLength(2);
    expect(normalized.containers.map((container) => container.name)).toEqual([
      "api",
      "sidecar",
    ]);
    expect(normalized.containers[1].image).toMatchObject({
      context: "./sidecar",
      dockerfile: "Dockerfile",
    });
    expect(
      normalized.containers.every((container) => container.cpu === 0.25),
    ).toBe(true);
    await resolve(service.containerApp!.id);
    const app = registered.find(
      (resource) =>
        resource.type === "azure-native:app:ContainerApp" &&
        resource.name === "MultiContainerApp",
    )!;
    const template = unwrapMockSecret(app.inputs.template);
    expect(template.containers).toHaveLength(2);
    expect(template.containers.map((container: any) => container.name)).toEqual(
      ["api", "sidecar"],
    );
    expect(
      template.containers.map((container: any) => container.resources),
    ).toEqual([
      { cpu: 0.25, memory: "0.5Gi" },
      { cpu: 0.25, memory: "0.5Gi" },
    ]);
    expect(template.containers[0].probes).toBeUndefined();
    expect(template.containers[1].probes).toBeUndefined();
  });

  it("uses the AWS-compatible context and Dockerfile defaults when image is omitted", () => {
    const normalized = normalizeServiceArgs({
      resourceGroupName: "approved-rg",
    });
    expect(normalized.containers[0].image).toMatchObject({
      context: ".",
      dockerfile: "Dockerfile",
    });
  });

  it("normalizes CPU and GB memory into ACA CPU and Gi fields", () => {
    expect(normalizeAllocation("0.5 vCPU", "1 GB")).toEqual({
      cpu: 0.5,
      memory: "1Gi",
      cpuUnits: 0.5,
      memoryGi: 1,
    });
    expect(normalizeAllocation(undefined, undefined)).toMatchObject({
      cpu: 0.25,
      memory: "0.5Gi",
    });
    expect(
      normalizeServiceArgs({
        resourceGroupName: "rg",
        cpu: "0.5 vCPU",
        memory: "1 GB",
      }).containers[0],
    ).toMatchObject({ cpu: 0.5, memory: "1Gi" });
  });

  it("rejects conflicting top-level and per-container settings", () => {
    expect(() =>
      assertNoMixedContainerSettings({
        resourceGroupName: "rg",
        containers: [{ name: "api" }],
        dev: false,
      }),
    ).not.toThrow();
    expect(() =>
      assertNoMixedContainerSettings({
        resourceGroupName: "rg",
        containers: [{ name: "api" }],
        dev: { url: "http://localhost:3000" },
      }),
    ).not.toThrow();

    for (const conflicting of [
      { image: "nginx" },
      { command: ["node", "server.js"] },
      { entrypoint: ["node"] },
      { environment: { MODE: "prod" } },
      { cpu: "0.5 vCPU" },
      { memory: "1 GB" },
      { dev: { command: "bun run dev" } },
    ]) {
      expect(() =>
        assertNoMixedContainerSettings({
          resourceGroupName: "rg",
          containers: [{ name: "api" }],
          ...conflicting,
        } as ServiceArgs),
      ).toThrow(/cannot combine/);
    }
  });

  it("shares one owned registry for builds and skips it for prebuilt image strings", async () => {
    const first = new Service("BuildOne", {
      resourceGroupName: "approved-rg",
      image: { context: "./one" },
    });
    const second = new Service("BuildTwo", {
      resourceGroupName: "approved-rg",
      containers: [{ name: "api", image: { context: "./two" } }],
    });
    const prebuilt = new Service("Prebuilt", {
      resourceGroupName: "approved-rg",
      image: "nginx:latest",
    });
    const dynamicPrebuilt = new Service("DynamicPrebuilt", {
      resourceGroupName: "approved-rg",
      image: pulumi.output("nginx:dynamic"),
    });
    const dynamicContainers = new Service("DynamicContainers", {
      resourceGroupName: "approved-rg",
      containers: pulumi.output([{ name: "api", image: "nginx:sidecar" }]),
    });
    const registryId = await resolve(first.registry!.id);
    await resolve(
      pulumi.all([
        second.registry!.id,
        first.registry!.publisherGrant!.id,
        ...first.identity!.grants.map((grant) => grant.id),
        ...second.identity!.grants.map((grant) => grant.id),
      ]),
    );

    expect(first.registry?.root).toBe(second.registry?.root);
    expect(prebuilt.registry).toBeUndefined();
    expect(dynamicPrebuilt.registry).toBeUndefined();
    expect(dynamicContainers.registry).toBeUndefined();
    expect(await resolve(prebuilt.imageRefs)).toEqual({ app: "nginx:latest" });
    expect(await resolve(dynamicPrebuilt.imageRefs)).toEqual({
      app: "nginx:dynamic",
    });
    expect(await resolve(dynamicContainers.imageRefs)).toEqual({
      api: "nginx:sidecar",
    });
    expect(
      registered.filter(
        (resource) =>
          resource.type === "azure-native:containerregistry:Registry",
      ),
    ).toHaveLength(1);
    expect(
      registered.filter(
        (resource) =>
          resource.type === "azure-native:authorization:RoleAssignment",
      ),
    ).toHaveLength(5);
    for (const name of ["BuildOneAcrPull", "BuildTwoAcrPull"]) {
      const pull = registered.find((resource) => resource.name === name)!;
      expect(pull.inputs).toMatchObject({
        scope: registryId,
        roleDefinitionId: ACR_PULL_ROLE_ID,
        principalType: "ServicePrincipal",
      });
    }
  });

  it("maps Blob link access modes to the exact data roles", () => {
    const writable = blob("Writable", {
      accountUrl: "https://example.blob.core.windows.net",
      containerName: "assets",
      containerId:
        "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/a/blobServices/default/containers/assets",
      access: "readWrite",
    });
    expect(writable.getSSTLink().include).toEqual([
      expect.objectContaining({
        type: "azure.permission",
        roleDefinitionId: `/providers/Microsoft.Authorization/roleDefinitions/${BLOB_DATA_CONTRIBUTOR_ROLE_ID}`,
      }),
    ]);
  });

  it("creates one scoped Blob role grant per identity and rejects escalation", async () => {
    const containerId =
      "/subscriptions/subscription-id/resourceGroups/approved-rg/providers/Microsoft.Storage/storageAccounts/example/blobServices/default/containers/assets";
    const files = blob("Files", {
      accountUrl: "https://example.blob.core.windows.net",
      containerName: "assets",
      containerId,
      access: "read",
    });
    expect(() =>
      blob("Unsafe", {
        accountUrl: "https://example.blob.core.windows.net",
        containerName: "assets",
        containerId,
        access: "Owner" as any,
      }),
    ).toThrow(/access must be "read" or "readWrite"/);
    let appDependencies: pulumi.Resource[] = [];
    const service = new Service("Linked", {
      resourceGroupName: "approved-rg",
      image: "nginx:latest",
      link: [files, files],
      transform: {
        containerApp: (_args, opts) => {
          appDependencies = (opts.dependsOn ?? []) as pulumi.Resource[];
          return undefined;
        },
      },
    });
    await resolve(
      pulumi.all(service.identity!.grants.map((grant) => grant.id)),
    );

    expect(service.identity!.grants).toHaveLength(1);
    expect(service.identity!.dependencies).toContain(
      service.identity!.resource,
    );
    expect(service.identity!.dependencies).toContain(
      service.identity!.grants[0],
    );
    expect(appDependencies).toEqual(service.identity!.dependencies);
    const grant = registered.find(
      (resource) =>
        resource.type === "azure-native:authorization:RoleAssignment" &&
        resource.name === "LinkedPermission1",
    )!;
    expect(grant.inputs).toMatchObject({
      scope: containerId,
      roleDefinitionId: `/providers/Microsoft.Authorization/roleDefinitions/${BLOB_DATA_READER_ROLE_ID}`,
      principalType: "ServicePrincipal",
    });
    expect(grant.inputs.description).toContain("linked data access");
    expect(grant.inputs.roleAssignmentName).toMatch(
      /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,
    );
    expect(files.getSSTLink().properties).toEqual({
      accountUrl: "https://example.blob.core.windows.net",
      containerName: "assets",
    });
    expect(() =>
      permission({ scope: containerId, roleDefinitionId: "Owner" }),
    ).toThrow(/only support Storage Blob Data Reader/);
    expect(() =>
      validateAzurePermissionScope({
        scope:
          "/subscriptions/other/resourceGroups/other/providers/Microsoft.Storage/storageAccounts/x",
        resourceGroupName: "approved-rg",
        subscriptionId: "subscription-id",
      }),
    ).toThrow(/inside approved resource group/);
    expect(() =>
      normalizeServiceArgs({
        resourceGroupName: "approved-rg",
        environment: { sst_resource_Files: "override" },
      }),
    ).toThrow(/reserved environment variable/);
    expect(() =>
      normalizeServiceArgs({
        resourceGroupName: "approved-rg",
        environment: { SST_DEV: "false" },
      }),
    ).toThrow(/reserved environment variable/);
    expect(() =>
      normalizeServiceArgs({
        resourceGroupName: "approved-rg",
        environment: { SST_RESOURCES_JSON: "{}" },
      }),
    ).toThrow(/reserved environment variable/);
    expect(() =>
      normalizeServiceArgs({
        resourceGroupName: "approved-rg",
        environment: { "INVALID-NAME": "value" },
      }),
    ).toThrow(/invalid environment variable name/);
    expect(() =>
      normalizeServiceArgs({
        resourceGroupName: "approved-rg",
        image: { context: 123 },
      }),
    ).toThrow(/context.*non-empty paths/);
  });

  it("maps managed HTTPS ingress, probe defaults, scaling, URL, and service links", async () => {
    const service = new Service("Ingress", {
      resourceGroupName: "approved-rg",
      image: "nginx:latest",
      ingress: { targetPort: 8080 },
      probes: {
        liveness: { type: "http", path: "/live", port: 8080 },
      },
    });
    const url = await resolve(service.url);
    const app = registered.find(
      (resource) =>
        resource.type === "azure-native:app:ContainerApp" &&
        resource.name === "IngressContainerApp",
    )!;
    const configuration = unwrapMockSecret(app.inputs.configuration);
    expect(configuration).toMatchObject({
      activeRevisionsMode: "Multiple",
      ingress: {
        external: true,
        targetPort: 8080,
        allowInsecure: false,
        transport: "auto",
        traffic: [{ latestRevision: true, weight: 100 }],
      },
    });
    const template = unwrapMockSecret(app.inputs.template);
    expect(template.scale).toMatchObject({
      minReplicas: 0,
      maxReplicas: 2,
      rules: [
        {
          name: "http-concurrency",
          http: { metadata: { concurrentRequests: "10" } },
        },
      ],
    });
    const probes = template.containers[0].probes;
    expect(probes).toHaveLength(3);
    expect(probes[0]).toMatchObject({
      type: "Startup",
      tcpSocket: { port: 8080 },
      initialDelaySeconds: 1,
      periodSeconds: 1,
      timeoutSeconds: 3,
    });
    expect(probes[0]).not.toHaveProperty("failureThreshold");
    expect(probes[1]).toMatchObject({
      type: "Readiness",
      tcpSocket: { port: 8080 },
      initialDelaySeconds: 3,
      periodSeconds: 5,
      timeoutSeconds: 5,
    });
    expect(probes[1]).not.toHaveProperty("failureThreshold");
    expect(probes[2]).toMatchObject({
      type: "Liveness",
      httpGet: { path: "/live", port: 8080, scheme: "HTTP" },
    });
    expect(url).toBe("https://IngressContainerApp.azurecontainerapps.io");
    const properties = await resolve(Link.getProperties([service]));
    expect(Object.values(properties)[0]).toMatchObject({ url });
    expect(service.nodes.containerApp).toBe(service.containerApp);
    expect(service.nodes.environment).toBe(service.environment);
    expect(service.nodes.identity).toBe(service.identity!.resource);
    expect(await resolve(service.readyRevision)).toBeUndefined();
    expect(invoked).not.toContain("azure-native:app:getContainerApp");
  });

  it("waits for the latest revision and fails closed on failed or timed-out rollouts", async () => {
    let reads = 0;
    const ready = await waitForReadyRevision({
      serviceName: "api",
      expectedRevisionName: "revision-2",
      timeoutMs: 1000,
      pollIntervalMs: 0,
      sleep: async () => {},
      reader: async () =>
        ++reads === 1
          ? {
              latestRevisionName: "revision-2",
              latestReadyRevisionName: "revision-1",
              provisioningState: "Succeeded",
            }
          : {
              latestRevisionName: "revision-2",
              latestReadyRevisionName: "revision-2",
              provisioningState: "Succeeded",
            },
    });
    expect(ready).toBe("revision-2");
    await expect(
      waitForReadyRevision({
        serviceName: "api",
        expectedRevisionName: "revision-3",
        reader: async () => ({
          latestRevisionName: "revision-3",
          latestReadyRevisionName: "revision-2",
          provisioningState: "Failed",
        }),
      }),
    ).rejects.toThrow(/failed provisioning/);
    await expect(
      waitForReadyRevision({
        serviceName: "api",
        expectedRevisionName: "revision-4",
        timeoutMs: 0,
        reader: async () => ({
          latestRevisionName: "revision-4",
          latestReadyRevisionName: "revision-2",
        }),
      }),
    ).rejects.toThrow(/did not make revision/);
  });

  it("waits for the revision created by this deployment instead of accepting the previous one", async () => {
    let reads = 0;
    const ready = await waitForReadyRevision({
      serviceName: "api",
      expectedRevisionName: "revision-2",
      timeoutMs: 1000,
      pollIntervalMs: 0,
      sleep: async () => {},
      reader: async () =>
        ++reads === 1
          ? {
              latestRevisionName: "revision-1",
              latestReadyRevisionName: "revision-1",
              provisioningState: "Succeeded",
            }
          : {
              latestRevisionName: "revision-2",
              latestReadyRevisionName: "revision-2",
              provisioningState: "Succeeded",
            },
    });
    expect(ready).toBe("revision-2");
    expect(reads).toBe(2);
  });

  it("runs only explicit DevCommands in local mode and skips all remote Service resources", async () => {
    const previousDev = (global as any).$dev;
    (global as any).$dev = true;
    const before = registered.length;
    const containerId =
      "/subscriptions/subscription-id/resourceGroups/approved-rg/providers/Microsoft.Storage/storageAccounts/example/blobServices/default/containers/assets";
    const files = blob("LocalFiles", {
      accountUrl: "https://example.blob.core.windows.net",
      containerName: "assets",
      containerId,
      access: "read",
    });
    const service = new Service("Local", {
      resourceGroupName: "approved-rg",
      image: { context: "./app" },
      environment: { MODE: "local" },
      link: [files],
      dev: {
        command: "bun run dev",
        directory: "./app",
        url: "http://localhost:3000",
      },
    });
    (global as any).$dev = previousDev;

    await resolve(service.normalized);
    await resolve(service.imageRefs);
    expect(service.registry).toBeUndefined();
    expect(service.identity).toBeUndefined();
    expect(service.environment).toBeUndefined();
    expect(service.containerApp).toBeUndefined();
    expect(await resolve(service.url)).toBe("http://localhost:3000");
    expect(await resolve(service.readyRevision)).toBeUndefined();
    expect(() => service.nodes).toThrow(/unavailable in local dev mode/);
    expect(
      registered
        .slice(before)
        .filter(
          (resource) =>
            resource.type.startsWith("azure-native:") ||
            resource.type === "docker-build:index:Image",
        ),
    ).toEqual([]);
    const command = registered.find(
      (resource) =>
        resource.type === "sst:sst:DevCommand" && resource.name === "LocalDev",
    );
    expect(command).toBeDefined();
    expect(command).toBeDefined();
    const localArgs = localDevCommandArgs(
      "Local",
      normalizeServiceArgs({
        resourceGroupName: "approved-rg",
        environment: { MODE: "local" },
        dev: {
          command: "bun run dev",
          directory: "./app",
          url: "http://localhost:3000",
        },
      }).containers[0],
      1,
      [files],
    )!;
    expect(localArgs.dev).toMatchObject({
      command: "bun run dev",
      directory: "./app",
      title: "Local",
      autostart: true,
    });
    expect(localArgs.environment).toEqual({ MODE: "local", SST_DEV: "true" });
    expect(localArgs.environment).not.toHaveProperty("AZURE_CLIENT_ID");
    expect(
      localDevCommandArgs(
        "NoCommand",
        normalizeServiceArgs({ resourceGroupName: "approved-rg" })
          .containers[0],
        1,
      ),
    ).toBeUndefined();

    const noCommandBefore = registered.length;
    (global as any).$dev = true;
    new Service("NoCommand", { resourceGroupName: "approved-rg" });
    (global as any).$dev = previousDev;
    expect(
      registered
        .slice(noCommandBefore)
        .filter((resource) => resource.type === "sst:sst:DevCommand"),
    ).toEqual([]);

    (global as any).$dev = true;
    const forcedRemote = new Service("ForcedRemote", {
      resourceGroupName: "approved-rg",
      image: "nginx:latest",
      dev: false,
    });
    await resolve(forcedRemote.containerApp!.id);
    (global as any).$dev = previousDev;
    expect(
      registered.some(
        (resource) =>
          resource.type === "azure-native:app:ContainerApp" &&
          resource.name === "ForcedRemoteContainerApp",
      ),
    ).toBe(true);
    expect(
      registered.some(
        (resource) =>
          resource.type === "sst:sst:DevCommand" &&
          resource.name === "ForcedRemoteDev",
      ),
    ).toBe(false);
  });

  it("registers one local DevCommand per explicitly configured container", async () => {
    const previousDev = (global as any).$dev;
    (global as any).$dev = true;
    const before = registered.length;
    const service = new Service("LocalMulti", {
      resourceGroupName: "approved-rg",
      containers: [
        {
          name: "api",
          image: "nginx:latest",
          dev: { command: "bun run api" },
        },
        {
          name: "worker",
          image: "nginx:latest",
          dev: { command: "bun run worker", autostart: false },
        },
        { name: "passive", image: "nginx:latest" },
      ],
      dev: { url: "http://localhost:3000" },
    });
    (global as any).$dev = previousDev;

    const normalized = await resolve(service.normalized);
    const commands = registered
      .slice(before)
      .filter((resource) => resource.type === "sst:sst:DevCommand")
      .map((resource) => resource.name);
    expect(commands).toEqual(["LocalMultiapiDev", "LocalMultiworkerDev"]);
    expect(
      localDevCommandArgs("LocalMulti", normalized.containers[1], 3)?.dev,
    ).toMatchObject({
      command: "bun run worker",
      autostart: false,
      title: "LocalMultiworker",
    });
    expect(
      registered
        .slice(before)
        .some((resource) => resource.type.startsWith("azure-native:")),
    ).toBe(false);
  });

  it("requires safe Docker ignores and never edits the caller's files", () => {
    const context = path.join(testRoot, "unsafe-context");
    fs.mkdirSync(context, { recursive: true });
    fs.writeFileSync(path.join(context, "Dockerfile"), "FROM scratch\n");
    const image = normalizeServiceArgs({
      resourceGroupName: "rg",
      image: { context: "./unsafe-context" },
    }).containers[0].image as { context: string; dockerfile: string };

    expect(() => resolveDockerContext(image, testRoot)).toThrow(
      /missing required .dockerignore exclusions/,
    );
    expect(fs.existsSync(path.join(context, ".dockerignore"))).toBe(false);

    const specificIgnore = path.join(context, "Dockerfile.dockerignore");
    fs.writeFileSync(
      specificIgnore,
      [
        ".sst",
        ".env*",
        "*.pem",
        "*.key",
        "*.p12",
        "*.pfx",
        "*.tfstate*",
        "Pulumi.*.yaml",
        "secrets/",
      ].join("\n"),
    );
    expect(resolveDockerContext(image, testRoot).ignorePath).toBe(
      specificIgnore,
    );
  });

  it("validates Container Apps allocation totals, probes, ingress, and scaling", () => {
    expect(() =>
      normalizeServiceArgs({
        resourceGroupName: "rg",
        containers: [
          { name: "one" },
          { name: "two" },
          { name: "three" },
          { name: "four" },
          { name: "five" },
          { name: "six" },
          { name: "seven" },
          { name: "eight" },
          { name: "nine" },
        ],
      }),
    ).toThrow(/exceeds the v1 per-replica limit/);

    expect(() =>
      normalizeServiceArgs({
        resourceGroupName: "rg",
        containers: [{ name: "api", probes: { readiness: { type: "exec" } } }],
      }),
    ).toThrow(/type must be "http" or "tcp"/);

    expect(() =>
      normalizeServiceArgs({
        resourceGroupName: "rg",
        image: "nginx",
        probes: {
          startup: { type: "tcp", port: 8080, initialDelaySeconds: 0 },
        },
      }),
    ).toThrow(/initialDelaySeconds must be between 1 and 60/);

    expect(() =>
      normalizeServiceArgs({
        resourceGroupName: "rg",
        containers: [{ name: "api", image: "nginx" }],
        probes: { startup: { type: "tcp", port: 8080 } },
      }),
    ).toThrow(/cannot combine "containers"/);

    expect(() =>
      normalizeServiceArgs({
        resourceGroupName: "rg",
        ingress: { targetPort: 0 },
      }),
    ).toThrow(/targetPort/);

    expect(() =>
      normalizeServiceArgs({
        resourceGroupName: "rg",
        scaling: { http: { concurrentRequests: 10 } },
      }),
    ).toThrow(/requires "ingress"/);

    expect(() =>
      normalizeServiceArgs({
        resourceGroupName: "rg",
        ingress: { targetPort: 8080 },
        scaling: { minReplicas: 3, maxReplicas: 2 },
      }),
    ).toThrow(/maxReplicas/);
  });
});
