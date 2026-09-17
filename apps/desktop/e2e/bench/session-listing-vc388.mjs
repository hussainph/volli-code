#!/usr/bin/env node
/**
 * VC-388: what a project's roster costs to list, and what the two caches are
 * worth. VC-392 extended it past `listSessions()` to the whole IPC handler,
 * because the fold is not the only block in it.
 *
 * Unlike `session-rpc-sqlite-bench.mjs`, this one needs no existing database:
 * the roster is built through the production engine, so every event, receipt
 * and checkpoint row takes the same path the app writes.
 *
 * The number that matters is not the total. It is `eventLoopMaxMs` — the
 * longest single stretch the host could not run a timer, answer IPC or paint.
 * A listing that takes longer overall but never blocks for more than a frame
 * is the better one, which is the whole trade this ticket is about.
 *
 *   node --expose-gc apps/desktop/e2e/bench/session-listing-vc388.mjs
 *   node --expose-gc apps/desktop/e2e/bench/session-listing-vc388.mjs --sessions 120 --events 200
 *   node --expose-gc apps/desktop/e2e/bench/session-listing-vc388.mjs --tickets 12 --ticket-events 200
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";

import { createServer } from "vite";
import helpers from "./session-rpc/helpers.cjs";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "..", "..", "..", "..");

const SESSION_COUNT = helpers.parsePositiveInteger("sessions", 60);
const EVENTS_PER_SESSION = helpers.parsePositiveInteger("events", 150);
const REPEATS = helpers.parsePositiveInteger("repeats", 5);
/**
 * How many Tickets the roster is spread over, and how much unrelated history
 * each of them carries (VC-392). Both matter to the provenance tail and to
 * nothing else in this file: the `session_started` lookup is an index seek on
 * `ticket_events_ticket (ticket_id, created_at)` followed by a `json_extract`
 * comparison over every event of that Ticket, so the per-Session read pays for
 * the Ticket's whole timeline once per Session on it.
 */
const TICKET_COUNT = helpers.parsePositiveInteger("tickets", 8);
const TICKET_EVENTS_PER_TICKET = helpers.parsePositiveInteger("ticket-events", 60);
const PROJECT_ID = "project-bench";

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const mb = (bytes) => bytes / 1024 / 1024;

/** What the IPC handler hands the provenance read: one query per Session row. */
const queriesFor = (sessions) =>
  sessions.map((session) => ({
    sessionId: session.session.id,
    ticketId: session.session.ticketId,
  }));

/**
 * Runs `operation` while watching the event loop, so a fold that never yields
 * and a fold that yields sixty times can be told apart by something other than
 * their totals.
 */
async function measure(operation) {
  global.gc?.();
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  await wait(20);
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const value = await operation();
  const elapsedMs = performance.now() - startedAt;
  const heapDeltaMb = mb(process.memoryUsage().heapUsed - heapBefore);
  await wait(20);
  delay.disable();
  return { value, elapsedMs, eventLoopMaxMs: Number(delay.max) / 1e6, heapDeltaMb };
}

async function repeat(count, operation) {
  const elapsed = [];
  let worstLoopMs = 0;
  for (let index = 0; index < count; index += 1) {
    const run = await measure(operation);
    elapsed.push(run.elapsedMs);
    worstLoopMs = Math.max(worstLoopMs, run.eventLoopMaxMs);
  }
  return { ...helpers.distribution(elapsed), eventLoopMaxMs: worstLoopMs };
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "volli-vc388-"));
const vite = await createServer({
  root: repository,
  appType: "custom",
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
  logLevel: "error",
});

