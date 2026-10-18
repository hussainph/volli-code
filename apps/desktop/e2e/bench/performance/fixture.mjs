import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

import { DEFAULT_SEED, FIXTURE_SCHEMA_VERSION, PRESET_NAMES, presetNamed } from "./presets.mjs";
import {
  allocateFamilyUnits,
  attachmentClosedPayload,
  attachmentOpenedPayload,
  eventsInUnits,
  modelSelectedPayload,
  orderFamilyUnits,
  sessionCreatedPayload,
  EVENT_FAMILIES,
} from "./event-mix.mjs";
import { proseBytes, seededRandom } from "./deterministic.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..", "..", "..");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/**
 * The sidebar's two age windows, as `active-session-listing.ts` defines them:
 * `ACTIVE_QUIET_WINDOW_MS` and `PREVIOUS_MAX_AGE_MS`. They are restated here
 * rather than imported because this script reads production modules through a
 * Vite SSR server that cannot evaluate the renderer's import graph (xterm is
 * CommonJS); `fixture.test.mjs` imports the renderer's own constants and fails
 * the moment the two disagree, so this is a pinned mirror, not a guess.
 */
export const SIDEBAR_WINDOWS = Object.freeze({
  activeQuietWindowMs: 30 * MINUTE,
  previousMaxAgeMs: 7 * DAY,
});
/**
 * How the captured owner profile's Sessions split across the sidebar bands, as
 * recorded in the sidebar-nesting lab scratch: 14 Active rows at the busiest
 * moment and 141 Previous rows, out of the 1,198 Sessions `real` reproduces.
 * Other presets keep the same ratios.
 */
const OWNER_BAND_SHARES = Object.freeze({ sessions: 1_198, active: 14, previous: 141 });
/**
 * Margins that keep every generated Session well clear of a band boundary, so
 * a run that starts minutes or hours after generation reads the same bands.
 * The newest Previous row is this far past the quiet window; the oldest is
 * this far inside the age bound; aged-out history starts this far past it.
 */
const BAND_MARGIN_MS = Object.freeze({ active: 2 * MINUTE, previous: 10 * MINUTE, aged: DAY });
/** How far back the aged-out history reaches, past the Previous age bound. */
const AGED_HISTORY_SPAN_MS = 112 * DAY;
const PROJECT_ID = "perf-project";
const PROJECT_PREFIX = "PERF";
const PROVENANCE = Object.freeze({
  source: { kind: "adapter", id: "pi", detail: { fixture: "vc-353" } },
  venue: { id: "local:perf", kind: "local" },
});
const STATUSES = ["backlog", "todo", "doing", "needs_review", "done"];
const PRIORITIES = ["low", "medium", "high"];
const FIXTURE_FILE = "performance-fixture.json";
const PORTABLE_ROOT = "/__volli_performance_fixture__";
const PORTABLE_PROJECT_PATH = join(PORTABLE_ROOT, "project");
const PORTABLE_WORKTREE_ROOT = join(PORTABLE_ROOT, "worktrees");

function parseArgs(argv) {
  const args = { preset: "real", seed: DEFAULT_SEED, force: false, verify: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--preset") args.preset = argv[++index];
    else if (argument === "--seed") args.seed = Number(argv[++index]);
    else if (argument === "--clock") args.clock = parseClock(argv[++index]);
    else if (argument === "--output") args.output = argv[++index];
    else if (argument === "--force") args.force = true;
    else if (argument === "--verify") args.verify = true;
    else if (argument === "--help") args.help = true;
    else throw new Error(`Unknown fixture argument ${argument}`);
  }
  if (!Number.isSafeInteger(args.seed)) throw new Error("--seed must be a safe integer");
  presetNamed(args.preset);
  return args;
}

function usage() {
  return [
    "Usage: node apps/desktop/e2e/bench/performance/fixture.mjs [options]",
    "",
    `  --preset NAME           fixture scale: ${PRESET_NAMES.join("|")} (default: real)`,
    "  --seed N                deterministic seed",
    "  --clock TIME            generation clock, ISO or epoch ms (default: now);",
    "                          with the seed, it fully determines the database",
    "  --output DIR            profile directory to create",
    "  --force                 replace an existing output directory",
    "  --verify                reopen and verify after generation",
  ].join("\n");
}

export { seededRandom } from "./deterministic.mjs";

/**
 * The generation clock: epoch milliseconds, from an ISO date or a bare integer.
 * Every fixture timestamp is relative to it, so it is part of the fixture's
 * identity the way the seed is — same seed, same clock, same database.
 */
export function parseClock(value) {
  const clock = /^\d+$/.test(String(value)) ? Number(value) : Date.parse(value);
  if (!Number.isSafeInteger(clock) || clock <= 0) {
    throw new Error(`--clock must be an ISO date or epoch milliseconds, got ${value}`);
  }
  return clock;
}

function recencySeed(seed) {
  // A stream of its own, so the recency schedule never shares a sequence with
  // the per-Session event streams (`seed + sessionIndex`).
  return Number.parseInt(
    createHash("sha256").update(`${seed}:session-recency`).digest("hex").slice(0, 8),
    16,
  );
}

/**
 * When every Session last did anything, relative to the generation clock, and
 * which sidebar band that puts it in.
 *
 * A frozen base date put all 1,198 Sessions past `PREVIOUS_MAX_AGE_MS` the day
 * it was a week old, so both bands measured empty (VC-415). The schedule is now
 * explicit: the newest `active` Sessions went quiet inside the quiet window,
 * the next `previous` Sessions (plus the long chat, which is not one of the
 * Active ones) sit between the quiet window and the age bound, skewed toward
 * recent the way a real corpus is, and the rest are aged-out history.
 *
 * The Active Sessions are also UNREAD, and that is what makes the band stable:
 * a run measures for an hour or more, and the quiet window is thirty minutes,
 * so a band held by recency alone would shrink between repetitions. An unread
 * Session never ages out of Active (`activeGroup`), which is also true of the
 * owner's profile — work finished while nobody was looking stays up.
 *
 * `stableUntil` is the first instant any band would change on the clock alone:
 * the oldest Previous row reaching the age bound.
 */
