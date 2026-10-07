import { HOST_BASE_OPERATIONS, HOST_FEATURE_OPERATIONS } from "@volli/host-protocol";
import { CATALOG_ENTRIES, DESKTOP_ENTRIES } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import type { ProcedureSchema } from "./index";
import { generateProtocolSchema } from "./protocol-schema";

const sample: Record<string, ProcedureSchema> = {
  read: {
    type: "query",
    input: z.string(),
    output: z.string(),
    noInput: false,
    voidOutput: false,
    outputValidation: "network-and-tests",
  },
};

describe("committed protocol schema projection", () => {
  it("publishes every public entry with both z.toJSONSchema directions", () => {
    const document = generateProtocolSchema();
    expect(document.features).toEqual(HOST_FEATURE_OPERATIONS);
    expect(document.baseOperations).toEqual(HOST_BASE_OPERATIONS);
    for (const operation of [
      ...document.baseOperations,
      ...Object.values(document.features).flat(),
    ]) {
      expect(Object.hasOwn(document.tiers.public!, operation)).toBe(true);
    }
    expect(Object.keys(document.tiers.public!).toSorted()).toEqual(
      CATALOG_ENTRIES.map(({ key }) => key).toSorted(),
    );
    for (const entry of Object.values(document.tiers.public!)) {
      expect(entry).toMatchObject({
        input: { $schema: expect.any(String) },
        output: { $schema: expect.any(String) },
      });
    }
    for (const key of ["session.snapshot", "session.projection", "session.command"]) {
      expect(document.tiers.public![key]).toMatchObject({ outputValidation: "network-and-tests" });
    }
    expect(document.tiers.public!["session.subscribe"]).toMatchObject({
      outputValidation: "documented-yield",
    });
    expect(document.tiers.public!["sessions.create"]).toMatchObject({
      outputValidation: "legacy-documentation",
    });
    expect(document.tiers.public!["settings.experiments"]).toMatchObject({ noInput: true });
    expect(document.tiers.public!["session.reconcile"]).toMatchObject({ voidOutput: true });
  });

  it("includes desktop-only providers without demanding public registry rows", () => {
    expect(
      generateProtocolSchema(
        [{ tier: "desktop", procedures: () => sample }],
        [],
        [{ key: "read", compatibility: "host-command" }],
      ).tiers.desktop!.read,
    ).toMatchObject({
      compatibility: "host-command",
      kind: "query",
      input: { type: "string" },
      output: { type: "string" },
    });
  });

  it("publishes exactly the declared desktop-only entries", () => {
    const document = generateProtocolSchema();
    for (const entry of DESKTOP_ENTRIES) {
      expect(document.tiers.desktop![entry.key]).toMatchObject({
        compatibility: entry.compatibility,
      });
      expect(document.tiers.public![entry.key]).toBeUndefined();
    }
    for (const entry of Object.values(document.tiers.public!)) {
      expect(entry).not.toHaveProperty("compatibility");
    }
    expect(Object.keys(document.tiers.desktop!).toSorted()).toEqual(
      DESKTOP_ENTRIES.map(({ key }) => key).toSorted(),
    );
    expect(() =>
      generateProtocolSchema([{ tier: "desktop", procedures: () => sample }], [], []),
    ).toThrow("Schema/desktop-tier mismatch: missing ; extra read");
    expect(() =>
      generateProtocolSchema([], [], [{ key: "read", compatibility: "host-command" }]),
    ).toThrow("Schema/desktop-tier mismatch: missing read; extra");
  });

  it("refuses incomplete or duplicate providers and unpublishable schemas", () => {
    expect(() => generateProtocolSchema([])).toThrow("Schema/catalog mismatch: missing");
    expect(() =>
      generateProtocolSchema([{ tier: "public", procedures: () => sample }], []),
    ).toThrow("extra read");
    expect(() =>
      generateProtocolSchema(
        [
          { tier: "desktop", procedures: () => sample },
          { tier: "desktop", procedures: () => sample },
        ],
        [],
        [{ key: "read", compatibility: "host-command" }],
      ),
    ).toThrow("Duplicate schema provider");
    expect(() =>
      generateProtocolSchema(
        [
          {
            tier: "desktop",
            procedures: () => ({ opaque: { ...sample.read!, output: z.custom() } }),
          },
        ],
        [],
        [{ key: "opaque", compatibility: "host-command" }],
      ),
    ).toThrow("Custom types cannot be represented");
  });
});