let db;
try {
  // One at a time rather than one `Promise.all`: the module graph behind these
  // is most of the main process, and on a loaded machine the serial walk
  // measured 9.6 s against 26.8 s for the parallel one. (Either way, the
  // module runner's own invoke timeout is 60 s; a very busy machine can still
  // trip it before the first arm runs, and the answer is to re-run.)
  const { openVolliDb } = await vite.ssrLoadModule("/apps/desktop/src/main/db/index.ts");
  const { insertProject } = await vite.ssrLoadModule("/apps/desktop/src/main/db/projects-repo.ts");
  const { insertTicket } = await vite.ssrLoadModule("/apps/desktop/src/main/db/tickets-repo.ts");
  const eventsRepo = await vite.ssrLoadModule("/apps/desktop/src/main/db/events-repo.ts");
  const automationsRepo = await vite.ssrLoadModule("/apps/desktop/src/main/db/automations-repo.ts");
  const provenanceRepo = await vite.ssrLoadModule(
    "/apps/desktop/src/main/db/session-provenance-repo.ts",
  );
  const sessionControl = await vite.ssrLoadModule(
    "/apps/desktop/src/main/session-control/index.ts",
  );
  const { createSqliteSessionLedger } = await vite.ssrLoadModule(
    "/apps/desktop/src/main/session-control/sqlite-ledger.ts",
  );
  const engineModule = await vite.ssrLoadModule("/packages/session-engine/src/index.ts");

  db = openVolliDb(join(temporaryDirectory, "volli.db"));
  insertProject(db, {
    id: PROJECT_ID,
    name: "Bench",
    path: "/tmp/bench",
    ticketPrefix: "BN",
    baseBranch: "main",
    setupCommand: null,
    colorIndex: 0,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  });

  // The Tickets the roster hangs off. A Ticket Session's provenance read is
  // scoped by Ticket, so how many Tickets there are and how long each one's
  // timeline is are both dimensions of the tail this bench measures.
  const ticketIds = [];
  for (let index = 0; index < TICKET_COUNT; index += 1) {
    const id = `ticket-bench-${index}`;
    insertTicket(db, {
      id,
      projectId: PROJECT_ID,
      ticketNumber: index + 1,
      title: `Bench Ticket ${index}`,
      body: "",
      status: "doing",
      priority: "medium",
      usesWorktree: false,
      preferredHarnessId: "claude-code",
      order: index,
      worktreePath: null,
      branch: null,
      baseBranch: null,
      prUrl: null,
      createdAt: 1,
      updatedAt: 1,
    });
    ticketIds.push(id);
  }
  // Every seventh Session is a Board Session, which has no Ticket timeline at
  // all — the arm of the reader that answers without touching `ticket_events`.
  const ticketIdFor = (index) =>
    TICKET_COUNT === 0 || index % 7 === 6 ? null : ticketIds[index % TICKET_COUNT];

  const ledger = createSqliteSessionLedger(db);
  let sequence = 0;
  const provenance = {
    source: { kind: "user", id: "bench", detail: null },
    venue: { id: "local", kind: "local" },
  };
  const engineFor = (overrides = {}) =>
    engineModule.createSessionEngine({
      ledger,
      clock: { now: () => 1_000 },
      ids: { next: (kind) => `bench-${kind}-${++sequence}` },
      ...overrides,
    });

  // ── Build the roster through the production write path ──────────────────
  const engine = engineFor();
  const sessionIds = [];
  for (let index = 0; index < SESSION_COUNT; index += 1) {
    const created = await engine.createSession({
      commandId: `bench-create-${index}`,
      projectId: PROJECT_ID,
      ticketId: ticketIdFor(index),
      role: ticketIdFor(index) === null ? "project" : "ticket",
      parentSessionId: null,
      title: `Bench Session ${index}`,
      provenance,
    });
    sessionIds.push(created.session.id);
    for (let event = 0; event < EVENTS_PER_SESSION; event += 1) {
      await engine.submit({
        commandId: `bench-retitle-${index}-${event}`,
        sessionId: created.session.id,
        intent: { kind: "session.retitle", title: `Bench Session ${index} rev ${event}` },
        provenance,
      });
    }
  }

  // ── The records provenance is read out of (VC-392) ──────────────────────
  // Every durable source the reader asks, in the mix a worked project has:
  // a completed Run, a Run caught in its pre-insert window, a launch by a
  // parent Session, a launch by an Automation from older history, and the
  // resting case of a person. Written through the production repos so the
  // rows and their actor encodings are the ones the app stores.
  const MODEL = { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" };
  for (const ticketId of ticketIds) {
    for (let event = 0; event < TICKET_EVENTS_PER_TICKET; event += 1) {
      eventsRepo.recordTicketEvent(
        db,
        ticketId,
        { kind: "commented", commentId: `comment-${ticketId}-${event}` },
        1_000 + event,
      );
    }
  }
  for (const [index, sessionId] of sessionIds.entries()) {
    const ticketId = ticketIdFor(index);
    if (ticketId !== null) {
      eventsRepo.recordSessionStartedOnce(db, {
        ticketId,
        sessionId,
        now: 2_000 + index,
        actor:
          index % 5 === 1
            ? // A parent Session started this one: the arm that then reads the
              // parent's title out of `sessions`.
              { kind: "session", sessionId: sessionIds[0], ticketId }
            : index % 11 === 3
              ? // An Automation whose Run row is gone or never landed.
                { kind: "automation" }
              : { kind: "user" },
      });
    }
    // One completed Run in ten — the source that alone can carry a name, and
    // the one that short-circuits the read before any Ticket lookup.
    if (index % 10 === 0) {
      automationsRepo.recordAutomationRun(
        db,
        {
          automationId: `automation-${index}`,
          automationName: `Bench Automation ${index}`,
          ticketId,
          sessionId,
          model: MODEL,
        },
        3_000 + index,
      );
    }
    // One Session in twenty sits in a Run's pre-insert window: the create
    // command is marked, the Run projection is not there.
    if (index % 20 === 13) {
      db.prepare("INSERT INTO automation_commands (id, intent, created_at) VALUES (?, ?, ?)").run(
        `bench-automation-command-${index}`,
        JSON.stringify({
          kind: "automation.run",
          plan: { sessionOperationId: `bench-create-${index}`, ticketId, projectId: PROJECT_ID },
        }),
        3_000 + index,
      );
      db.prepare(
        `INSERT INTO automation_session_mint_intents
           (session_create_command_id, automation_command_id, recorded_at)
         VALUES (?, ?, ?)`,
      ).run(`bench-create-${index}`, `bench-automation-command-${index}`, 3_000 + index);
    }
  }

  const eventCount = db.prepare("SELECT COUNT(*) AS count FROM session_events").get().count;
  const ticketEventCount = db.prepare("SELECT COUNT(*) AS count FROM ticket_events").get().count;
  const checkpointStorage = () =>
    db
      .prepare(
        "SELECT COUNT(*) AS rows, COALESCE(MAX(LENGTH(checkpoint)), 0) AS maxBytes FROM session_projection_checkpoints",
      )
      .get();

  const query = { projectId: PROJECT_ID, scope: "all" };

  // ── Arm 0: no checkpoint row at all ─────────────────────────────────────
  // `submit` does not refresh the projection checkpoint (only `observe`
  // does), so the roster above starts with none. That is the unbounded fold:
  // the whole log per Session, which is what a Session that has never closed
  // an attachment actually costs.
  const uncheckpointed = await repeat(REPEATS, () => engineFor().listSessions(query));

  // Seed the rebuildable cache exactly as a durable runtime boundary would,
  // so every arm below measures the ≤CHECKPOINT_REFRESH_EVENTS tail the
  // ticket describes rather than a full-log fold.
  const sharedModule = await vite.ssrLoadModule("/packages/shared/src/index.ts");
  const beforeSeeding = checkpointStorage();
  await ledger.transaction((transaction) => {
    for (const session of transaction.listSessions(query)) {
      transaction.saveProjectionCheckpoint(
        sharedModule.createSessionProjectionCheckpoint(
          session,
          transaction.listEvents({ sessionId: session.id }),
        ),
      );
    }
  });
  const afterSeeding = checkpointStorage();

  // ── Arm 1: the shipped listing, cold then warm ──────────────────────────
  const cold = await measure(() => engineFor().listSessions(query));
  const warm = await repeat(REPEATS, () => engine.listSessions(query));

  // ── Arm 2: the same listing with the fold cache defeated ────────────────
  // A fresh engine per call has an empty memo, so this is the cost of the
  // chunked/yielding listing without option 2's cache.
  const uncached = await repeat(REPEATS, () => engineFor().listSessions(query));

  // ── Arm 2b: the whole IPC handler, not just the fold (VC-392) ───────────
  // `volli:session-list` is the fold PLUS `sessionListingRows` with the
  // per-Session provenance read. The fold yields every
  // `SESSION_LISTING_FOLD_CHUNK` Sessions; the row map does not, so whatever
  // it costs is one unbroken block however long the roster is. These arms
  // measure the tail on its own (over an already-folded roster, so the fold's
  // cost is not mixed in) and then the handler end to end, once with the
  // per-Session reader and once with the set-based one.
  const { PERSON_STARTED } = sharedModule;
  const perSessionProvenance = (session) =>
    provenanceRepo.readSessionProvenance(db, {
      sessionId: session.session.id,
      ticketId: session.session.ticketId,
    });
  const batchedProvenanceFor = (sessions) => {
    const answers = provenanceRepo.readSessionProvenances(db, queriesFor(sessions));
    return (session) => answers.get(session.session.id) ?? PERSON_STARTED;
  };
  const folded = await engine.listSessions(query);
  // The two readers must answer the same roster identically — the fetch/push
  // agreement this ticket is not allowed to break. Asserted here as well as in
  // the unit tests, because a bench that compares two different answers is
  // measuring nothing.
  const perSessionAnswers = JSON.stringify(folded.map(perSessionProvenance));
  const batchedAnswers = JSON.stringify(folded.map(batchedProvenanceFor(folded)));
  if (perSessionAnswers !== batchedAnswers) {
    throw new Error(
      "provenance readers disagree: the batched arm is not measuring the same answer",
    );
  }
  const provenanceTailPerSession = await repeat(REPEATS, async () =>
    sessionControl.sessionListingRows(folded, perSessionProvenance, new Set()),
  );
  const provenanceTailBatched = await repeat(REPEATS, async () =>
    sessionControl.sessionListingRows(folded, batchedProvenanceFor(folded), new Set()),
  );
  // Cold engine per call: a first visit to a project, which is the case the
  // ticket is about.
  const handlerPerSession = await repeat(REPEATS, async () => {
    const sessions = await engineFor().listSessions(query);
    return sessionControl.sessionListingRows(sessions, perSessionProvenance, new Set());
  });
  const handlerBatched = await repeat(REPEATS, async () => {
    const sessions = await engineFor().listSessions(query);
    return sessionControl.sessionListingRows(sessions, batchedProvenanceFor(sessions), new Set());
  });

  // ── Arm 3: the pre-VC-388 shape, for the block it used to cause ─────────
  const singleTransaction = await repeat(REPEATS, () =>
    ledger.transaction((transaction) => {
      const rows = transaction.listSessions(query);
      return rows.map((session) => {
        const checkpoint = transaction.getProjectionCheckpoint(session.id);
        const tail = transaction.listProjectionEvents({
          sessionId: session.id,
          ...(checkpoint ? { afterSequence: checkpoint.throughSequence } : {}),
        });
        return { session, tail: tail.length, checkpoint: checkpoint !== null };
      });
    }),
  );

  // ── Arm 4: chunk size × yield primitive ──────────────────────────────
  // Reimplements the loop rather than importing the constant, so each pairing
  // is measured on the same ledger through the same transaction verb.
  //
  // The primitive is a dimension and not a detail: Node clamps `setTimeout(0)`
  // to a millisecond, so a fine chunk pays that clamp once per chunk, while
  // `setImmediate` runs in the check phase with no floor at all. A sweep that
  // only measured one of them would pick a chunk size for the wrong reason.
  const primitives = {
    setImmediate: () => new Promise((done) => setImmediate(done)),
    setTimeout0: () => new Promise((done) => setTimeout(done, 0)),
  };
  const sweep = [];
  for (const [primitive, yieldToHost] of Object.entries(primitives)) {
    for (const chunk of [1, 2, 4, 8, 16, 32, SESSION_COUNT]) {
      const run = await repeat(REPEATS, async () => {
        const rows = await ledger.transaction((transaction) => transaction.listSessions(query));
        const out = [];
        for (let from = 0; from < rows.length; from += chunk) {
          if (from > 0) await yieldToHost();
          const slice = rows.slice(from, from + chunk);
          out.push(
            ...(await ledger.transaction((transaction) =>
              slice.map((session) => {
                const checkpoint = transaction.getProjectionCheckpoint(session.id);
                const tail = transaction.listProjectionEvents({
                  sessionId: session.id,
                  ...(checkpoint ? { afterSequence: checkpoint.throughSequence } : {}),
                });
                return { session, tail: tail.length };
              }),
            )),
          );
        }
        return out;
      });
      sweep.push({ primitive, chunk, ...run });
    }
  }

  // ── Arm 5: what one cached listing row weighs ───────────────────────────
  global.gc?.();
  const heapBeforeHold = process.memoryUsage().heapUsed;
  const held = await engineFor().listSessions(query);
  global.gc?.();
  const heldHeapMb = mb(process.memoryUsage().heapUsed - heapBeforeHold);

  // ── Arm 6: what one RUNTIME history entry weighs (audit item D4) ────────
  // The runtime keeps more than the engine's listing cache does: the fold AND
  // the events it was folded from. That is the entry `PROJECTION_CACHE_LIMIT`
  // bounds, so it is the one to divide a memory budget by.
  global.gc?.();
  const heapBeforeHistories = process.memoryUsage().heapUsed;
  const histories = await ledger.transaction((transaction) =>
    transaction.listSessions(query).map((session) => {
      const events = transaction.listEvents({ sessionId: session.id });
      const checkpoint = sharedModule.createSessionProjectionCheckpoint(session, events);
      return { projection: checkpoint.projection, events, checkpoint };
    }),
  );
  global.gc?.();
  const historiesHeapMb = mb(process.memoryUsage().heapUsed - heapBeforeHistories);

  console.log(
    JSON.stringify(
      {
        fixture: {
          sessions: SESSION_COUNT,
          eventsPerSession: EVENTS_PER_SESSION,
          totalEvents: eventCount,
          eventsPerSessionActual: eventCount / SESSION_COUNT,
          // `submit` never refreshes a checkpoint, so the roster genuinely
          // starts with none; the seeded count is what every arm after the
          // uncheckpointed one measures against.
          checkpointRowsBeforeSeeding: beforeSeeding.rows,
          checkpointRowsAfterSeeding: afterSeeding.rows,
          largestCheckpointBytes: afterSeeding.maxBytes,
          tickets: TICKET_COUNT,
          ticketEvents: ticketEventCount,
        },
        listing: {
          uncheckpointed,
          coldMs: cold.elapsedMs,
          coldEventLoopMaxMs: cold.eventLoopMaxMs,
          warmCached: warm,
          warmUncached: uncached,
          singleTransaction,
        },
        handler: {
          provenanceTailPerSession,
          provenanceTailBatched,
          handlerPerSession,
          handlerBatched,
        },
        chunkSweep: sweep,
        listingCacheEntry: {
          rows: held.length,
          heldHeapMb,
          perRowKb: (heldHeapMb * 1024) / held.length,
        },
        runtimeHistoryEntry: {
          rows: histories.length,
          heldHeapMb: historiesHeapMb,
          perRowKb: (historiesHeapMb * 1024) / histories.length,
        },
      },
      null,
      2,
    ),
  );
} finally {
  db?.close();
  await vite.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
