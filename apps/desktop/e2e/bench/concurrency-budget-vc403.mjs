#!/usr/bin/env node
/**
 * VC-403: what one Session start pays to learn how busy the machine is.
 *
 * The concurrency budget (VC-339) needs a COUNT — terminals still open, chats
 * mid-turn — and used to get it by folding every Session of every project.
 * This measures both shapes through the doors that actually ask:
 *
 *   - `sessionConcurrencyEnvFor` (`index.ts`) / `PtyManager`, via the reader
 *     `createSessionConcurrencyEnvReader` builds. Every structured attachment,
 *     background shell and terminal start goes through it.
 *   - `agent-commands.execute`, for a load verb — the same walk used to run for
 *     every `volli` verb whose table entry said `projections: "load"`.
 *
 * Like `session-listing-vc388.mjs`, the number that matters is not the total:
 * it is `eventLoopMaxMs`, the longest single stretch the host could not run a
 * timer, answer IPC or paint. This runs on the one main thread, behind the UI.
 *
 * The "before" arms reimplement the retired shape over the same ledger rather
 * than checking out the old code, exactly as VC-388's Arm 3 does, so both sides
 * are measured on one fixture in one process.
 *
 *   node --expose-gc apps/desktop/e2e/bench/concurrency-budget-vc403.mjs
 *   node --expose-gc apps/desktop/e2e/bench/concurrency-budget-vc403.mjs --sessions 400 --projects 6
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

const SESSION_COUNT = helpers.parsePositiveInteger("sessions", 240);
const PROJECT_COUNT = helpers.parsePositiveInteger("projects", 6);
const EVENTS_PER_SESSION = helpers.parsePositiveInteger("events", 40);
/** How many of the Sessions are left holding an OPEN attachment. */
const ATTACHED_COUNT = helpers.parsePositiveInteger("attached", 4);
const REPEATS = helpers.parsePositiveInteger("repeats", 5);

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function measure(operation) {
  global.gc?.();
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  await wait(20);
  const startedAt = performance.now();
  const value = await operation();
  const elapsedMs = performance.now() - startedAt;
  await wait(20);
  delay.disable();
  return { value, elapsedMs, eventLoopMaxMs: Number(delay.max) / 1e6 };
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

const temporaryDirectory = await mkdtemp(join(tmpdir(), "volli-vc403-"));
const vite = await createServer({
  root: repository,
  appType: "custom",
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
  logLevel: "error",
});

let db;
try {
  // Loaded one at a time, not with `Promise.all`: `agent-commands.ts` pulls in
  // a large graph, and racing it against the others makes the SSR module
  // runner's fetch time out rather than merely be slow.
  const { openVolliDb } = await vite.ssrLoadModule("/apps/desktop/src/main/db/index.ts");
  const { insertProject, listProjects } = await vite.ssrLoadModule(
    "/apps/desktop/src/main/db/projects-repo.ts",
  );
  const { createSqliteSessionLedger } = await vite.ssrLoadModule(
    "/apps/desktop/src/main/session-control/sqlite-ledger.ts",
  );
  const engineModule = await vite.ssrLoadModule("/packages/session-engine/src/index.ts");
  const concurrencyModule = await vite.ssrLoadModule(
    "/apps/desktop/src/main/session-concurrency.ts",
  );
  const commandsModule = await vite.ssrLoadModule("/apps/desktop/src/main/agent-commands.ts");

  db = openVolliDb(join(temporaryDirectory, "volli.db"));
  for (let index = 0; index < PROJECT_COUNT; index += 1) {
    insertProject(db, {
      id: `project-${index}`,
      name: `Bench ${index}`,
      path: `/tmp/bench-${index}`,
      ticketPrefix: `B${index}`,
      baseBranch: "main",
      setupCommand: null,
      colorIndex: 0,
      sortOrder: index,
      createdAt: 1,
      updatedAt: 1,
    });
  }

  const ledger = createSqliteSessionLedger(db);
  let sequence = 0;
  const provenance = {
    source: { kind: "user", id: "bench", detail: null },
    venue: { id: "local", kind: "local" },
  };
  const engineFor = () =>
    engineModule.createSessionEngine({
      ledger,
      clock: { now: () => 1_000 },
      ids: { next: (kind) => `bench-${kind}-${++sequence}` },
    });

  // ── Build a fleet through the production write path ─────────────────────
  // Most Sessions are finished history; a few still hold an open attachment.
  // That is the shape of a real machine, and it is exactly the shape the
  // narrowing exploits.
  const engine = engineFor();
  for (let index = 0; index < SESSION_COUNT; index += 1) {
    const projectId = `project-${index % PROJECT_COUNT}`;
    const created = await engine.createSession({
      commandId: `bench-create-${index}`,
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: `Bench Session ${index}`,
      provenance,
    });
    for (let event = 0; event < EVENTS_PER_SESSION; event += 1) {
      await engine.submit({
        commandId: `bench-retitle-${index}-${event}`,
        sessionId: created.session.id,
        intent: { kind: "session.retitle", title: `Bench ${index} rev ${event}` },
        provenance,
      });
    }
    const start = await engine.submit({
      commandId: `bench-start-${index}`,
      sessionId: created.session.id,
      intent: { kind: "executor.start", adapterId: "terminal", continuity: "fresh" },
      provenance,
    });
    await engine.observe({
      id: `bench-opened-${index}`,
      kind: "attachment.opened",
      sessionId: created.session.id,
      commandId: start.command.id,
      occurredAt: 1_000,
      provenance,
      attachment: {
        id: `bench-attachment-${index}`,
        sessionId: created.session.id,
        adapterId: "terminal",
        venue: { id: "local", kind: "local" },
        continuity: "fresh",
        native: { id: null, detail: { kind: "volli.terminal.v1", cwd: "/tmp/bench" } },
        authority: null,
      },
    });
    // Everything but the last few shells has exited, as on any real machine.
    if (index < SESSION_COUNT - ATTACHED_COUNT) {
      await engine.observe({
        id: `bench-closed-${index}`,
        kind: "attachment.closed",
        sessionId: created.session.id,
        occurredAt: 2_000,
        provenance,
        attachmentId: `bench-attachment-${index}`,
        outcome: "completed",
      });
    }
  }

  const eventCount = db.prepare("SELECT COUNT(*) AS count FROM session_events").get().count;
  const attachedCount = await ledger.transaction(
    (transaction) => transaction.listAttachedSessions().length,
  );
  const projectIds = listProjects(db).map((project) => project.id);

  /** The retired shape: every Session of every project, folded, then counted. */
  const foldTheFleet = async (target) => {
    const projections = (
      await Promise.all(
        projectIds.map((projectId) => target.listSessions({ projectId, scope: "all" })),
      )
    ).flat();
    return concurrencyModule.sessionConcurrencyEnv({
      projections,
      excludeSessionId: "nobody",
      environment: {},
      cores: 8,
    });
  };

  // ── Arm 1: the budget, before and after ─────────────────────────────────
  // Cold means a fresh engine every call: no listing-fold memo and no reader
  // cache, which is what a Session start after a quiet minute actually meets.
  const beforeCold = await repeat(REPEATS, () => foldTheFleet(engineFor()));
  const beforeWarm = await repeat(REPEATS, () => foldTheFleet(engine));

  const readerFor = (target) =>
    concurrencyModule.createSessionConcurrencyEnvReader({
      listAttachedSessions: () => target.listAttachedSessions(),
    });
  const afterCold = await repeat(REPEATS, () =>
    // A new reader AND a new engine per call, so neither cache can help: this
    // is the uncached start the ticket asked to stop folding the fleet.
    readerFor(engineFor())({ excludeSessionId: "nobody", environment: {}, cores: 8 }),
  );
  const warmReader = readerFor(engine);
  const afterWarm = await repeat(REPEATS, () =>
    warmReader({ excludeSessionId: "nobody", environment: {}, cores: 8 }),
  );

  // Both shapes must agree about the machine, or the speed means nothing.
  const budgetBefore = await foldTheFleet(engineFor());
  const budgetAfter = await readerFor(engineFor())({
    excludeSessionId: "nobody",
    environment: {},
    cores: 8,
  });

  // ── Arm 2: a load verb through the CLI door ─────────────────────────────
  const service = commandsModule.createAgentCommandService({
    db,
    appVersion: "bench",
    sessionEngine: engine,
  });
  const executeTicketList = () =>
    service.execute({
      v: 1,
      cmd: "ticket.list",
      args: { project: "/tmp/bench-0", limit: 1 },
      ctx: { cwd: "/tmp/bench-0", env: {} },
    });
  // "Before" is the eager dispatch: the same verb, preceded by the fleet fold
  // the table's `projections: "load"` policy used to run for it.
  const verbBefore = await repeat(REPEATS, async () => {
    await foldTheFleet(engineFor());
    return executeTicketList();
  });
  const verbAfter = await repeat(REPEATS, executeTicketList);

  console.log(
    JSON.stringify(
      {
        fixture: {
          sessions: SESSION_COUNT,
          projects: PROJECT_COUNT,
          totalEvents: eventCount,
          sessionsHoldingAnOpenAttachment: attachedCount,
        },
        budget: {
          // The fold the ticket measured: every Session of every project.
          beforeCold,
          beforeWarm,
          // The narrow read: only the Sessions that could be working.
          afterCold,
          afterWarm,
        },
        loadVerb: { beforeCold: verbBefore, after: verbAfter },
        agreement: {
          before: budgetBefore.VOLLI_CONCURRENCY_HINT,
          after: budgetAfter.VOLLI_CONCURRENCY_HINT,
          same: budgetBefore.VOLLI_CONCURRENCY_HINT === budgetAfter.VOLLI_CONCURRENCY_HINT,
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
