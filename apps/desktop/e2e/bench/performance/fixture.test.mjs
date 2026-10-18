import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  allocateLongTail,
  assertFixtureBandsCurrent,
  forceTargetRefusal,
  generateFixture,
  parseClock,
  readFixtureSidebarInput,
  seededRandom,
  sessionRecencySchedule,
  verifyFixture,
} from "./fixture.mjs";
import { DEFAULT_SEED, PRESETS } from "./presets.mjs";
import { MIGRATIONS } from "@volli/host-core/db";
import { buildActiveSessionListing } from "../../../src/renderer/src/components/sidebar/active-session-listing.ts";
import * as bandWindows from "../../../src/renderer/src/components/sidebar/session-band-windows.ts";
import { unreadSessionIds } from "../../../src/renderer/src/stores/project-sessions.ts";

const { ACTIVE_QUIET_WINDOW_MS, PREVIOUS_MAX_AGE_MS } = bandWindows;

const CURRENT_DB_SCHEMA_VERSION = MIGRATIONS.at(-1).version;
/** A recorded generation clock, so the byte-for-byte determinism check has one. */
const FIXTURE_CLOCK = Date.UTC(2026, 8, 13, 12, 0, 0);
const HOUR = 60 * 60_000;

/** The Session id a listing row answers to, whichever shape it arrived in. */
const idOf = (row) => (row.kind === "terminal" ? row.record.id : row.record.sessionId);

/**
 * The sidebar's two bands for this fixture at `now`, built by the renderer's
 * own `buildActiveSessionListing` from the rows main serves. The rows are
 * split the way `project-sessions.ts` stores them on refresh (terminal
 * records, chat records, the sparse read map), and unread is read back through
 * the store's own `unreadSessionIds`.
 */
function sidebarBands(input, now) {
  const rows = {
    terminal: input.rows.flatMap((row) => (row.kind === "terminal" ? [row.record] : [])),
    chat: input.rows.flatMap((row) => (row.kind === "chat" ? [row.record] : [])),
    provenance: {},
    read: Object.fromEntries(
      input.rows.flatMap((row) => (row.read === undefined ? [] : [[idOf(row), row.read]])),
    ),
  };
  const listing = buildActiveSessionListing({
    tickets: input.tickets,
    containers: {},
    signalsByTicket: {},
    records: rows.terminal,
    chatSessions: rows.chat,
    lastOutputAt: {},
    parkState: {},
    harness: {},
    statusEnteredAt: new Map(input.statusEntries.map((entry) => [entry.ticketId, entry.enteredAt])),
    unreadSessionIds: unreadSessionIds(rows),
    now,
  });
  return { active: listing.active.length, previous: listing.previous.length };
}

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

