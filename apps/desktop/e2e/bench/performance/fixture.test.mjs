import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  allocateLongTail,
  forceTargetRefusal,
  generateFixture,
  seededRandom,
  verifyFixture,
} from "./fixture.mjs";
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
    // Reading the fixture through production modules means starting a Vite dev
    // server, which sets NODE_ENV=development on this process and leaves it
    // set. The benchmark runner then spawns the renderer bench, which inherits
    // it and silently builds itself in development mode — dev React, dev JSX,
    // profiling work inside the frames it times. Two owner baselines were lost
    // to that before it was found, so the restoration is pinned here.
    const nodeEnvBefore = process.env.NODE_ENV;
    try {
      const generated = await generateFixture({
        preset: "small",
        seed: DEFAULT_SEED,
        outputDirectory: root,
        force: true,
      });
      expect(process.env.NODE_ENV).toBe(nodeEnvBefore);
      const firstDatabaseDigest = createHash("sha256")
        .update(await readFile(generated.dbPath))
        .digest("hex");
      const firstManifest = await readFile(generated.manifestPath, "utf8");
      const verified = await verifyFixture(root, { preset: "small" });
      expect(process.env.NODE_ENV).toBe(nodeEnvBefore);
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
      expect(verified.firstArtifactMessageId).toMatch(/^perf-message-\d{5}$/);
      expect(verified.decodedEventCount).toBe(PRESETS.small.sessionEvents);
      expect(verified.byteMeasurement).toBe("dbstat");
      expect(verified.databaseBytes).toBeGreaterThan(PRESETS.small.targetFileBytes * 0.99);
      expect(verified.databaseBytes).toBeLessThan(PRESETS.small.targetFileBytes * 1.01);
      expect(verified.liveBytes + verified.freePageBytes).toBe(verified.databaseBytes);
      expect(verified.freePageBytes).toBeGreaterThan(0);
      expect(verified.sessionEventBytes).toBeGreaterThan(
        PRESETS.small.targetSessionEventBytes * 0.9,
      );
      expect(verified.sessionEventBytes).toBeLessThan(PRESETS.small.targetSessionEventBytes * 1.1);
      expect(verified.largestAppStateRowBytes).toBeLessThanOrEqual(300_000);
      expect(JSON.parse(firstManifest).physicalBytes).toMatchObject({
        totalFileBytes: verified.databaseBytes,
        sessionEventsBytes: verified.sessionEventBytes,
      });
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

      const secondRoot = await mkdtemp(join(tmpdir(), "volli-performance-fixture-portable-"));
      const thirdRoot = await mkdtemp(join(tmpdir(), "volli-performance-fixture-portable-"));
      try {
        const portableFirst = await generateFixture({
          preset: "small",
          seed: DEFAULT_SEED,
          outputDirectory: secondRoot,
          force: true,
          localize: false,
        });
        const portableSecond = await generateFixture({
          preset: "small",
          seed: DEFAULT_SEED,
          outputDirectory: thirdRoot,
          force: true,
          localize: false,
        });
        expect(
          createHash("sha256")
            .update(await readFile(portableFirst.dbPath))
            .digest("hex"),
        ).toBe(
          createHash("sha256")
            .update(await readFile(portableSecond.dbPath))
            .digest("hex"),
        );
        // The digest includes SQLite's freelist pages. Keep this explicit too:
        // churn must preserve both the page layout and its reported accounting.
        expect(portableFirst.manifest.physicalBytes).toEqual(portableSecond.manifest.physicalBytes);
      } finally {
        await rm(secondRoot, { recursive: true, force: true });
        await rm(thirdRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let --force remove an arbitrary directory", async () => {
    expect(
      forceTargetRefusal({
        targetPath: "/",
        exists: true,
        isDirectory: true,
        isEmpty: false,
      }),
    ).toContain("filesystem root");
    expect(
      forceTargetRefusal({
        targetPath: "/tmp/repo",
        exists: true,
        isDirectory: true,
        hasPackageJson: true,
        homeDirectory: "/Users/tester",
        repoRoot: "/tmp/repo-root",
      }),
    ).toContain("package.json");

    const root = await mkdtemp(join(tmpdir(), "volli-performance-force-"));
    try {
      await writeFile(join(root, "package.json"), "{}\n");
      await expect(
        generateFixture({
          preset: "small",
          seed: DEFAULT_SEED,
          outputDirectory: root,
          force: true,
        }),
      ).rejects.toThrow(`Refusing --force deletion: ${root} contains package.json`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