export function sessionRecencySchedule({ sessions, seed, clock, eventCounts }) {
  if (eventCounts.length !== sessions) throw new Error("one event count per Session");
  const scale = sessions / OWNER_BAND_SHARES.sessions;
  const active = Math.min(sessions - 1, Math.max(1, Math.round(OWNER_BAND_SHARES.active * scale)));
  const previous = Math.min(
    sessions - active,
    Math.max(1, Math.round(OWNER_BAND_SHARES.previous * scale)),
  );
  const agedOut = sessions - active - previous;
  const { activeQuietWindowMs, previousMaxAgeMs } = SIDEBAR_WINDOWS;
  const random = seededRandom(recencySeed(seed));
  const previousNewest = activeQuietWindowMs + BAND_MARGIN_MS.previous;
  const previousOldest = previousMaxAgeMs - BAND_MARGIN_MS.aged;
  const bandOf = (index) => {
    if (index >= sessions - active) return "active";
    // Index 0 is the long chat. It belongs to Previous: the benchmark opens it,
    // which reads it, so an unread Active long chat would make the Active count
    // depend on which interactions ran first.
    if (index === 0 || index > agedOut) return "previous";
    return "aged";
  };
  const entries = Array.from({ length: sessions }, (_value, index) => {
    const band = bandOf(index);
    let ageMs;
    if (band === "active") {
      ageMs = Math.round(random() * (activeQuietWindowMs - BAND_MARGIN_MS.active));
    } else if (band === "previous") {
      ageMs = Math.round(
        previousNewest + Math.pow(random(), 1.7) * (previousOldest - previousNewest),
      );
    } else {
      // Oldest first by index, evenly spread, so the history is a long tail
      // rather than a cliff just past the bound.
      ageMs = Math.round(
        previousMaxAgeMs +
          BAND_MARGIN_MS.aged +
          ((agedOut - index) / agedOut) * AGED_HISTORY_SPAN_MS,
      );
    }
    const lastActivityAt = clock - ageMs;
    // The fold dates a Session by its newest event, which lands `eventCounts`
    // milliseconds after creation (`occurredAt = createdAt + sequence`).
    return { band, createdAt: lastActivityAt - eventCounts[index], lastActivityAt };
  });
  const oldestPrevious = Math.min(
    ...entries.filter((entry) => entry.band === "previous").map((entry) => entry.lastActivityAt),
  );
  return {
    entries,
    earliestCreatedAt: Math.min(...entries.map((entry) => entry.createdAt)),
    summary: {
      activeQuietWindowMs,
      previousMaxAgeMs,
      sessions: { active, previous, agedOut },
      unreadSessions: active,
      stableUntil: new Date(oldestPrevious + previousMaxAgeMs).toISOString(),
    },
  };
}

/**
 * Allocate an exact count with a deterministic Pareto-like long tail and an
 * explicit busiest-session cap. Every entry gets `minimum`; index 0 gets
 * `maximum`; the residual is assigned by seeded weighted largest remainder.
 */
export function allocateLongTail({ count, total, minimum, maximum, seed }) {
  if (count < 1 || minimum < 0 || maximum < minimum) throw new Error("invalid allocation bounds");
  if (total < minimum * count || total > maximum * count) {
    throw new Error(`cannot allocate ${total} across ${count} entries in [${minimum}, ${maximum}]`);
  }
  const values = Array(count).fill(minimum);
  const first = Math.min(maximum, total - minimum * (count - 1));
  values[0] = first;
  let remaining = total - values.reduce((sum, value) => sum + value, 0);
  const random = seededRandom(seed);
  const weights = Array.from({ length: count }, (_value, index) => {
    if (index === 0) return 0;
    // Bounded Zipf weight: the population has many ordinary short histories,
    // a diminishing tail of large histories, and exactly one explicit maximum.
    // The cap prevents a second rank from tying the captured busiest Session.
    const rank = index + random();
    const tail = Math.min(16, Math.pow(count / rank, 0.72));
    return (0.5 + tail) * (0.85 + random() * 0.3);
  });

  while (remaining > 0) {
    const active = weights
      .map((weight, index) => ({ weight, index }))
      .filter(({ index }) => values[index] < maximum);
    if (active.length === 0) throw new Error("allocation exhausted its cap");
    const weightTotal = active.reduce((sum, entry) => sum + entry.weight, 0);
    const shares = active.map((entry) => {
      const room = maximum - values[entry.index];
      const raw =
        weightTotal === 0 ? remaining / active.length : (remaining * entry.weight) / weightTotal;
      const floor = Math.min(room, Math.floor(raw));
      return { index: entry.index, room, raw, floor };
    });
    let assigned = 0;
    for (const share of shares) {
      values[share.index] += share.floor;
      assigned += share.floor;
    }
    remaining -= assigned;
    if (remaining === 0) break;
    const ranked = shares
      .filter((share) => values[share.index] < maximum)
      .toSorted((left, right) => {
        const fraction = right.raw - right.floor - (left.raw - left.floor);
        return fraction || left.index - right.index;
      });
    if (ranked.length === 0) continue;
    for (const share of ranked) {
      if (remaining === 0) break;
      if (values[share.index] >= maximum) continue;
      values[share.index] += 1;
      remaining -= 1;
    }
  }
  return values;
}

function eventDistribution(values) {
  const sorted = values.toSorted((left, right) => left - right);
  const nearestRank = (quantile) => sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
  return {
    min: sorted[0],
    p50: nearestRank(0.5),
    p95: nearestRank(0.95),
    p99: nearestRank(0.99),
    max: sorted.at(-1),
    sessionsAtLeast500: sorted.filter((value) => value >= 500).length,
    sessionsAtLeast1000: sorted.filter((value) => value >= 1_000).length,
  };
}

function distributeExact(count, total) {
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from({ length: count }, (_value, index) => base + (index < remainder ? 1 : 0));
}

function digits(width, value) {
  return String(value).padStart(width, "0");
}

function sessionId(index) {
  return `perf-session-${digits(4, index + 1)}`;
}

function ticketId(index) {
  return `perf-ticket-${digits(4, index + 1)}`;
}

function eventId(sessionIndex, sequence) {
  return `perf-event-${digits(4, sessionIndex + 1)}-${digits(4, sequence)}`;
}

function commandId(sessionIndex, commandIndex) {
  return `perf-command-${digits(4, sessionIndex + 1)}-${digits(3, commandIndex + 1)}`;
}

function ticketEventId(ticketIndex, sequence) {
  return `perf-ticket-event-${digits(4, ticketIndex + 1)}-${digits(3, sequence + 1)}`;
}

function message(index, role) {
  const file = `src/features/module-${digits(3, index % 137)}.ts`;
  if (role === "user") {
    return {
      id: `perf-message-${digits(5, index + 1)}`,
      role,
      parts: [
        {
          type: "text",
          text:
            index === 0
              ? "FIRST TURN: summarize the benchmark fixture and identify the slowest interaction."
              : `Review case ${index + 1}. Preserve behavior, report evidence, and check ${file}.`,
        },
      ],
    };
  }
  const code = [
    "```ts",
    `export function sample${index}(rows: readonly number[]): number {`,
    "  return rows.reduce((sum, value) => sum + value, 0);",
    "}",
    "```",
  ].join("\n");
  const prose = `I traced the durable path through \`${file}\`. The projection stays ordered and the report keeps tail latency visible.`;
  if (index % 5 === 1) {
    return {
      id: `perf-message-${digits(5, index + 1)}`,
      role,
      parts: [
        {
          type: "dynamic-tool",
          toolName: "read",
          toolCallId: `perf-read-${digits(5, index + 1)}`,
          state: "output-available",
          input: { path: file },
          output: {
            content: `export const fixtureCase = ${index};\n// deterministic tool payload`,
          },
        },
        { type: "text", text: prose },
      ],
    };
  }
  return {
    id: `perf-message-${digits(5, index + 1)}`,
    role,
    parts: [{ type: "text", text: index % 8 === 3 ? `${prose}\n\n${code}` : prose }],
  };
}

