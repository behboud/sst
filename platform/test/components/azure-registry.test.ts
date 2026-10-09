import { describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import {
  borrowedRegistryPushPrerequisite,
  buildKitSecrets,
  getBorrowedRegistry,
  getSharedRegistry,
  hasRegistryScopedAcrPush,
  imageRegistryCredentials,
  resetSharedRegistryCache,
  serviceNeedsRegistry,
  validateBorrowedRegistry,
} from "../../src/components/azure/registry.js";
import {
  acrResourceName,
  parseRegistryResourceId,
  roleAssignmentGuid,
} from "../../src/components/azure/naming.js";

// @ts-ignore
(global as any).$app = { name: "app", stage: "test", providers: {} };

const resources: pulumi.runtime.MockResourceArgs[] = [];
const calls: pulumi.runtime.MockCallArgs[] = [];
pulumi.runtime.setMocks(
  {
    newResource(args) {
      resources.push(args);
      const id =
        args.type === "azure-native:containerregistry:Registry"
          ? `/subscriptions/subscription-id/resourceGroups/approved-rg/providers/Microsoft.ContainerRegistry/registries/${args.inputs.registryName}`
          : args.name;
      return {
        id,
        state: {
          ...args.inputs,
          id,
          name: args.inputs.registryName ?? args.name,
          loginServer: `${args.inputs.registryName ?? "registry"}.azurecr.io`,
          location: args.inputs.location ?? "eastus",
        },
      };
    },
    call(args) {
      calls.push(args);
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
      if (
        args.token === "azure-native:containerregistry:getRegistry" &&
        args.inputs.registryName !== "borrowed"
      ) {
        return {};
      }
      if (args.token === "azure-native:containerregistry:getRegistry") {
        return {
          id: "/subscriptions/subscription-id/resourceGroups/approved-rg/providers/Microsoft.ContainerRegistry/registries/borrowed",
          name: "borrowed",
          location: "eastus",
          loginServer: "borrowed.azurecr.io",
          adminUserEnabled: false,
          policies: { azureADAuthenticationAsArmPolicy: { status: "enabled" } },
          provisioningState: "Succeeded",
          sku: { name: "Basic" },
          systemData: {},
          status: {},
        };
      }
      return args.inputs;
    },
  },
  "project",
  "stack",
  false,
);

function resolve<T>(value: pulumi.Output<T>) {
  return new Promise<T>((resolve) => {
    pulumi.all([value]).apply(([result]) => resolve(result as T));
  });
}

describe("Azure registry ownership", () => {
  it("creates one stage-owned ACR and one publisher grant shared by services", async () => {
    resetSharedRegistryCache();
    resources.length = 0;
    const request = {
      app: "my-app",
      stage: "test",
      resourceGroupName: "approved-rg",
    };
    const serviceA = getSharedRegistry(request);
    const serviceB = getSharedRegistry(request);
    const [idA, idB] = await resolve(
      pulumi.all([serviceA.id, serviceB.id, serviceA.publisherGrant!.id]),
    );

    expect(idA).toBe(idB);
    expect(serviceA.root).toBe(serviceB.root);
    expect(serviceA.root?.urn).toBeDefined();
    expect(
      resources.filter(
        (resource) =>
          resource.type === "azure-native:containerregistry:Registry",
      ),
    ).toHaveLength(1);
    const grants = resources.filter(
      (resource) =>
        resource.type === "azure-native:authorization:RoleAssignment",
    );
    expect(grants).toHaveLength(1);
    expect(grants[0].inputs).toMatchObject({
      principalId: "publisher-object-id",
      principalType: "User",
      scope: idA,
      roleDefinitionId:
        "/providers/Microsoft.Authorization/roleDefinitions/8311e382-0749-4cb8-b61a-304f252e45ec",
    });
    expect(grants[0].name).toBe("AzureRegistry-PublisherPush");

    let previewReads = 0;
    const previewCredentials = await resolve(
      imageRegistryCredentials(
        serviceA,
        async () => {
          previewReads++;
          return { username: "user", password: "should-not-run" };
        },
        true,
      ),
    );
    expect(previewCredentials).toEqual([]);
    expect(previewReads).toBe(0);

    let tokenSequence = 0;
    const reader = async () => ({
      username: "00000000-0000-0000-0000-000000000000",
      password: `fresh-token-${++tokenSequence}`,
    });
    const credentialOutput = imageRegistryCredentials(serviceA, reader, false);
    const nestedPasswordSecret = credentialOutput.apply(([credential]) =>
      pulumi.output(credential.password),
    );
    expect(await pulumi.isSecret(nestedPasswordSecret)).toBe(true);
    expect(
      await pulumi.isSecret(buildKitSecrets({ TOKEN: "secret-value" })!),
    ).toBe(true);
    const [credentialOne] = await resolve(credentialOutput);
    const [credentialTwo] = await resolve(
      imageRegistryCredentials(serviceA, reader, false),
    );
    expect(credentialOne.username).toBe("00000000-0000-0000-0000-000000000000");
    expect(tokenSequence).toBe(2);
    expect(credentialOne.password).not.toBe(credentialTwo.password);
  });

  it("does not create a registry for prebuilt image strings", () => {
    expect(serviceNeedsRegistry({ image: "nginx:latest" })).toBe(false);
    expect(
      serviceNeedsRegistry({
        containers: [
          { name: "api", image: "nginx:latest" },
          { name: "sidecar", image: "redis:latest" },
        ],
      }),
    ).toBe(false);
    expect(serviceNeedsRegistry({ image: { context: "./app" } })).toBe(true);
    expect(serviceNeedsRegistry({})).toBe(true);
  });

  it("borrows an ACR without owning it or writing role assignments or policy", async () => {
    const before = resources.length;
    const borrowed = getBorrowedRegistry({
      app: "my-app",
      stage: "test",
      resourceGroupName: "approved-rg",
      id: "/subscriptions/subscription-id/resourceGroups/approved-rg/providers/Microsoft.ContainerRegistry/registries/borrowed",
    });
    await resolve(borrowed.validation);

    expect(borrowed.owned).toBe(false);
    expect(resources.slice(before)).toHaveLength(0);
    expect(
      calls.some(
        (call) => call.token === "azure-native:containerregistry:getRegistry",
      ),
    ).toBe(true);
  });

  it("requires borrowed AcrPush at the exact registry scope", () => {
    const registryId =
      "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.ContainerRegistry/registries/acr";
    const roleDefinitionId =
      "/providers/Microsoft.Authorization/roleDefinitions/8311e382-0749-4cb8-b61a-304f252e45ec";
    expect(
      hasRegistryScopedAcrPush(
        [{ roleDefinitionId, scope: `${registryId}/repositories/app` }],
        registryId,
      ),
    ).toBe(false);
    expect(
      hasRegistryScopedAcrPush(
        [{ roleDefinitionId, scope: "/subscriptions/sub/resourceGroups/rg" }],
        registryId,
      ),
    ).toBe(false);
    expect(
      hasRegistryScopedAcrPush(
        [{ roleDefinitionId, scope: registryId.toUpperCase() }],
        registryId,
      ),
    ).toBe(true);
  });

  it("rejects borrowed ABAC/admin-auth registries and names missing push access", () => {
    const base = {
      id: "/subscriptions/subscription-id/resourceGroups/approved-rg/providers/Microsoft.ContainerRegistry/registries/borrowed",
      resourceGroupName: "approved-rg",
      subscriptionId: "subscription-id",
      metadata: {
        id: "/subscriptions/subscription-id/resourceGroups/approved-rg/providers/Microsoft.ContainerRegistry/registries/borrowed",
        name: "borrowed",
        adminUserEnabled: false,
        policies: { azureADAuthenticationAsArmPolicy: { status: "enabled" } },
      },
    };
    expect(() => validateBorrowedRegistry(base)).not.toThrow();
    expect(() =>
      validateBorrowedRegistry({
        ...base,
        metadata: {
          ...base.metadata,
          policies: {
            azureAdAuthenticationAsArmPolicy: { status: "enabled" },
          },
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateBorrowedRegistry({
        ...base,
        metadata: {
          ...base.metadata,
          roleAssignmentMode: "AbacRepositoryPermissions",
        },
      }),
    ).toThrow(/ABAC repository permissions are not supported/);
    expect(() =>
      validateBorrowedRegistry({
        ...base,
        metadata: { ...base.metadata, adminUserEnabled: true },
      }),
    ).toThrow(/admin authentication disabled/);
    expect(borrowedRegistryPushPrerequisite("borrowed").message).toMatch(
      /AcrPush/,
    );
  });

  it("derives stable names and assignment IDs from all ownership inputs", () => {
    const name = acrResourceName({
      app: "my-app",
      stage: "dev",
      resourceGroupName: "approved-rg",
      subscriptionId: "subscription-id",
    });
    expect(name).toMatch(/^[a-z0-9]{5,50}$/);
    expect(
      acrResourceName({
        app: "my-app",
        stage: "dev",
        resourceGroupName: "another-rg",
        subscriptionId: "subscription-id",
      }),
    ).not.toBe(name);
    const assignment = {
      principalId: "principal-a",
      scope:
        "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.ContainerRegistry/registries/acr",
      roleDefinitionId: "role-id",
    };
    expect(roleAssignmentGuid(assignment)).toBe(roleAssignmentGuid(assignment));
    expect(
      roleAssignmentGuid({ ...assignment, principalId: "principal-b" }),
    ).not.toBe(roleAssignmentGuid(assignment));
    expect(
      parseRegistryResourceId(
        assignment.scope.replace("/resourceGroups/rg", "/resourceGroups/rg"),
      ),
    ).toMatchObject({
      subscriptionId: "sub",
      resourceGroupName: "rg",
      registryName: "acr",
    });
  });
});
