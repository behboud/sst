/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app() {
    return {
      name: "azure-service",
      home: "local",
      // Keep sample resources on stack removal instead of deleting Azure resources implicitly.
      removal: "retain",
    };
  },
  async run() {
    const { createHash } = await import("node:crypto");
    const resources = await import("@pulumi/azure-native/resources/index.js");
    const storage = await import("@pulumi/azure-native/storage/index.js");
    function storageAccountName(
      app: string,
      stage: string,
      resourceGroupId: string,
    ) {
      const stem = `${app}${stage}`.toLowerCase().replace(/[^a-z0-9]/g, "");
      const hash = createHash("sha256")
        .update(`${resourceGroupId.toLowerCase()}|${app}|${stage}`)
        .digest("hex")
        .slice(0, 12);
      return `s${stem.slice(0, 11) || "sst"}${hash}`;
    }

    const resourceGroupName = process.env.AZURE_RESOURCE_GROUP;
    if (!resourceGroupName) {
      throw new Error(
        "Set AZURE_RESOURCE_GROUP to an existing Azure Resource Group.",
      );
    }

    const resourceGroup = resources.getResourceGroupOutput({
      resourceGroupName,
    });
    const accountName = resourceGroup.id.apply((id) =>
      storageAccountName($app.name, $app.stage, id),
    );
    const account = new storage.StorageAccount("ExampleStorage", {
      accountName,
      resourceGroupName,
      location: resourceGroup.location,
      kind: "StorageV2",
      sku: { name: "Standard_LRS" },
      accessTier: "Hot",
      allowBlobPublicAccess: false,
      allowSharedKeyAccess: false,
      defaultToOAuthAuthentication: true,
      enableHttpsTrafficOnly: true,
      minimumTlsVersion: "TLS1_2",
      publicNetworkAccess: "Enabled",
      tags: {
        "sst:app": $app.name,
        "sst:stage": $app.stage,
        "sst:owner": "azure-service-example",
      },
    });
    const container = new storage.BlobContainer("ExampleData", {
      accountName: account.name,
      resourceGroupName,
      containerName: "sst-data",
      defaultEncryptionScope: "$account-encryption-key",
      denyEncryptionScopeOverride: false,
      publicAccess: "None",
    });
    // Deliberately ungranted control container for the cross-scope RBAC check.
    new storage.BlobContainer("ScopeProbe", {
      accountName: account.name,
      resourceGroupName,
      containerName: "sst-scope-probe",
      defaultEncryptionScope: "$account-encryption-key",
      denyEncryptionScopeOverride: false,
      publicAccess: "None",
    });

    const data = sst.azure.blob("Data", {
      accountUrl: account.primaryEndpoints.apply((endpoints) => endpoints.blob),
      containerName: "sst-data",
      containerId: container.id,
      access: "read",
    });
    const buildMarker = process.env.BUILD_MARKER ?? "initial";
    const devUrl = "http://localhost:3000";

    const service = new sst.azure.Service("Api", {
      resourceGroupName,
      containers: [
        {
          name: "api",
          image: {
            context: "./workload",
            args: { BUILD_MARKER: buildMarker },
          },
          cpu: "0.25 vCPU",
          memory: "0.5 GB",
          environment: {
            SIDECAR_URL: "http://127.0.0.1:8081",
            ...(process.env.SST_PROBE_TEST_TOGGLES === "true"
              ? { SST_PROBE_TEST_TOGGLES: "true" }
              : {}),
            ...(process.env.SST_FORCE_UNREADY === "true"
              ? { SST_FORCE_UNREADY: "true" }
              : {}),
          },
          probes: {
            readiness: {
              type: "http",
              path: "/ready",
              port: 3000,
            },
            liveness: {
              type: "http",
              path: "/live",
              port: 3000,
            },
          },
          dev: {
            command: "bun --watch src/api.ts",
            directory: "./workload",
          },
        },
        {
          name: "sidecar",
          image: {
            context: "./workload",
            dockerfile: "Dockerfile.sidecar",
            args: { BUILD_MARKER: buildMarker },
          },
          cpu: "0.25 vCPU",
          memory: "0.5 GB",
          dev: {
            command: "bun --watch src/sidecar.ts",
            directory: "./workload",
          },
        },
      ],
      link: [data],
      ingress: { targetPort: 3000 },
      scaling: {
        minReplicas: 0,
        maxReplicas: 2,
        http: { concurrentRequests: 10 },
      },
      dev: { url: devUrl },
    });
    return {
      storageAccountName: account.name,
      blobContainerName: container.name,
      serviceUrl: service.url,
    };
  },
});