async function loadProductionModules() {
  // Creating a Vite dev server sets `process.env.NODE_ENV = "development"` on
  // THIS process, and it stays set after the server closes. The benchmark
  // runner generates a fixture and then spawns the renderer bench, which
  // inherits the environment and quietly builds itself in development mode:
  // dev JSX, dev React, profiling instrumentation inside the frames it times.
  // That cost several hours and two invalid baselines, so the loan is repaid
  // here where it is taken rather than papered over downstream.
  const priorNodeEnv = process.env.NODE_ENV;
  const restoreNodeEnv = () => {
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
  };
  const vite = await createServer({
    root: APP_DIR,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    logLevel: "error",
  });
  restoreNodeEnv();
  try {
    const load = (path) => vite.ssrLoadModule(resolve(APP_DIR, path));
    const [db, sessionControl, sessionEngine, artifacts, shared, migrations] = await Promise.all([
      load("../../packages/host-core/src/db/index.ts"),
      load("../../packages/host-core/src/session-control/index.ts"),
      vite.ssrLoadModule("@volli/session-engine"),
      load("../../packages/host-core/src/session-runtime/transcript-artifacts.ts"),
      vite.ssrLoadModule("@volli/shared"),
      load("../../packages/host-core/src/db/migrations.ts"),
    ]);
    return {
      vite,
      ...db,
      ...sessionControl,
      ...sessionEngine,
      ...artifacts,
      shared,
      // One source of truth; adding a migration cannot stale the fixture harness.
      currentDbSchemaVersion: migrations.MIGRATIONS.at(-1).version,
    };
  } catch (error) {
    await vite.close();
    throw error;
  }
}

function fixturePaths(outputDirectory) {
  const userDataDir = resolve(outputDirectory);
  return {
    userDataDir,
    dbPath: join(userDataDir, "volli.db"),
    projectPath: join(userDataDir, "project"),
    worktreeRoot: join(userDataDir, "worktrees"),
    manifestPath: join(userDataDir, FIXTURE_FILE),
  };
}

/**
 * The force path is deliberately narrower than rm -rf. A benchmark profile is
 * disposable only when it is empty or carries our marker; a path that looks
 * like a checkout is never an acceptable typo target. Keeping this decision
 * pure makes the destructive boundary testable without touching a filesystem.
 */
export function forceTargetRefusal({
  targetPath,
  exists,
  isDirectory,
  isSymlink = false,
  isEmpty = false,
  hasFixtureMarker = false,
  hasPackageJson = false,
  hasGit = false,
  homeDirectory = homedir(),
  repoRoot = resolve(APP_DIR, "..", ".."),
}) {
  const target = resolve(targetPath);
  const home = resolve(homeDirectory);
  const repo = resolve(repoRoot);
  if (target === "/") return `${target} is the filesystem root`;
  if (target === home) return `${target} is the home directory`;
  if (target === repo) return `${target} is the repository root`;
  if (isSymlink) return `${target} is a symlink`;
  if (!exists) return null;
  if (!isDirectory) return `${target} is not a directory`;
  if (hasPackageJson || hasGit) {
    const marker = hasPackageJson ? "package.json" : ".git";
    return `${target} contains ${marker}; refusing to treat a checkout as disposable`;
  }
  if (!isEmpty && !hasFixtureMarker) {
    return `${target} is non-empty and does not contain ${FIXTURE_FILE}`;
  }
  return null;
}

async function assertSafeForceTarget(targetPath) {
  const target = resolve(targetPath);
  const targetStat = await stat(target).catch(() => null);
  const targetLink = await lstat(target).catch(() => null);
  let details = {
    targetPath: target,
    exists: targetStat !== null,
    isDirectory: targetStat?.isDirectory() ?? false,
    isSymlink: targetLink?.isSymbolicLink() ?? false,
    isEmpty: false,
    hasFixtureMarker: false,
    hasPackageJson: false,
    hasGit: false,
  };
  if (targetStat?.isDirectory()) {
    const entries = await readdir(target);
    details = {
      ...details,
      isEmpty: entries.length === 0,
      hasFixtureMarker: entries.includes(FIXTURE_FILE),
      hasPackageJson: entries.includes("package.json"),
      hasGit: entries.includes(".git"),
    };
  }
  const refusal = forceTargetRefusal(details);
  if (refusal !== null) throw new Error(`Refusing --force deletion: ${refusal}`);
}

function createTickets(db, preset, paths, timeline) {
  const insert = db.prepare(
    `INSERT INTO tickets
       (id, project_id, ticket_number, title, body, status, priority, uses_worktree,
        preferred_harness_id, position, worktree_path, branch, base_branch, pr_url,
        row_version, created_at, updated_at, archived_at, retention_keep)
     VALUES
       (@id, @projectId, @ticketNumber, @title, @body, @status, @priority, 1,
        'claude-code', @position, @worktreePath, @branch, @baseBranch, NULL,
        1, @createdAt, @updatedAt, NULL, 0)`,
  );
  const positions = new Map(STATUSES.map((status) => [status, 0]));
  for (let index = 0; index < preset.tickets; index += 1) {
    const status = STATUSES[index % STATUSES.length];
    const hasWorktree = index < preset.liveWorktrees;
    // The first N paths are shared by two tickets; the rest are unique. The
    // overlap count therefore describes paths with >1 live ticket exactly.
    const overlapIndex =
      index < preset.overlappingWorktrees * 2 ? index % preset.overlappingWorktrees : index;
    const worktreePath = hasWorktree
      ? join(paths.worktreeRoot, `checkout-${digits(3, overlapIndex + 1)}`)
      : null;
    insert.run({
      id: ticketId(index),
      projectId: PROJECT_ID,
      ticketNumber: index + 1,
      title: `Benchmark ticket ${digits(4, index + 1)}`,
      body: `Synthetic VC-353 planning record ${index + 1}. No personal or repository content.`,
      status,
      priority: PRIORITIES[index % PRIORITIES.length],
      position: positions.get(status),
      worktreePath,
      branch: hasWorktree ? `perf/ticket-${digits(4, index + 1)}` : null,
      baseBranch: hasWorktree ? "main" : null,
      // Every ticket predates every Session: the sidebar cleans away a Session
      // created before its ticket entered its current column, and with no
      // status change on record that entry is the ticket's own creation.
      createdAt: timeline.earliestCreatedAt - (preset.tickets - index) * MINUTE,
      updatedAt: timeline.clock - index * 1_000,
    });
    positions.set(status, positions.get(status) + 1);
  }
  db.prepare("UPDATE projects SET next_ticket_number = ? WHERE id = ?").run(
    preset.tickets + 1,
    PROJECT_ID,
  );
}

