import { describe, expect, it } from "vite-plus/test";
import {
  EXPERIMENTS,
  parseExperimentEnvironment,
  readStoredExperiments,
  requireExperimentId,
  resolveExperiments,
  serializeExperimentUpdate,
  type ExperimentBuildKind,
} from "./experiments";

describe("experimental registry", () => {
  it("ships cloud dark with host scope and one warning", () => {
    expect(EXPERIMENTS).toEqual([
      {
        id: "cloud",
        label: "Volli Cloud (unstable)",
        description:
          "Before enabling unstable cloud features, read the cloud threat model at https://github.com/hussainph/volli-code/blob/main/SECURITY.md#cloud-threat-model.",
        default: false,
        scope: "host",
        availableOn: ["dev", "canary", "stable"],
      },
    ]);
    expect(Object.isFrozen(EXPERIMENTS)).toBe(true);
    expect(Object.isFrozen(EXPERIMENTS[0])).toBe(true);
    expect(resolveExperiments({}, [], "dev")).toEqual({
      cloud: { enabled: false, source: "default" },
    });
  });

  it("keeps cloud off by default on stable and honours only the stored choice there", () => {
    expect(resolveExperiments({}, [], "stable")).toEqual({
      cloud: { enabled: false, source: "default" },
    });
    expect(resolveExperiments({}, ["cloud"], "stable")).toEqual({
      cloud: { enabled: false, source: "default" },
    });
    expect(resolveExperiments({ cloud: false }, ["cloud"], "stable")).toEqual({
      cloud: { enabled: false, source: "storage" },
    });
    for (const kind of ["dev", "canary", "stable"] as const) {
      expect(resolveExperiments({ cloud: true }, [], kind)).toEqual({
        cloud: { enabled: true, source: "storage" },
      });
    }
  });

  it("hides a flag on a build kind its registry entry does not list", () => {
    // Every registered flag lists dev, canary and stable today; an unlisted
    // kind stands in for a future build-limited flag.
    const unlisted = "unlisted" as unknown as ExperimentBuildKind;
    expect(resolveExperiments({ cloud: true }, [], unlisted)).toEqual({
      cloud: { enabled: false, source: "default", visible: false },
    });
    expect(resolveExperiments({}, ["cloud"], unlisted)).toEqual({
      cloud: { enabled: true, source: "environment" },
    });
  });

  it("rejects unknown ids, including inherited object names, at runtime", () => {
    expect(requireExperimentId("cloud")).toBe("cloud");
    for (const id of ["other", "Cloud", "constructor", "__proto__", undefined, 1]) {
      expect(() => requireExperimentId(id)).toThrow("Unknown experiment");
    }
  });

  it("reads case-insensitive, trimmed, deduplicated opt-ins and reports unknown env ids", () => {
    expect(parseExperimentEnvironment(undefined)).toEqual({ ids: [], unknownIds: [] });
    expect(parseExperimentEnvironment("")).toEqual({ ids: [], unknownIds: [] });
    expect(parseExperimentEnvironment(" cloud, ,Cloud ")).toEqual({
      ids: ["cloud"],
      unknownIds: [],
    });
    expect(parseExperimentEnvironment("Cloud")).toEqual({ ids: ["cloud"], unknownIds: [] });
    expect(parseExperimentEnvironment("cloud,retired-flag")).toEqual({
      ids: ["cloud"],
      unknownIds: ["retired-flag"],
    });
    expect(parseExperimentEnvironment(" retired-flag, RETIRED-FLAG,other ")).toEqual({
      ids: [],
      unknownIds: ["retired-flag", "other"],
    });
  });

  it("ignores stored unknown ids without losing known settings", () => {
    expect(readStoredExperiments('{"cloud":true,"future":true}')).toEqual({ cloud: true });
    expect(readStoredExperiments('{"future":true}')).toEqual({});
    expect(readStoredExperiments('{"cloud":false}')).toEqual({ cloud: false });
  });

  it("defaults safely for corrupt JSON, shapes and known values", () => {
    for (const raw of [
      undefined,
      "",
      "{",
      "null",
      "true",
      "1",
      '"cloud"',
      "[]",
      '{"cloud":"true"}',
      '{"cloud":null}',
      "{}",
    ]) {
      expect(readStoredExperiments(raw)).toEqual({});
      expect(resolveExperiments(readStoredExperiments(raw), [], "dev").cloud.enabled).toBe(false);
    }
  });

  it("preserves unknown stored keys on write but rejects unknown commands", () => {
    expect(
      JSON.parse(serializeExperimentUpdate('{"future":true,"cloud":false}', "cloud", true)),
    ).toEqual({ future: true, cloud: true });
    expect(serializeExperimentUpdate("{", "cloud", false)).toBe('{"cloud":false}');
    // @ts-expect-error Unknown ids are not writable, even if read tolerantly.
    expect(() => serializeExperimentUpdate(undefined, "future", true)).toThrow(
      "Unknown experiment",
    );
    // @ts-expect-error Runtime callers must supply a literal boolean too.
    expect(() => serializeExperimentUpdate(undefined, "cloud", "yes")).toThrow("must be a boolean");
  });

  it("environment wins over false storage without becoming stored intent", () => {
    expect(resolveExperiments({ cloud: true }, [], "dev").cloud).toEqual({
      enabled: true,
      source: "storage",
    });
    expect(resolveExperiments({ cloud: false }, [], "dev").cloud).toEqual({
      enabled: false,
      source: "storage",
    });
    expect(resolveExperiments({ cloud: false }, ["cloud"], "dev").cloud).toEqual({
      enabled: true,
      source: "environment",
    });
    expect(resolveExperiments({}, ["cloud"], "dev").cloud).toEqual({
      enabled: true,
      source: "environment",
    });
  });
});
