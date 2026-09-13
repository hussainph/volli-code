import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

import {
  CURRENT_DB_SCHEMA_VERSION,
  DEFAULT_SEED,
  FIXTURE_SCHEMA_VERSION,
  presetNamed,
} from "./presets.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..", "..", "..");
const BASE_TIME = Date.UTC(2025, 0, 15, 12, 0, 0);
const PROJECT_ID = "perf-project";
const PROJECT_PREFIX = "PERF";
const PROVENANCE = Object.freeze({
  source: { kind: "adapter", id: "pi", detail: { fixture: "vc-353" } },
  venue: { id: "local:perf", kind: "local" },
});
const STATUSES = ["backlog", "todo", "doing", "needs_review", "done"];
const PRIORITIES = ["low", "medium", "high"];
const FIXTURE_FILE = "performance-fixture.json";

function parseArgs(argv) {
  const args = { preset: "real", seed: DEFAULT_SEED, force: false, verify: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--preset") args.preset = argv[++index];
    else if (argument === "--seed") args.seed = Number(argv[++index]);
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
    "  --preset small|real|2x  fixture scale (default: real)",
    "  --seed N                deterministic seed",
    "  --output DIR            profile directory to create",
    "  --force                 replace an existing output directory",
    "  --verify                reopen and verify after generation",
  ].join("\n");
}

/** xorshift32, with no implicit platform entropy. */
export function seededRandom(seed) {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
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

function genericPayload(kindIndex, sessionIndex, attachmentId, turnId) {
  switch (kindIndex % 8) {
    case 0:
      return { kind: "run.started", attachmentId, runId: `run-${sessionIndex}-${kindIndex}` };
    case 1:
      return {
        kind: "adapter.observed",
        attachmentId,
        name: "progress",
        native: { phase: kindIndex },
      };
    case 2:
      return { kind: "turn.started", attachmentId, turnId };
    case 3:
      return {
        kind: "adapter.observed",
        attachmentId,
        name: "token.batch",
        native: { tokens: 24 },
      };
    case 4:
      return { kind: "turn.completed", attachmentId, turnId };
    case 5:
      return { kind: "run.completed", attachmentId, runId: `run-${sessionIndex}-${kindIndex - 5}` };
    case 6:
      return {
        kind: "usage.recorded",
        attachmentId,
        turnId,
        attribution: { projectId: PROJECT_ID, ticketId: null },
        usage: {
          cause: "assistant",
          providerId: "fixture",
          modelId: "benchmark-v1",
          inputTokens: 768,
          outputTokens: 192,
          cacheReadTokens: 128,
          cacheWriteTokens: 0,
          costUsd: 0.001,
          costBasis: "provider-reported",
        },
      };
    default:
      return { kind: "adapter.observed", attachmentId, name: "checkpoint", native: null };
  }
}

async function loadProductionModules() {
  const vite = await createServer({
    root: APP_DIR,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    logLevel: "error",
  });
  try {
    const load = (path) => vite.ssrLoadModule(resolve(APP_DIR, path));
    const [db, sessionControl, artifacts, shared] = await Promise.all([
      load("src/main/db/index.ts"),
      load("src/main/session-control/index.ts"),
      load("src/main/session-runtime/transcript-artifacts.ts"),
      vite.ssrLoadModule("@volli/shared"),
    ]);
    return { vite, ...db, ...sessionControl, ...artifacts, shared };
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

function createTickets(db, preset, paths) {
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
      createdAt: BASE_TIME - (preset.tickets - index) * 60_000,
      updatedAt: BASE_TIME - index * 1_000,
    });
    positions.set(status, positions.get(status) + 1);
  }
  db.prepare("UPDATE projects SET next_ticket_number = ? WHERE id = ?").run(
    preset.tickets + 1,
    PROJECT_ID,
  );
}

function createTicketEvents(db, preset) {
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
        createdAt: BASE_TIME - (ticketIndex * 10_000 + sequence),
      });
    }
  }
}

function createSessionRows(db, preset) {
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
      createdAt: BASE_TIME - (preset.sessions - index) * 30_000,
    });
  }
}