function createTicketEvents(db, preset, clock) {
  const allocations = distributeExact(preset.tickets, preset.ticketEvents);
  const insert = db.prepare(
    `INSERT INTO ticket_events (id, ticket_id, kind, actor, payload, created_at)
     VALUES (@id, @ticketId, @kind, 'user', @payload, @createdAt)`,
  );
  const payloads = [
    { kind: "created" },
    { kind: "title_edited" },
    { kind: "body_edited" },
    { kind: "priority_changed", from: "medium", to: "high" },
    { kind: "moved", from: "todo", to: "doing" },
  ];
  for (let ticketIndex = 0; ticketIndex < allocations.length; ticketIndex += 1) {
    for (let sequence = 0; sequence < allocations[ticketIndex]; sequence += 1) {
      const payload = payloads[sequence % payloads.length];
      insert.run({
        id: ticketEventId(ticketIndex, sequence),
        ticketId: ticketId(ticketIndex),
        kind: payload.kind,
        payload: JSON.stringify(payload),
        createdAt: clock - (ticketIndex * 10_000 + sequence),
      });
    }
  }
}

function createSessionRows(db, preset, timeline) {
  const insert = db.prepare(
    `INSERT INTO sessions (id, project_id, ticket_id, title, created_at, role, parent_session_id)
     VALUES (@id, @projectId, @ticketId, @title, @createdAt, 'ticket', NULL)`,
  );
  for (let index = 0; index < preset.sessions; index += 1) {
    insert.run({
      id: sessionId(index),
      projectId: PROJECT_ID,
      // Session 1 is the long-chat target on ticket 1. Sessions cycle across
      // every ticket so listing and workspace reads see the full cardinality.
      ticketId: ticketId(index % preset.tickets),
      title: index === 0 ? "VC-353 long chat benchmark" : `Fixture Session ${digits(4, index + 1)}`,
      createdAt: timeline.entries[index].createdAt,
    });
  }
}

function createCommands(db, preset, timeline) {
  const allocations = distributeExact(preset.sessions, preset.sessionCommands);
  const insert = db.prepare(
    `INSERT INTO session_commands (id, session_id, created_at, intent, route)
     VALUES (@id, @sessionId, @createdAt, @intent, NULL)`,
  );
  for (let sessionIndex = 0; sessionIndex < allocations.length; sessionIndex += 1) {
    for (let index = 0; index < allocations[sessionIndex]; index += 1) {
      const intent =
        index % 3 === 0
          ? { kind: "session.retitle", title: `Fixture Session ${digits(4, sessionIndex + 1)}` }
          : index % 3 === 1
            ? { kind: "session.signal", signal: "done", reason: "fixture checkpoint" }
            : {
                kind: "context.compact",
                attachmentId: `perf-attachment-${digits(4, sessionIndex + 1)}`,
                instructions: null,
              };
      insert.run({
        id: commandId(sessionIndex, index),
        sessionId: sessionId(sessionIndex),
        createdAt: timeline.entries[sessionIndex].createdAt + index,
        intent: JSON.stringify(intent),
      });
    }
  }
}

function sessionEventAllocation(preset, seed) {
  return allocateLongTail({
    count: preset.sessions,
    total: preset.sessionEvents,
    minimum: 5,
    maximum: preset.maxSessionEvents,
    seed,
  });
}

/**
 * The receipts that hold the Active band up for the length of a run; see
 * {@link sessionRecencySchedule}. Stamped from the Session's own last activity,
 * which is when the production edge (`markSessionUnread`) would have stamped it.
 */
function createReadReceipts(db, timeline) {
  const insert = db.prepare(
    "INSERT INTO session_read_receipts (session_id, unread_since) VALUES (?, ?)",
  );
  for (const [index, entry] of timeline.entries.entries()) {
    if (entry.band === "active") insert.run(sessionId(index), entry.lastActivityAt);
  }
}

async function createEvents(
  db,
  preset,
  seed,
  allocation,
  timeline,
  artifactStore,
  assertSessionEvent,
) {
  const insertAttachment = db.prepare(
    `INSERT INTO session_attachments
       (id, session_id, adapter_id, venue_id, venue_kind, continuity, native_id,
        native_detail, observed_kind, failure, created_sequence)
     VALUES (@id, @sessionId, 'pi', 'local:perf', 'local', 'fresh', @nativeId,
        @nativeDetail, 'opened', NULL, 4)`,
  );
  const insertEvent = db.prepare(
    `INSERT INTO session_events
       (id, session_id, sequence, occurred_at, recorded_at, provenance_id,
        attachment_id, command_id, payload)
     VALUES
       (@id, @sessionId, @sequence, @occurredAt, @recordedAt, 1,
        @attachmentId, @commandId, @payload)`,
  );
  const referenceCache = [];
  for (let index = 0; index < preset.transcriptMessages; index += 1) {
    referenceCache.push(
      await artifactStore.write({
        version: 1,
        threadId: "perf-thread",
        branchId: "perf-branch",
        attemptId: `perf-attempt-${Math.floor(index / 2)}`,
        turnId: `perf-turn-${Math.floor(index / 2)}`,
        message: message(index, index % 2 === 0 ? "user" : "assistant"),
      }),
    );
  }

  // Raw INSERT is intentional here: it keeps a 259k-row fixture within minutes
  // while preserving rule 2's invariant in-process. This is one writer, every
  // event passes assertSessionEvent, and each Session's sequence starts at one
  // and increases monotonically exactly as appendEvent would assign it.
  db.prepare("INSERT INTO session_provenances (id, provenance) VALUES (1, ?)").run(
    JSON.stringify(PROVENANCE),
  );
  const writeAll = db.transaction(() => {
    for (let sessionIndex = 0; sessionIndex < allocation.length; sessionIndex += 1) {
      const id = sessionId(sessionIndex);
      const attachmentId = `perf-attachment-${digits(4, sessionIndex + 1)}`;
      const ticket = ticketId(sessionIndex % preset.tickets);
      const title =
        sessionIndex === 0
          ? "VC-353 long chat benchmark"
          : `Fixture Session ${digits(4, sessionIndex + 1)}`;
      const createdAt = timeline.entries[sessionIndex].createdAt;
      insertAttachment.run({
        id: attachmentId,
        sessionId: id,
        nativeId: `fixture-native-${sessionIndex + 1}`,
        nativeDetail: JSON.stringify({ fixture: true, lane: sessionIndex % 8 }),
      });
      const middleEvents = allocation[sessionIndex] - 5;
      const familyCounts = allocateFamilyUnits(middleEvents);
      if (eventsInUnits(familyCounts) !== middleEvents) {
        throw new Error(`event mix allocated ${eventsInUnits(familyCounts)} of ${middleEvents}`);
      }
      const familyOrder = orderFamilyUnits(familyCounts, `${seed}:${sessionIndex}`);
      const random = seededRandom(seed + sessionIndex);
      const attachment = {
        id: attachmentId,
        sessionId: id,
        adapterId: "pi",
        venue: { id: "local:perf", kind: "local" },
        continuity: "fresh",
        native: { id: `fixture-native-${sessionIndex + 1}`, detail: { fixture: true } },
        authority: null,
      };
      const contextFor = (sequence, unitIndex, unitKey) => ({
        sessionId: id,
        sessionTitle: title,
        projectId: PROJECT_ID,
        ticketId: ticket,
        attachmentId,
        adapterId: "pi",
        occurredAt: createdAt + sequence,
        turnId: `perf-turn-${sessionIndex}-${Math.floor(sequence / 8)}`,
        unitIndex,
        unitKey,
        toolIds: ["read", "execute", "edit", "write"],
        pick: (size) => Math.floor(random() * size),
        uuid: (scope, name) => `perf-${scope}-${sessionIndex}-${name}`,
        body: (bytes) => proseBytes(bytes, `${seed}:${sessionIndex}:${unitKey}:${bytes}`),
        transcriptReference: (index) => referenceCache[index % referenceCache.length],
      });
      const events = [
        {
          payload: {
            kind: "command.recorded",
            command: {
              id: commandId(sessionIndex, 0),
              sessionId: id,
              createdAt,
              intent: { kind: "session.retitle", title },
              route: null,
            },
          },
          attachmentId: null,
          commandId: commandId(sessionIndex, 0),
        },
        {
          payload: sessionCreatedPayload({
            id,
            projectId: PROJECT_ID,
            ticketId: ticket,
            role: "ticket",
            parentSessionId: null,
            title,
            createdAt,
          }),
          attachmentId: null,
          commandId: null,
        },
        { payload: modelSelectedPayload(), attachmentId: null, commandId: null },
        { payload: attachmentOpenedPayload({ attachment }), attachmentId, commandId: null },
      ];
      for (const [unitIndex, familyIndex] of familyOrder.entries()) {
        const family = EVENT_FAMILIES[familyIndex];
        const built = family.build(
          contextFor(5 + unitIndex, unitIndex, `${family.id}:${unitIndex}`),
        );
        for (const item of built) events.push({ ...item, commandId: null });
      }
      events.push({
        payload: attachmentClosedPayload(attachmentId),
        attachmentId,
        commandId: null,
      });
      if (events.length !== allocation[sessionIndex]) {
        throw new Error(
          `session ${id} event mix produced ${events.length}, expected ${allocation[sessionIndex]}`,
        );
      }
      for (const [index, item] of events.entries()) {
        const sequence = index + 1;
        const occurredAt = createdAt + sequence;
        const event = {
          id: eventId(sessionIndex, sequence),
          sessionId: id,
          sequence,
          occurredAt,
          recordedAt: occurredAt,
          provenance: PROVENANCE,
          payload: item.payload,
          ...(item.attachmentId === null ? {} : { attachmentId: item.attachmentId }),
          ...(item.commandId === null ? {} : { commandId: item.commandId }),
        };
        assertSessionEvent(event, `fixture event ${event.id}`);
        insertEvent.run({
          id: event.id,
          sessionId: id,
          sequence,
          occurredAt,
          recordedAt: occurredAt,
          attachmentId: item.attachmentId ?? null,
          commandId: item.commandId ?? null,
          payload: JSON.stringify(item.payload),
        });
      }
    }
  });
  writeAll();
  return allocation;
}

