import { describe, expect, it } from "vite-plus/test";

import { decideUpdate, type PolicyInputs, type UpdateTarget } from "./policy";

const target = (
  patch: Partial<UpdateTarget> = {},
  auto: Partial<UpdateTarget["autoUpdate"]> = {},
) => ({
  targetVersion: "0.4.0",
  minVersion: "0.3.0",
  ...patch,
  autoUpdate: { enabled: true, channel: "stable", pinnedVersion: null, ...auto },
});

const decide = (patch: Partial<PolicyInputs>) =>
  decideUpdate({
    running: "0.3.5",
    target: target(),
    now: null,
    supervised: true,
    bad: [],
    ...patch,
  });

describe("the update policy", () => {
  it("never updates an unsupervised runner", () => {
    expect(decide({ supervised: false })).toEqual({ kind: "none", why: "unsupervised" });
  });

  it("follows the target with auto-update on, waiting for idle", () => {
    expect(decide({})).toEqual({
      kind: "update",
      version: "0.4.0",
      reason: "target",
      urgent: false,
    });
  });

  it("stays put with auto-update off, unless pinned or below the floor", () => {
    expect(decide({ target: target({}, { enabled: false }) })).toEqual({
      kind: "none",
      why: "auto-update is off",
    });
    expect(decide({ target: target({}, { enabled: false, pinnedVersion: "0.4.0" }) })).toEqual({
      kind: "update",
      version: "0.4.0",
      reason: "pin",
      urgent: true,
    });
    expect(decide({ running: "0.2.9", target: target({}, { enabled: false }) })).toEqual({
      kind: "update",
      version: "0.4.0",
      reason: "floor",
      urgent: true,
    });
  });

  it("ignores a pin that is not the target", () => {
    expect(decide({ target: target({}, { enabled: false, pinnedVersion: "0.3.9" }) }).kind).toBe(
      "none",
    );
  });

  it("never downgrades, and waits for a target", () => {
    expect(decide({ running: "0.4.0" })).toEqual({ kind: "none", why: "up to date" });
    expect(decide({ running: "0.5.0" })).toEqual({ kind: "none", why: "up to date" });
    expect(decide({ target: target({ targetVersion: null }) })).toEqual({
      kind: "none",
      why: "up to date",
    });
    expect(decide({ target: null })).toEqual({ kind: "none", why: "no target yet" });
    expect(decide({ target: target({ minVersion: null }) }).kind).toBe("update");
  });

  it("skips a release that failed here, unless --now --to names it", () => {
    expect(decide({ bad: ["0.4.0"] })).toEqual({
      kind: "none",
      why: "release 0.4.0 failed here before",
    });
    expect(decide({ bad: ["0.4.0"], now: { v: 1, version: "0.4.0", at: "x" } })).toMatchObject({
      kind: "update",
      reason: "now",
    });
  });

  it("takes update --now to the target or a named version", () => {
    const now = { v: 1 as const, version: null, at: "x" };
    expect(decide({ now, target: target({}, { enabled: false }) })).toEqual({
      kind: "update",
      version: "0.4.0",
      reason: "now",
      urgent: true,
    });
    expect(decide({ now: { ...now, version: "0.4.1" }, target: null })).toEqual({
      kind: "update",
      version: "0.4.1",
      reason: "now",
      urgent: true,
    });
    // A `--now` that is not newer falls through to the ordinary policy.
    expect(decide({ now: { ...now, version: "0.3.0" } }).kind).toBe("update");
    expect(decide({ now, target: null })).toEqual({ kind: "none", why: "no target yet" });
  });
});