function createCommands(db, preset) {
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
        createdAt: BASE_TIME - sessionIndex * 30_000 + index,
        intent: JSON.stringify(intent),
      });
    }
  }
}

async function createEvents(db, preset, seed, artifactStore) {
  const allocation = allocateLongTail({
    count: preset.sessions,
    total: preset.sessionEvents,
    minimum: 5,
    maximum: preset.maxSessionEvents,
    seed,
  });
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
        @attachmentId, NULL, @payload)`,
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

  // One interned provenance row is enough for all synthetic events and avoids
  // inflating the fixture with repeated JSON. It is the real v42 storage shape.
  db.prepare("INSERT INTO session_provenances (id, provenance) VALUES (1, ?)").run(
    JSON.stringify(PROVENANCE),
  );
  const writeAll = db.transaction(() => {
    for (let sessionIndex = 0; sessionIndex < allocation.length; sessionIndex += 1) {
      const id = sessionId(sessionIndex);
      const attachmentId = `perf-attachment-${digits(4, sessionIndex + 1)}`;
      insertAttachment.run({
        id: attachmentId,
        sessionId: id,
        nativeId: `fixture-native-${sessionIndex + 1}`,
        nativeDetail: JSON.stringify({ fixture: true, lane: sessionIndex % 8 }),
      });
      const createdAt = BASE_TIME - (preset.sessions - sessionIndex) * 30_000;
      for (let sequence = 1; sequence <= allocation[sessionIndex]; sequence += 1) {
        let payload;
        let eventAttachment = null;
        if (sequence === 1) {
          payload = {
            kind: "command.recorded",
            command: {
              id: commandId(sessionIndex, 0),
              sessionId: id,
              createdAt,
              intent: {
                kind: "session.retitle",
                title: `Fixture Session ${digits(4, sessionIndex + 1)}`,
              },
              route: null,
            },
          };
        } else if (sequence === 2) {
          payload = {
            kind: "session.created",
            session: {
              id,
              projectId: PROJECT_ID,
              ticketId: ticketId(sessionIndex % preset.tickets),
              role: "ticket",
              parentSessionId: null,
              title:
                sessionIndex === 0
                  ? "VC-353 long chat benchmark"
                  : `Fixture Session ${digits(4, sessionIndex + 1)}`,
              createdAt,
            },
          };
        } else if (sequence === 3) {
          payload = {
            kind: "model.selected",
            selection: {
              providerId: "openai-codex",
              modelId: "gpt-5.4",
              reasoningLevel: "medium",
            },
          };
        } else if (sequence === 4) {
          payload = {
            kind: "attachment.opened",
            attachment: {
              id: attachmentId,
              sessionId: id,
              adapterId: "pi",
              venue: { id: "local:perf", kind: "local" },
              continuity: "fresh",
              native: { id: `fixture-native-${sessionIndex + 1}`, detail: { fixture: true } },
              authority: null,
            },
          };
          eventAttachment = attachmentId;
        } else if (sequence === allocation[sessionIndex]) {
          payload = { kind: "attachment.closed", attachmentId, outcome: "completed" };
          eventAttachment = attachmentId;
        } else if (sessionIndex === 0 && sequence - 5 < referenceCache.length) {
          const reference = referenceCache[sequence - 5];
          payload = {
            kind: "transcript.referenced",
            attachmentId,
            turnId: `perf-turn-${Math.floor((sequence - 5) / 2)}`,
            reference,
          };
          eventAttachment = attachmentId;
        } else {
          const turnId = `perf-turn-${sessionIndex}-${Math.floor(sequence / 8)}`;
          payload = genericPayload(sequence - 5, sessionIndex, attachmentId, turnId);
          // `usage.recorded` attribution must reflect the Session's ticket.
          if (payload.kind === "usage.recorded") {
            payload.attribution.ticketId = ticketId(sessionIndex % preset.tickets);
          }
          eventAttachment = attachmentId;
        }
        const occurredAt = createdAt + sequence;
        insertEvent.run({
          id: eventId(sessionIndex, sequence),
          sessionId: id,
          sequence,
          occurredAt,
          recordedAt: occurredAt,
          attachmentId: eventAttachment,
          payload: JSON.stringify(payload),
        });
      }
    }
  });
  writeAll();
  return allocation;
}

export async function generateFixture(input) {
  const preset = presetNamed(input.preset);
  const paths = fixturePaths(input.outputDirectory);
  if (input.force) await rm(paths.userDataDir, { recursive: true, force: true });
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
  try {
    // This is the production file-backed open/migration path by requirement —
    // never :memory:, never a copied schema.
    db = modules.openVolliDb(paths.dbPath);
    if (db.pragma("user_version", { simple: true }) !== CURRENT_DB_SCHEMA_VERSION) {
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
      paths.projectPath,
      PROJECT_PREFIX,
      BASE_TIME,
      BASE_TIME,
    );
    createTickets(db, preset, paths);
    const worktreePaths = db
      .prepare("SELECT DISTINCT worktree_path AS path FROM tickets WHERE worktree_path IS NOT NULL")
      .all()
      .map((row) => row.path);
    await Promise.all(worktreePaths.map((path) => mkdir(path, { recursive: true })));
    createTicketEvents(db, preset);
    createSessionRows(db, preset);
    createCommands(db, preset);
    const artifactStore = modules.createFileTranscriptArtifactStore(
      modules.sessionTranscriptsRoot(paths.userDataDir),
    );
    const eventAllocation = await createEvents(db, preset, input.seed, artifactStore);
    const insertAppState = db.prepare(
      "INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)",
    );
    insertAppState.run(
      "volli:projects-ui",
      JSON.stringify({ selectedProjectId: PROJECT_ID }),
      BASE_TIME,
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
      BASE_TIME,
    );
    db.pragma("wal_checkpoint(TRUNCATE)");
    const manifest = {
      schemaVersion: FIXTURE_SCHEMA_VERSION,
      preset: input.preset,
      seed: input.seed,
      generatedAt: new Date(BASE_TIME).toISOString(),
      databaseSchemaVersion: db.pragma("user_version", { simple: true }),
      projectId: PROJECT_ID,
      projectPrefix: PROJECT_PREFIX,
      longChat: {
        sessionId: sessionId(0),
        ticketId: ticketId(0),
        displayId: `${PROJECT_PREFIX}-1`,
      },
      workspaceTickets: [ticketId(0), ticketId(Math.min(1, preset.tickets - 1))],
      counts: { ...preset },
      busiestSessionEvents: Math.max(...eventAllocation),
      eventDistribution: eventDistribution(eventAllocation),
      eventAllocationSha256: createHash("sha256")
        .update(JSON.stringify(eventAllocation))
        .digest("hex"),
      warning:
        "Performance numbers are comparable only on the same machine under the same load arm.",
    };
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
    );
    return { ...paths, manifest };
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
    if (databaseSchemaVersion !== CURRENT_DB_SCHEMA_VERSION) {
      throw new Error(`expected schema ${CURRENT_DB_SCHEMA_VERSION}, got ${databaseSchemaVersion}`);
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

    // Production codecs and projection code must read the fixture, not just
    // SQLite. Decode a cross-section and fold the long Session in full.
    const ledger = modules.createSqliteSessionLedger(db);
    const engine = modules.createDesktopSessionEngine(db, {
      now: () => BASE_TIME,
      nextId: () => "verification-id-not-used",
    });
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
    const sample = await ledger.transaction((transaction) =>
      transaction.listEvents({ sessionId: sessionId(0), afterSequence: 0, limit: 20 }),
    );
    if (sample.length !== 20)
      throw new Error(`production codec read ${sample.length} sample events, expected 20`);
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
      busiestSessionEvents: busiest.count,
      longProjectionModel: longProjection.modelSelection,
      firstArtifactMessageId: artifact.message.id,
      manifestSha256: createHash("sha256")
        .update(await readFile(paths.manifestPath))
        .digest("hex"),
      databaseBytes: (await stat(paths.dbPath)).size,
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