/**
 * Grow the database with ordinary ticket-event rows, then delete those rows.
 * SQLite keeps the pages released by the delete on its freelist; unlike an
 * app_state blob, this exercises the same table/index allocation that a
 * long-lived database gets from churn while leaving no synthetic rows live.
 *
 * The page-count loop deliberately checks every insert near the target. That
 * makes the resulting physical size page-exact (rounded up from the byte
 * target) and keeps the allocation order deterministic for a given seed.
 */
function createChurnFreelist(db, preset, seed, pageSize, clock) {
  const targetPageCount = Math.ceil(preset.targetFileBytes / pageSize);
  if (db.pragma("page_count", { simple: true }) >= targetPageCount) return 0;

  const insert = db.prepare(
    `INSERT INTO ticket_events (id, ticket_id, kind, actor, payload, created_at)
     VALUES (@id, @ticketId, @kind, 'user', @payload, @createdAt)`,
  );
  const churnPayloads = [
    { kind: "created" },
    { kind: "title_edited", title: "Churned benchmark ticket" },
    {
      kind: "body_edited",
      body: proseBytes(3_000, `vc-353:freelist:${seed}`),
    },
    { kind: "priority_changed", from: "medium", to: "high" },
    { kind: "moved", from: "todo", to: "doing" },
  ];
  let rows = 0;
  const fill = db.transaction(() => {
    while (db.pragma("page_count", { simple: true }) < targetPageCount) {
      const payload = churnPayloads[rows % churnPayloads.length];
      insert.run({
        id: `vc-353:freelist:${seed}:${digits(8, rows + 1)}`,
        ticketId: ticketId(rows % preset.tickets),
        kind: payload.kind,
        payload: JSON.stringify(payload),
        createdAt: clock - rows,
      });
      rows += 1;
    }
  });
  fill();

  const remove = db.transaction(() => {
    db.prepare("DELETE FROM ticket_events WHERE id LIKE 'vc-353:freelist:%'").run();
  });
  remove();
  return rows;
}

function sessionEventTableBytes(db) {
  try {
    return {
      bytes: db
        .prepare(
          "SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name = 'session_events'",
        )
        .get().bytes,
      measurement: "dbstat",
    };
  } catch {
    return {
      bytes: db
        .prepare("SELECT COALESCE(SUM(length(payload)), 0) AS bytes FROM session_events")
        .get().bytes,
      measurement: "payload-plus-pages-fallback",
    };
  }
}

async function physicalDatabaseBytes(db, dbPath) {
  const pageCount = db.pragma("page_count", { simple: true });
  const pageSize = db.pragma("page_size", { simple: true });
  const freePageBytes = db.pragma("freelist_count", { simple: true }) * pageSize;
  const totalFileBytes = (await stat(dbPath)).size;
  const sessionEvents = sessionEventTableBytes(db);
  const largestAppStateRowBytes = db
    .prepare("SELECT COALESCE(MAX(length(CAST(value AS BLOB))), 0) AS bytes FROM app_state")
    .get().bytes;
  return {
    totalFileBytes,
    liveBytes: totalFileBytes - freePageBytes,
    freePageBytes,
    sessionEventsBytes: sessionEvents.bytes,
    largestAppStateRowBytes,
    pageCount,
    pageSize,
    byteMeasurement: sessionEvents.measurement,
  };
}

