import { describe, expect, it } from "vite-plus/test";
import {
  composerRunnerChoice,
  composerRunnerStatus,
  modelsOnRunner,
  type ComposerRunner,
} from "./runner-picker-model";
import type { ModelAccessModel } from "@volli/shared";

const mac: ComposerRunner = {
  id: "mac",
  name: "My Mac",
  kind: "mac",
  status: "online",
  statusChangedAt: 1,
  providers: ["anthropic"],
  version: "0.3.0",
  upgradeRequired: false,
};
const box: ComposerRunner = {
  ...mac,
  id: "box",
  name: "Build box",
  kind: "linux",
  providers: ["openai"],
  power: { source: "ac", alwaysOn: true },
};

describe("composer runner choice", () => {
  it("uses the backend's online AC/always-on preference ahead of this Mac", () => {
    expect(
      composerRunnerChoice({ runners: [mac, box], defaultRunnerId: "box" }, "mac", null),
    ).toEqual(box);
  });
  it("otherwise falls back to this Mac, then the first online runner", () => {
    const view = { runners: [box, mac], defaultRunnerId: null };
    expect(composerRunnerChoice(view, "mac", null)).toEqual(mac);
    expect(composerRunnerChoice(view, null, null)).toEqual(box);
  });
  it("retains an explicit sleeping choice rather than silently moving its work", () => {
    const asleep = { ...mac, status: "asleep" };
    expect(
      composerRunnerChoice({ runners: [asleep, box], defaultRunnerId: "box" }, "mac", "mac"),
    ).toEqual(asleep);
    expect(composerRunnerStatus(asleep)).toBe("Waiting for My Mac");
  });
  it.each(["revoked", "removed", "upgrade_required"])(
    "ignores a %s remembered runner",
    (status) => {
      expect(
        composerRunnerChoice(
          { runners: [{ ...box, status }, mac], defaultRunnerId: null },
          "mac",
          "box",
        ),
      ).toEqual(mac);
    },
  );
  it("does not select a runner that needs an update or an offline backend default", () => {
    expect(
      composerRunnerChoice(
        { runners: [{ ...box, upgradeRequired: true }], defaultRunnerId: "box" },
        null,
        "box",
      ),
    ).toBeNull();
    expect(
      composerRunnerChoice(
        { runners: [{ ...box, status: "offline" }, mac], defaultRunnerId: "box" },
        "mac",
        null,
      ),
    ).toEqual(mac);
    expect(composerRunnerStatus({ ...box, upgradeRequired: true })).toBe("Needs an update");
  });
  it("returns no choice when nothing can receive a new Session", () => {
    expect(composerRunnerChoice({ runners: [], defaultRunnerId: null }, null, "gone")).toBeNull();
  });
  it("filters by the selected box's providers, not this Mac's credentials", () => {
    const models = [
      { providerId: "openai", modelId: "remote", state: "signed-out" },
      { providerId: "anthropic", modelId: "local", state: "available" },
    ] as ModelAccessModel[];
    expect(modelsOnRunner(models, box)).toEqual([{ ...models[0], state: "available" }]);
  });
});
