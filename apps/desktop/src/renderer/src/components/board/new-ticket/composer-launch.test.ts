import { describe, expect, it } from "vite-plus/test";
import type { Automation } from "@volli/shared";
import { composerLaunchAction, type ComposerLaunch } from "./composer-launch";

const automation: Automation = {
  id: "a1",
  projectId: "p1",
  name: "Review",
  instructions: "Review the changes",
  trigger: { kind: "none" },
  runtime: null,
  createdAt: 1,
  updatedAt: 1,
};
const offer = {
  ready: true,
  groups: [
    { status: "any" as const, label: "Any column", current: false, automations: [automation] },
  ],
};
const selected: ComposerLaunch = { kind: "automation", projectId: "p1", automationId: "a1" };

describe("the selected creation action", () => {
  it.each(["create", "kickoff"] as const)(
    "does not need an automation catalogue for %s",
    (kind) => {
      expect(composerLaunchAction({ kind }, "p1", { ready: false, groups: [] })).toEqual({
        label: kind === "create" ? "Create ticket" : "Create & start",
        available: true,
        automation: null,
      });
    },
  );
  it("uses the current saved record, not an instruction or runtime override", () => {
    expect(composerLaunchAction(selected, "p1", offer)).toEqual({
      label: "Create & run: Review",
      available: true,
      automation,
    });
    const renamed = { ...automation, name: "Review boundaries" };
    expect(
      composerLaunchAction(selected, "p1", {
        ...offer,
        groups: [{ ...offer.groups[0]!, automations: [renamed] }],
      }).label,
    ).toBe("Create & run: Review boundaries");
  });
  it("refuses another project's selection even if the id is in the catalogue", () => {
    expect(composerLaunchAction(selected, "p2", offer).available).toBe(false);
  });
  it("blocks a cached record until the catalogue finishes reading", () => {
    expect(composerLaunchAction(selected, "p1", { ...offer, ready: false })).toEqual({
      label: "Create & run",
      available: false,
      automation: null,
    });
  });
  it("blocks a removed record instead of falling back to a different kind of start", () => {
    expect(composerLaunchAction(selected, "p1", { ready: true, groups: [] }).available).toBe(false);
  });
});