export async function generateFixture(input) {
  const preset = presetNamed(input.preset);
  const paths = fixturePaths(input.outputDirectory);
  // Read once and recorded in the manifest: every row is stamped relative to
  // this instant, so a fixture built now has Sessions inside the sidebar's
  // windows now, and passing the recorded clock back rebuilds it exactly.
  const clock = input.clock === undefined ? Date.now() : parseClock(input.clock);
  const eventAllocation = sessionEventAllocation(preset, input.seed);
  const recency = sessionRecencySchedule({
    sessions: preset.sessions,
    seed: input.seed,
    clock,
    eventCounts: eventAllocation,
  });
  const timeline = { clock, ...recency };
  if (input.force) {
    await assertSafeForceTarget(paths.userDataDir);
    await rm(paths.userDataDir, { recursive: true, force: true });
  }
  await mkdir(paths.userDataDir, { recursive: true });
  if (!input.force) {
    const existing = await stat(paths.dbPath).catch(() => null);
    if (existing !== null)
      throw new Error(`${paths.dbPath} already exists; pass --force to replace it`);
  }
  await Promise.all([
    mkdir(paths.projectPath, { recursive: true }),
    mkdir(paths.worktreeRoot, { recursive: true }),
  ]);

  const modules = await loadProductionModules();
  let db;
  let result;
  try {
    // This is the production file-backed open/migration path by requirement —
    // never :memory:, never a copied schema.
    db = modules.openVolliDb(paths.dbPath);
    if (db.pragma("user_version", { simple: true }) !== modules.currentDbSchemaVersion) {
      throw new Error("fresh fixture did not migrate to the current database schema");
    }
    db.pragma("synchronous = OFF");
    db.pragma("temp_store = MEMORY");
    db.prepare(
      `INSERT INTO projects
         (id, name, path, ticket_prefix, color_index, sort_order, row_version,
          created_at, updated_at, next_ticket_number, base_branch, setup_command)
       VALUES (?, ?, ?, ?, 0, 0, 1, ?, ?, 1, 'main', NULL)`,
    ).run(
      PROJECT_ID,
      "VC-353 Performance Fixture",
      PORTABLE_PROJECT_PATH,
      PROJECT_PREFIX,
      clock,
      clock,
    );
    createTickets(db, preset, { ...paths, worktreeRoot: PORTABLE_WORKTREE_ROOT }, timeline);
    createTicketEvents(db, preset, clock);
    createSessionRows(db, preset, timeline);
    createCommands(db, preset, timeline);
    const artifactStore = modules.createFileTranscriptArtifactStore(
      modules.sessionTranscriptsRoot(paths.userDataDir),
    );
    await createEvents(
      db,
      preset,
      input.seed,
      eventAllocation,
      timeline,
      artifactStore,
      modules.shared.assertSessionEvent,
    );
    createReadReceipts(db, timeline);
    const insertAppState = db.prepare(
      "INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)",
    );
    insertAppState.run(
      "volli:projects-ui",
      JSON.stringify({ selectedProjectId: PROJECT_ID }),
      clock,
    );
    const fixtureModel = {
      providerId: "openai-codex",
      modelId: "gpt-5.4",
      reasoningLevel: "medium",
    };
    insertAppState.run(
      "volli:model-access-defaults",
      JSON.stringify({
        global: fixtureModel,
        ticket: fixtureModel,
        utility: fixtureModel,
        fast: fixtureModel,
        deep: fixtureModel,
        visual: fixtureModel,
      }),
      clock,
    );
    // The 373 MB target includes 173 MB of session_events and ~200 MB the
    // fixture cannot attribute row-for-row (indexes, months of churn, deleted
    // history). The fixture reproduces the Session Event mass exactly and
    // reproduces the remaining physical file mass as free pages, which is what
    // churn actually leaves behind. It does not claim equivalent live content.
    createChurnFreelist(db, preset, input.seed, db.pragma("page_size", { simple: true }), clock);
    db.pragma("wal_checkpoint(TRUNCATE)");
    const physicalBytes = await physicalDatabaseBytes(db, paths.dbPath);
    // What the sidebar shows is the FOLDED title, not the row the generator
    // inserted: the weighted mix contains `session.retitled`, so a benchmark
    // that searched for the seeded string would hunt for a title the product
    // never renders. Ask the production projection what it will display and
    // publish that, so the runner never hard-codes a guess about the fold.
    const projectedLongChatTitle = (
      await modules
        .createSessionEngine({
          ledger: modules.createSqliteSessionLedger(db),
          clock: { now: () => clock },
          ids: { next: () => "manifest-id-not-used" },
          onProjectionCheckpointFailure: modules.createCheckpointFailureReporter(),
          yieldToHost: () => new Promise((done) => setImmediate(done)),
        })
        .getSession({ sessionId: sessionId(0) })
    )?.session?.title;
    if (typeof projectedLongChatTitle !== "string" || projectedLongChatTitle.length === 0) {
      throw new Error("long Session projection produced no title for the manifest");
    }
    const ticketTitleOf = (id) =>
      db.prepare("SELECT title FROM tickets WHERE id = ?").get(id)?.title;
    const switchTicketId = ticketId(Math.min(1, preset.tickets - 1));
    const manifest = {
      schemaVersion: FIXTURE_SCHEMA_VERSION,
      preset: input.preset,
      seed: input.seed,
      // The generation clock, to the millisecond. With the seed it is the
      // whole recipe: `--seed N --clock <generatedAt>` rebuilds this database.
      generatedAt: new Date(clock).toISOString(),
      databaseSchemaVersion: db.pragma("user_version", { simple: true }),
      projectId: PROJECT_ID,
      projectPrefix: PROJECT_PREFIX,
      longChat: {
        sessionId: sessionId(0),
        ticketId: ticketId(0),
        displayId: `${PROJECT_PREFIX}-1`,
        title: projectedLongChatTitle,
        ticketTitle: ticketTitleOf(ticketId(0)),
      },
      switchTarget: {
        ticketId: switchTicketId,
        displayId: `${PROJECT_PREFIX}-${Math.min(2, preset.tickets)}`,
        title: ticketTitleOf(switchTicketId),
      },
      workspaceTickets: [ticketId(0), switchTicketId],
      counts: { ...preset },
      // Which sidebar band each Session was generated into, at `generatedAt`,
      // and until when that holds without new input (VC-415).
      recency: recency.summary,
      busiestSessionEvents: Math.max(...eventAllocation),
      eventDistribution: eventDistribution(eventAllocation),
      eventAllocationSha256: createHash("sha256")
        .update(JSON.stringify(eventAllocation))
        .digest("hex"),
      physicalBytes: {
        totalFileBytes: physicalBytes.totalFileBytes,
        liveBytes: physicalBytes.liveBytes,
        freePageBytes: physicalBytes.freePageBytes,
        sessionEventsBytes: physicalBytes.sessionEventsBytes,
        largestAppStateRowBytes: physicalBytes.largestAppStateRowBytes,
      },
      warning:
        "Performance numbers are comparable only on the same machine under the same load arm.",
    };
    await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    result = { ...paths, manifest };
  } finally {
    db?.close();
    await modules.vite.close();
  }
  if (input.localize !== false) await localizeFixture(paths.userDataDir);
  return result;
}

/**
 * Rewrite only schema columns that migrations identify as machine paths. The
 * database is portable until this explicit step; runners that clone a profile
 * can call the same function after copying it to its destination.
 */
export async function localizeFixture(profileDirectory) {
  const paths = fixturePaths(profileDirectory);
  const modules = await loadProductionModules();
  let db;
  let worktreePaths = [];
  try {
    db = modules.openVolliDb(paths.dbPath);
    db.prepare("UPDATE projects SET path = ? WHERE path = ?").run(
      paths.projectPath,
      PORTABLE_PROJECT_PATH,
    );
    db.prepare(
      "UPDATE tickets SET worktree_path = replace(worktree_path, ?, ?) WHERE worktree_path LIKE ?",
    ).run(PORTABLE_WORKTREE_ROOT, paths.worktreeRoot, `${PORTABLE_WORKTREE_ROOT}%`);
    worktreePaths = db
      .prepare("SELECT DISTINCT worktree_path AS path FROM tickets WHERE worktree_path IS NOT NULL")
      .all()
      .map((row) => row.path);
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db?.close();
    await modules.vite.close();
  }
  await mkdir(paths.projectPath, { recursive: true });
  await mkdir(paths.worktreeRoot, { recursive: true });
  await Promise.all(worktreePaths.map((path) => mkdir(path, { recursive: true })));
  return paths;
}

