import { describe, expect, test } from "bun:test";
import { isActionGranted, missingActions } from "./preflight.mjs";

describe("Azure effective-action evaluation", () => {
  test("matches Azure wildcard permissions case-insensitively", () => {
    expect(
      isActionGranted(
        [{ actions: ["Microsoft.App/*/write"], notActions: [] }],
        "microsoft.app/containerApps/write",
      ),
    ).toBe(true);
  });

  test("applies notActions to the permission block that declares them", () => {
    const blocks = [
      {
        actions: ["Microsoft.*/*"],
        notActions: ["Microsoft.Authorization/roleAssignments/write"],
      },
    ];
    expect(isActionGranted(blocks, "Microsoft.App/containerApps/write")).toBe(
      true,
    );
    expect(
      isActionGranted(blocks, "Microsoft.Authorization/roleAssignments/write"),
    ).toBe(false);
  });

  test("a separate grant can supply an action excluded by another role", () => {
    const blocks = [
      {
        actions: ["*"],
        notActions: ["Microsoft.Authorization/roleAssignments/write"],
      },
      {
        actions: ["Microsoft.Authorization/roleAssignments/write"],
        notActions: [],
      },
    ];
    expect(
      isActionGranted(blocks, "Microsoft.Authorization/roleAssignments/write"),
    ).toBe(true);
  });

  test("returns each missing action so preflight can fail closed", () => {
    expect(
      missingActions(
        [{ actions: ["*/read"], notActions: [] }],
        ["Microsoft.App/containerApps/write", "Microsoft.Resources/a/read"],
      ),
    ).toEqual(["Microsoft.App/containerApps/write"]);
  });
});
