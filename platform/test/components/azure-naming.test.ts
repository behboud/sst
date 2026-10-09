import { describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { Component } from "../../src/components/component.js";
import {
  containerAppName,
  managedEnvironmentName,
  roleAssignmentGuid,
  userAssignedIdentityName,
} from "../../src/components/azure/naming.js";

// Provider modules read these globals during import, as they do in sst.config.ts.
// @ts-ignore
(global as any).$app = { name: "app", stage: "test", providers: {} };

class NamingResource extends pulumi.CustomResource {
  constructor(
    type: string,
    name: string,
    props: Record<string, unknown>,
    opts: pulumi.CustomResourceOptions,
  ) {
    super(type, name, props, opts);
  }
}

const resources: pulumi.runtime.MockResourceArgs[] = [];
pulumi.runtime.setMocks(
  {
    newResource(args) {
      resources.push(args);
      return { id: args.name, state: args.inputs };
    },
    call(args) {
      return args.inputs;
    },
  },
  "project",
  "stack",
  false,
);

describe("Azure namespace and Component naming", () => {
  it("exports Azure without requiring an Azure provider configuration", async () => {
    const components = await import("../../src/components/index.js");
    expect(components.azure).toBeDefined();
    expect(components.azure.permission).toBeTypeOf("function");
    expect(components.azure.blob).toBeTypeOf("function");
    expect(components.aws).toBeDefined();
  });

  it("creates valid stable names for managed environments and container apps", () => {
    const environment = managedEnvironmentName({
      app: "my-app",
      stage: "test",
      resourceGroupName: "approved-rg",
      subscriptionId: "subscription-id",
    });
    expect(environment).toMatch(/^[a-z0-9]{3,60}$/);
    expect(
      managedEnvironmentName({
        app: "my-app",
        stage: "test",
        resourceGroupName: "approved-rg",
        subscriptionId: "subscription-id",
      }),
    ).toBe(environment);
    expect(
      managedEnvironmentName({
        app: "my-app",
        stage: "test",
        resourceGroupName: "another-rg",
        subscriptionId: "subscription-id",
      }),
    ).not.toBe(environment);

    const appName = containerAppName({
      app: "my-app",
      stage: "test",
      service: "api",
    });
    expect(appName).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/);
    expect(appName.length).toBeLessThanOrEqual(32);
  });

  it("creates stable identity names and principal-specific role assignment UUIDs", () => {
    const identityName = userAssignedIdentityName({
      app: "my-app",
      stage: "test",
      service: "api",
    });
    expect(identityName).toMatch(/^sst-[a-z0-9-]+-[a-f0-9]{12}$/);
    expect(
      userAssignedIdentityName({
        app: "my-app",
        stage: "test",
        service: "api",
      }),
    ).toBe(identityName);

    const input = {
      principalId: "principal-one",
      scope:
        "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/store",
      roleDefinitionId:
        "/providers/Microsoft.Authorization/roleDefinitions/reader",
    };
    const first = roleAssignmentGuid(input);
    expect(first).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
    expect(
      roleAssignmentGuid({ ...input, principalId: "principal-replaced" }),
    ).not.toBe(first);
    expect(roleAssignmentGuid({ ...input, scope: `${input.scope}/` })).toBe(
      first,
    );
  });

  it("accepts only the Azure Native resource types used by the Service", () => {
    const parent = new Component("sst:azure:Service", "AzureService");

    expect(
      () =>
        new NamingResource(
          "azure-native:resources:ResourceGroup",
          "AzureService-Group",
          { name: "existing-rg" },
          { parent },
        ),
    ).not.toThrow();

    expect(
      () =>
        new NamingResource(
          "azure-native:storage:UnreviewedResource",
          "AzureService-Unreviewed",
          { name: "unreviewed" },
          { parent },
        ),
    ).toThrow(/physical name.*not prefixed/);

    expect(
      () =>
        new NamingResource(
          "azure-native:containerregistry:Registry",
          "AzureService-ValidRegistry",
          { registryName: "sstvalidregistry1" },
          { parent },
        ),
    ).not.toThrow();
    expect(
      () =>
        new NamingResource(
          "azure-native:containerregistry:Registry",
          "AzureService-InvalidRegistry",
          { registryName: "not-valid" },
          { parent },
        ),
    ).toThrow(/Invalid Azure physical name/);
    expect(
      () =>
        new NamingResource(
          "azure-native:managedidentity:UserAssignedIdentity",
          "AzureService-InvalidIdentity",
          { resourceName: "bad name" },
          { parent },
        ),
    ).toThrow(/Invalid Azure physical name/);
    expect(
      () =>
        new NamingResource(
          "azure-native:app:ContainerApp",
          "AzureService-InvalidApp",
          { containerAppName: "UpperCase" },
          { parent },
        ),
    ).toThrow(/Invalid Azure physical name/);
    expect(
      () =>
        new NamingResource(
          "azure-native:authorization:RoleAssignment",
          "AzureService-InvalidAssignment",
          { roleAssignmentName: "not-a-guid" },
          { parent },
        ),
    ).toThrow(/Invalid Azure physical name/);
  });
});