function fixtureEngine(modules, ledger, clock) {
  return modules.createSessionEngine({
    ledger,
    clock: { now: () => clock },
    ids: { next: () => "verification-id-not-used" },
    onProjectionCheckpointFailure: modules.createCheckpointFailureReporter(),
    yieldToHost: () => new Promise((done) => setImmediate(done)),
  });
}

/**
 * The manifest's band claims, re-derived from the production fold at the
 * recorded clock: how old each Session's `lastActivityAt` is, and which
 * Sessions carry an unread receipt. A change to the event mix that moved a
 * Session's recency (a new kind the fold dates by, say) fails here instead of
 * quietly emptying a band again.
 */
async function verifyRecency(db, engine, manifest, clock) {
  if (manifest.recency === undefined) {
    throw new Error("fixture predates its generation clock (VC-415); regenerate it");
  }
  const { activeQuietWindowMs, previousMaxAgeMs } = manifest.recency;
  const roster = await engine.listSessions({ projectId: PROJECT_ID, scope: "all" });
  const sessions = { active: 0, previous: 0, agedOut: 0 };
  const activeIds = [];
  for (const projection of roster) {
    const age = clock - projection.lastActivityAt;
    if (age < 0) throw new Error(`${projection.session.id} is dated after the generation clock`);
    if (age < activeQuietWindowMs) {
      sessions.active += 1;
      activeIds.push(projection.session.id);
    } else if (age < previousMaxAgeMs) sessions.previous += 1;
    else sessions.agedOut += 1;
  }
  if (JSON.stringify(sessions) !== JSON.stringify(manifest.recency.sessions)) {
    throw new Error(
      `fixture recency differs: expected ${JSON.stringify(manifest.recency.sessions)}, got ${JSON.stringify(sessions)}`,
    );
  }
  const unreadIds = db
    .prepare(
      "SELECT session_id AS id FROM session_read_receipts WHERE unread_since IS NOT NULL ORDER BY session_id",
    )
    .all()
    .map((row) => row.id);
  if (JSON.stringify(unreadIds) !== JSON.stringify(activeIds.toSorted())) {
    throw new Error(
      `unread receipts ${JSON.stringify(unreadIds)} are not exactly the Active Sessions ${JSON.stringify(activeIds.toSorted())}`,
    );
  }
  return { sessions, unreadSessions: unreadIds.length, stableUntil: manifest.recency.stableUntil };
}

/**
 * Refuses a fixture whose sidebar bands no longer hold. Bands are relative to
 * the generation clock, so a reused profile drifts: past `stableUntil` its
 * oldest Previous rows have aged out, and a run against it would measure a
 * shorter band than its manifest describes.
 */
export function assertFixtureBandsCurrent(manifest, now) {
  const stableUntil = Date.parse(manifest.recency?.stableUntil ?? "");
  if (!Number.isFinite(stableUntil)) {
    throw new Error("fixture predates its generation clock (VC-415); regenerate it");
  }
  if (now >= stableUntil) {
    throw new Error(
      `fixture generated at ${manifest.generatedAt} holds its sidebar bands only until ${manifest.recency.stableUntil}; regenerate it`,
    );
  }
}

/**
 * What the sidebar is handed for this fixture, read through the production
 * listing path main serves it from: the bounded project Session listing (as
 * `volli:session-list` answers it), the board's tickets, and their column
 * entry times. No executor is bound, which is what a fresh launch sees.
 * `fixture.test.mjs` feeds this to the renderer's `buildActiveSessionListing`.
 */
export async function readFixtureSidebarInput(outputDirectory) {
  const paths = fixturePaths(outputDirectory);
  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  const clock = Date.parse(manifest.generatedAt);
  const modules = await loadProductionModules();
  let db;
  try {
    const [ticketsRepo, eventsRepo] = await Promise.all([
      modules.vite.ssrLoadModule(
        resolve(APP_DIR, "../../packages/host-core/src/db/tickets-repo.ts"),
      ),
      modules.vite.ssrLoadModule(
        resolve(APP_DIR, "../../packages/host-core/src/db/events-repo.ts"),
      ),
    ]);
    db = modules.openVolliDb(paths.dbPath);
    const engine = fixtureEngine(modules, modules.createSqliteSessionLedger(db), clock);
    const listing = modules.boundedSessionListing(
      await modules.projectSessionListing(
        {
          db,
          listSessions: (query) => engine.listSessions(query),
          liveAttachmentIds: () => new Set(),
        },
        PROJECT_ID,
      ),
    );
    return {
      clock,
      recency: manifest.recency,
      rows: listing.sessions,
      omitted: listing.omitted,
      tickets: ticketsRepo.listTicketsByProject(db, PROJECT_ID),
      statusEntries: eventsRepo.listTicketStatusEntries(db, PROJECT_ID),
    };
  } finally {
    db?.close();
    await modules.vite.close();
  }
}