describe("performance fixture recency", () => {
  it("puts the real preset's Sessions in both bands, clear of every boundary", () => {
    const eventCounts = allocateLongTail({
      count: PRESETS.real.sessions,
      total: PRESETS.real.sessionEvents,
      minimum: 5,
      maximum: PRESETS.real.maxSessionEvents,
      seed: DEFAULT_SEED,
    });
    const input = {
      sessions: PRESETS.real.sessions,
      tickets: PRESETS.real.tickets,
      seed: DEFAULT_SEED,
      clock: FIXTURE_CLOCK,
      eventCounts,
      windows: bandWindows,
    };
    const schedule = sessionRecencySchedule(input);
    expect(sessionRecencySchedule(input)).toEqual(schedule);
    expect(schedule.summary.sessions).toEqual({ active: 14, previous: 141, agedOut: 1043 });
    expect(schedule.summary.unreadSessions).toBe(14);
    // The long chat is opened by the benchmark, so it must not be an Active
    // (unread) row whose presence depends on interaction order.
    expect(schedule.entries[0].band).toBe("previous");
    // Every Previous Session renders: none sits on a Done ticket, which the
    // sidebar would clean away an hour after it landed in Done. Tickets are
    // dealt round-robin over five columns, Done last.
    const previousIndexes = schedule.entries.flatMap((entry, index) =>
      entry.band === "previous" ? [index] : [],
    );
    expect(previousIndexes).toHaveLength(141);
    expect(previousIndexes.filter((index) => (index % PRESETS.real.tickets) % 5 === 4)).toEqual([]);
    expect(() => sessionRecencySchedule({ ...input, windows: {} })).toThrow("windows are missing");

    const ages = (band) =>
      schedule.entries
        .filter((entry) => entry.band === band)
        .map((entry) => FIXTURE_CLOCK - entry.lastActivityAt);
    expect(Math.max(...ages("active"))).toBeLessThan(ACTIVE_QUIET_WINDOW_MS);
    expect(Math.min(...ages("active"))).toBeGreaterThanOrEqual(0);
    expect(Math.min(...ages("previous"))).toBeGreaterThan(ACTIVE_QUIET_WINDOW_MS);
    expect(Math.max(...ages("previous"))).toBeLessThan(PREVIOUS_MAX_AGE_MS);
    expect(Math.min(...ages("aged"))).toBeGreaterThan(PREVIOUS_MAX_AGE_MS);
    for (const [index, entry] of schedule.entries.entries()) {
      expect(entry.lastActivityAt - entry.createdAt).toBe(eventCounts[index]);
    }
    // A run several hours long must not cross a band boundary.
    expect(Date.parse(schedule.summary.stableUntil) - FIXTURE_CLOCK).toBeGreaterThan(12 * HOUR);

    // The clock moves every stamp and nothing else.
    const later = sessionRecencySchedule({ ...input, clock: FIXTURE_CLOCK + HOUR });
    expect(later.entries.map((entry) => entry.lastActivityAt - HOUR)).toEqual(
      schedule.entries.map((entry) => entry.lastActivityAt),
    );
    expect(later.summary.sessions).toEqual(schedule.summary.sessions);
  });

  it("reads a recorded clock back and refuses a fixture whose bands have drifted", () => {
    expect(parseClock("2026-09-13T12:00:00.000Z")).toBe(FIXTURE_CLOCK);
    expect(parseClock(String(FIXTURE_CLOCK))).toBe(FIXTURE_CLOCK);
    expect(() => parseClock("yesterday")).toThrow("--clock must be");

    const manifest = {
      generatedAt: new Date(FIXTURE_CLOCK).toISOString(),
      recency: { stableUntil: new Date(FIXTURE_CLOCK + 24 * HOUR).toISOString() },
    };
    expect(() => assertFixtureBandsCurrent(manifest, FIXTURE_CLOCK + HOUR)).not.toThrow();
    expect(() => assertFixtureBandsCurrent(manifest, FIXTURE_CLOCK + 24 * HOUR)).toThrow(
      "regenerate it",
    );
    // Current at the start is not enough: the bands must last the whole run.
    expect(() => assertFixtureBandsCurrent(manifest, FIXTURE_CLOCK + 20 * HOUR, 5 * HOUR)).toThrow(
      "300 min margin",
    );
    expect(() => assertFixtureBandsCurrent({ generatedAt: "2025-01-15" }, FIXTURE_CLOCK)).toThrow(
      "predates its generation clock",
    );
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
      // The default clock is "now"; the manifest records it, and the rebuild
      // below proves that record is the whole recipe.
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
        recency: {
          activeQuietWindowMs: ACTIVE_QUIET_WINDOW_MS,
          previousMaxAgeMs: PREVIOUS_MAX_AGE_MS,
          sessions: { active: 1, previous: 14, agedOut: 105 },
          unreadSessions: 1,
        },
      });
      // Verification re-derives the split from the production fold.
      expect(verified.recency.sessions).toEqual({ active: 1, previous: 14, agedOut: 105 });

      // VC-415's acceptance, through the renderer's own band builder over the
      // rows main serves: both bands hold Sessions, and they hold the SAME
      // Sessions for as long as a run could take, because Active is held by
      // unread receipts rather than by a thirty-minute window.
      const sidebarInput = await readFixtureSidebarInput(root);
      const clock = Date.parse(generated.manifest.generatedAt);
      expect(sidebarInput.clock).toBe(clock);
      const atGeneration = sidebarBands(sidebarInput, clock);
      // Exactly the manifest's counts: every scheduled Previous Session renders.
      expect(atGeneration).toEqual({ active: 1, previous: 14 });
      const stableUntil = Date.parse(sidebarInput.recency.stableUntil);
      expect(sidebarBands(sidebarInput, clock + 2 * HOUR)).toEqual(atGeneration);
      expect(sidebarBands(sidebarInput, stableUntil - 1)).toEqual(atGeneration);
      expect(sidebarBands(sidebarInput, stableUntil).previous).toBeLessThan(atGeneration.previous);

      // Replacing the same output with the same seed and the manifest's
      // recorded clock reproduces both durable database bytes and its
      // path-bearing manifest exactly.
      const regenerated = await generateFixture({
        preset: "small",
        seed: DEFAULT_SEED,
        outputDirectory: root,
        force: true,
        clock: generated.manifest.generatedAt,
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
          clock: FIXTURE_CLOCK,
          localize: false,
        });
        const portableSecond = await generateFixture({
          preset: "small",
          seed: DEFAULT_SEED,
          outputDirectory: thirdRoot,
          force: true,
          clock: FIXTURE_CLOCK,
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
