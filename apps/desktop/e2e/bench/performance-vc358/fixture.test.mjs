import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { allocateLongTail, generateFixture, seededRandom, verifyFixture } from "./fixture.mjs";
import { CURRENT_DB_SCHEMA_VERSION, DEFAULT_SEED, PRESETS } from "./presets.mjs";

describe("performance fixture allocation", () => {
  it("is deterministic, exact, bounded, and long-tailed", () => {
    const input = {
      count: PRESETS.real.sessions,
      total: PRESETS.real.sessionEvents,
      minimum: 5,
      maximum: PRESETS.real.maxSessionEvents,
      seed: DEFAULT_SEED,
    };
    const first = allocateLongTail(input);
    const second = allocateLongTail(input);
    expect(first).toEqual(second);
    expect(first.reduce((sum, value) => sum + value, 0)).toBe(PRESETS.real.sessionEvents);
    expect(Math.max(...first)).toBe(PRESETS.real.maxSessionEvents);
    expect(Math.min(...first)).toBeGreaterThanOrEqual(5);
    expect(first.filter((value) => value >= 500).length).toBeLessThan(first.length / 10);
    expect(first.filter((value) => value >= 1_000)).toHaveLength(21);
    expect(createHash("sha256").update(JSON.stringify(first)).digest("hex")).toBe(
      "84d22f15804957ee175d11b948cda35a9f7fca5ca79a63d8e6f19fbaa5d9e753",
    );
  });

  it("uses only the supplied seed", () => {
    expect(Array.from({ length: 5 }, seededRandom(353))).toEqual(
      Array.from({ length: 5 }, seededRandom(353)),
    );
    expect(seededRandom(353)()).not.toBe(seededRandom(354)());
  });
});

describe("performance fixture file", () => {
  it("migrates a file database and is readable through production codecs and artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "volli-performance-fixture-test-"));
    try {
      const generated = await generateFixture({
        preset: "small",
        seed: DEFAULT_SEED,
        outputDirectory: root,
        force: true,
      });
      const firstDatabaseDigest = createHash("sha256")
        .update(await readFile(generated.dbPath))
        .digest("hex");
      const firstManifest = await readFile(generated.manifestPath, "utf8");
      const verified = await verifyFixture(root, { preset: "small" });
      expect(verified.ok).toBe(true);
      expect(verified.schemaVersion).toBe(CURRENT_DB_SCHEMA_VERSION);
      expect(verified.counts).toEqual({
        sessions: PRESETS.small.sessions,
        sessionEvents: PRESETS.small.sessionEvents,
        tickets: PRESETS.small.tickets,
        ticketEvents: PRESETS.small.ticketEvents,
        sessionCommands: PRESETS.small.sessionCommands,
      });
      expect(verified.busiest).toMatchObject({
        session_id: generated.manifest.longChat.sessionId,
        count: PRESETS.small.maxSessionEvents,
      });
      expect(verified.eventDistribution).toEqual({
        min: 92,
        p50: 143,
        p95: 613,
        p99: 1191,
        max: PRESETS.small.maxSessionEvents,
        sessionsAtLeast500: 9,
        sessionsAtLeast1000: 3,
      });
      expect(verified.overlappingWorktrees).toBe(PRESETS.small.overlappingWorktrees);
      expect(verified.decodedSampleEvents).toBe(20);
      expect(verified.firstArtifactMessageId).toBe("perf-message-00001");
      expect(JSON.parse(firstManifest)).toMatchObject({
        preset: "small",
        seed: DEFAULT_SEED,
        databaseSchemaVersion: CURRENT_DB_SCHEMA_VERSION,
      });

      // Replacing the same output with the same seed reproduces both durable
      // database bytes and its path-bearing manifest exactly.
      const regenerated = await generateFixture({
        preset: "small",
        seed: DEFAULT_SEED,
        outputDirectory: root,
        force: true,
      });
      expect(
        createHash("sha256")
          .update(await readFile(regenerated.dbPath))
          .digest("hex"),
      ).toBe(firstDatabaseDigest);
      expect(await readFile(regenerated.manifestPath, "utf8")).toBe(firstManifest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