function tableCount(db, table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

export async function verifyFixture(outputDirectory, expected = {}) {
  const paths = fixturePaths(outputDirectory);
  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  const preset = presetNamed(expected.preset ?? manifest.preset);
  const modules = await loadProductionModules();
  let db;
  try {
    db = modules.openVolliDb(paths.dbPath);
    const actual = {
      sessions: tableCount(db, "sessions"),
      sessionEvents: tableCount(db, "session_events"),
      tickets: tableCount(db, "tickets"),
      ticketEvents: tableCount(db, "ticket_events"),
      sessionCommands: tableCount(db, "session_commands"),
    };
    const expectedCounts = {
      sessions: preset.sessions,
      sessionEvents: preset.sessionEvents,
      tickets: preset.tickets,
      ticketEvents: preset.ticketEvents,
      sessionCommands: preset.sessionCommands,
    };
    if (JSON.stringify(actual) !== JSON.stringify(expectedCounts)) {
      throw new Error(
        `fixture counts differ: expected ${JSON.stringify(expectedCounts)}, got ${JSON.stringify(actual)}`,
      );
    }
    const databaseSchemaVersion = db.pragma("user_version", { simple: true });
    if (databaseSchemaVersion !== modules.currentDbSchemaVersion) {
      throw new Error(
        `expected schema ${modules.currentDbSchemaVersion}, got ${databaseSchemaVersion}`,
      );
    }
    const eventCounts = db
      .prepare("SELECT COUNT(*) AS count FROM session_events GROUP BY session_id")
      .all()
      .map((row) => row.count);
    const actualEventDistribution = eventDistribution(eventCounts);
    if (JSON.stringify(actualEventDistribution) !== JSON.stringify(manifest.eventDistribution)) {
      throw new Error(
        `fixture event distribution differs: expected ${JSON.stringify(manifest.eventDistribution)}, got ${JSON.stringify(actualEventDistribution)}`,
      );
    }
    const busiest = db
      .prepare(
        "SELECT session_id, COUNT(*) AS count FROM session_events GROUP BY session_id ORDER BY count DESC, session_id LIMIT 1",
      )
      .get();
    if (busiest.count !== preset.maxSessionEvents) {
      throw new Error(
        `busiest Session has ${busiest.count} events, expected ${preset.maxSessionEvents}`,
      );
    }
    const overlap = db
      .prepare(
        `SELECT COUNT(*) AS count FROM (
           SELECT worktree_path FROM tickets
            WHERE worktree_path IS NOT NULL
            GROUP BY worktree_path HAVING COUNT(*) > 1
         )`,
      )
      .get().count;
    if (overlap !== preset.overlappingWorktrees) {
      throw new Error(
        `fixture has ${overlap} overlapping worktree paths, expected ${preset.overlappingWorktrees}`,
      );
    }
    const foreignKeys = db.pragma("foreign_key_check");
    if (foreignKeys.length > 0)
      throw new Error(
        `fixture has foreign-key violations: ${JSON.stringify(foreignKeys.slice(0, 3))}`,
      );
    const largestAppStateRowBytes = db
      .prepare("SELECT COALESCE(MAX(length(CAST(value AS BLOB))), 0) AS bytes FROM app_state")
      .get().bytes;
    if (largestAppStateRowBytes > 300_000) {
      throw new Error(
        `fixture app_state row is ${largestAppStateRowBytes} bytes; expected at most 300000`,
      );
    }

    // Production codecs and projection code must read the fixture, not just
    // SQLite. Decode every payload: a sample can never prove a future schema
    // change left the other 259,855 rows readable.
    let decodedEventCount = 0;
    for (const row of db
      .prepare("SELECT id, payload FROM session_events ORDER BY rowid")
      .iterate()) {
      modules.shared.decodeSessionEventPayload(JSON.parse(row.payload), `session_events ${row.id}`);
      decodedEventCount += 1;
    }
    const clock = Date.parse(manifest.generatedAt);
    const ledger = modules.createSqliteSessionLedger(db);
    const engine = fixtureEngine(modules, ledger, clock);
    const recency = await verifyRecency(db, engine, manifest, clock);
    const projections = await engine.listSessions({
      projectId: PROJECT_ID,
      scope: "ticket",
      ticketId: ticketId(0),
    });
    const longProjection = await engine.getSession({ sessionId: sessionId(0) });
    if (projections.length < 1 || longProjection === null) {
      throw new Error("production Session projection could not read the fixture");
    }
    if (longProjection.modelSelection === null) {
      throw new Error("long Session has no model selection for an interactive composer");
    }
    // The manifest tells the benchmark which strings the UI will show. If the
    // fold stops agreeing with it — a new event kind in the mix that retitles,
    // a changed reducer — the benchmark would otherwise discover it as a
    // 30-second locator timeout several minutes into a run. Fail here instead.
    if (longProjection.session.title !== manifest.longChat.title) {
      throw new Error(
        `long Session folds to ${JSON.stringify(longProjection.session.title)} but the manifest publishes ${JSON.stringify(manifest.longChat.title)}`,
      );
    }
    for (const target of [manifest.longChat, manifest.switchTarget]) {
      const title = db
        .prepare("SELECT title FROM tickets WHERE id = ?")
        .get(target.ticketId)?.title;
      if (title !== target.title && title !== target.ticketTitle) {
        throw new Error(
          `${target.displayId} is titled ${JSON.stringify(title)} but the manifest publishes ${JSON.stringify(target.title ?? target.ticketTitle)}`,
        );
      }
    }
    const sample = await ledger.transaction((transaction) =>
      transaction.listEvents({ sessionId: sessionId(0), afterSequence: 0, limit: 20 }),
    );
    if (sample.length !== 20)
      throw new Error(`production codec read ${sample.length} sample events, expected 20`);
    if (decodedEventCount !== preset.sessionEvents) {
      throw new Error(
        `production codec decoded ${decodedEventCount} events, expected ${preset.sessionEvents}`,
      );
    }
    const artifactStore = modules.createFileTranscriptArtifactStore(
      modules.sessionTranscriptsRoot(paths.userDataDir),
    );
    const reference = db
      .prepare(
        "SELECT payload FROM session_events WHERE session_id = ? AND json_extract(payload, '$.kind') = 'transcript.referenced' ORDER BY sequence LIMIT 1",
      )
      .get(sessionId(0));
    if (reference === undefined) throw new Error("long Session has no transcript reference");
    const artifact = await artifactStore.read(JSON.parse(reference.payload).reference);
    if (artifact.version !== 1 || artifact.message?.id === undefined) {
      throw new Error("transcript artifact was not readable through the production store");
    }
    const physicalBytes = await physicalDatabaseBytes(db, paths.dbPath);
    return {
      ok: true,
      preset: manifest.preset,
      seed: manifest.seed,
      schemaVersion: databaseSchemaVersion,
      counts: actual,
      busiest,
      eventDistribution: actualEventDistribution,
      overlappingWorktrees: overlap,
      decodedSampleEvents: sample.length,
      decodedEventCount,
      busiestSessionEvents: busiest.count,
      longProjectionModel: longProjection.modelSelection,
      recency,
      firstArtifactMessageId: artifact.message.id,
      manifestSha256: createHash("sha256")
        .update(await readFile(paths.manifestPath))
        .digest("hex"),
      databaseBytes: physicalBytes.totalFileBytes,
      liveBytes: physicalBytes.liveBytes,
      freePageBytes: physicalBytes.freePageBytes,
      sessionEventBytes: physicalBytes.sessionEventsBytes,
      largestAppStateRowBytes: physicalBytes.largestAppStateRowBytes,
      byteMeasurement: physicalBytes.byteMeasurement,
      pageBytes: physicalBytes.pageCount * physicalBytes.pageSize,
      physicalBytes: {
        totalFileBytes: physicalBytes.totalFileBytes,
        liveBytes: physicalBytes.liveBytes,
        freePageBytes: physicalBytes.freePageBytes,
        sessionEventsBytes: physicalBytes.sessionEventsBytes,
        largestAppStateRowBytes: physicalBytes.largestAppStateRowBytes,
      },
    };
  } finally {
    db?.close();
    await modules.vite.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const outputDirectory = resolve(
    args.output ?? join(APP_DIR, ".performance-fixtures", `${args.preset}-seed-${args.seed}`),
  );
  const generated = await generateFixture({
    preset: args.preset,
    seed: args.seed,
    outputDirectory,
    force: args.force,
    clock: args.clock,
  });
  const verification = args.verify
    ? await verifyFixture(outputDirectory, { preset: args.preset })
    : null;
  process.stdout.write(
    `${JSON.stringify({ outputDirectory, dbPath: generated.dbPath, manifest: generated.manifest, verification }, null, 2)}\n`,
  );
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
