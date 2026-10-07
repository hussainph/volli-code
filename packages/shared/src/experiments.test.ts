import { describe, expect, it } from "vite-plus/test";
import {
  EXPERIMENTS,
  parseExperimentEnvironment,
  readStoredExperiments,
  requireExperimentId,
  resolveExperiments,
  serializeExperimentUpdate,
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
      },
    ]);
    expect(Object.isFrozen(EXPERIMENTS)).toBe(true);
    expect(Object.isFrozen(EXPERIMENTS[0])).toBe(true);
    expect(resolveExperiments({}, [])).toEqual({ cloud: { enabled: false, source: "default" } });
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
      expect(resolveExperiments(readStoredExperiments(raw), []).cloud.enabled).toBe(false);
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
    expect(resolveExperiments({ cloud: true }, []).cloud).toEqual({
      enabled: true,
      source: "storage",
    });
    expect(resolveExperiments({ cloud: false }, []).cloud).toEqual({
      enabled: false,
      source: "storage",
    });
    expect(resolveExperiments({ cloud: false }, ["cloud"]).cloud).toEqual({
      enabled: true,
      source: "environment",
    });
    expect(resolveExperiments({}, ["cloud"]).cloud).toEqual({
      enabled: true,
      source: "environment",
    });
  });
});
