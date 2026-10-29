import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createSessionExecutorSlot,
  createSessionRuntime,
  type NativeHarnessAdapter,
} from "@volli/session-engine";
import { createInMemoryTranscriptArtifactStore } from "@volli/session-engine/testing";
import { decodeSessionEventPayload, LOCAL_RUNNER } from "@volli/shared";
import {
  SESSION_COMMAND_FORMAT,
  SESSION_NOTICE_FORMAT,
  type ClaimedJob,
  type JobOutcome,
} from "@volli/shared/cloud";
import type { LiveHostCore } from "../index";
import { createBackendLink, type BackendConnection } from "../cloud-runner/backend-link";
import { createMutationGate } from "../cloud-runner/flow";
import type { RunnerPresence } from "../cloud-runner/presence";
import { sqliteDrainCursorStore, sqliteJobJournalStore } from "../cloud-runner/sqlite-stores";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertProject, listProjects } from "../db/projects-repo";
import { insertTicket, listTicketsByProject } from "../db/tickets-repo";
import { createSessionWakeBus } from "../session-control/session-wake";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import {
  createSqliteHostNoticeOutbox,
  scopeSqliteHostNoticeOutbox,
} from "../session-runtime/sqlite-host-notice-outbox";
import { hostMcpDispatch } from "../mcp/dispatch-policy";
import { createRuntimeContextResolver } from "../session-runtime/context";
import { createTestSessionEngine } from "../testing/session-engine";
import { createCloudProductStore, type CloudProductStore } from "./index";
import { createMachinePaths } from "../machine-paths";
import type { CloudRunnerContext } from "./context";
import { createLocalSessionEngine } from "./owner";
import { createCloudEnvironmentPreparation } from "./environment";
import { markFirstRunPending } from "../worktree/first-run";
import type { BusyWorktreeSites } from "../worktree/activity";
import { agentTurnOpenWithin } from "../worktree/agent-sites";

const PROJECT = "00000000-0000-4000-8000-000000000001";
const TICKET = "00000000-0000-4000-8000-000000000002";
const REPO = "00000000-0000-4000-8000-000000000003";
const COPY = "00000000-0000-4000-8000-000000000004";
const RUNNER_A = "00000000-0000-4000-8000-000000000005";
const RUNNER_B = "00000000-0000-4000-8000-000000000006";
const provenance = {
  source: { kind: "system", id: "test", detail: null },
  venue: LOCAL_RUNNER,
} as const;
let opened: TestDb | undefined;
let root: string | undefined;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  opened?.cleanup();
  opened = undefined;
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Volli Test",
      GIT_AUTHOR_EMAIL: "test@volli.local",
      GIT_COMMITTER_NAME: "Volli Test",
      GIT_COMMITTER_EMAIL: "test@volli.local",
    },
  }).trim();
}

function fixture(busySites: BusyWorktreeSites = async () => []) {
  opened = openTestDb();
  const { db } = opened;
  root = mkdtempSync(join(tmpdir(), "volli-cloud-store-"));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  git(checkout, ["init", "-b", "main"]);
  writeFileSync(join(checkout, "README.md"), "initial\n");
  git(checkout, ["add", "."]);
  git(checkout, ["commit", "-m", "initial"]);
  const wake = createSessionWakeBus(createTestSessionEngine(db), { db });
  // Only these host services are consumed by the product store. They are the
  // real decorated writer and SQLite, not a second fake Session engine.
  const host = {
    database: { ok: true, db },
    sessionEngine: wake.engine,
    sessionWakeBus: wake,
  } as LiveHostCore;
  const store = (
    ownerUserId = "a",
    runnerId = RUNNER_A,
    sessionJobs?: Parameters<typeof createCloudProductStore>[0]["sessionJobs"],
  ) => {
    const cloud = createCloudProductStore({
      host: { ...host, machinePaths: createMachinePaths(db) },
      ownerUserId,
      backendUrl: "http://127.0.0.1:1",
      runnerId: () => runnerId,
      home: root!,
      busySites,
      ...(sessionJobs === undefined ? {} : { sessionJobs }),
    });
    cleanups.push(() => cloud.dispose());
    return cloud;
  };
  const facts: CloudRunnerContext = {
    sessionId: "unused",
    ownerUserId: "a",
    project: { id: PROJECT, name: "Cloud project" },
    ticketPrefix: "VC",
    primaryRepo: { id: REPO, projectId: PROJECT, baseBranch: "main" },
    ticket: {
      id: TICKET,
      projectId: PROJECT,
      number: 42,
      title: "Cloud materialization",
      checkoutMode: "worktree",
      branch: null,
      baseBranch: "main",
      status: "doing",
      retentionKeep: false,
    },
    body: "Cloud-only brief body. Never copy this into a local board cache.",
  };
  const frozen = () => {
    insertProject(db, testProject({ id: PROJECT, path: checkout, ticketPrefix: "VC" }));
    insertTicket(
      db,
      testTicket(PROJECT, {
        id: TICKET,
        ticketNumber: 42,
        title: "Frozen title",
        body: "Frozen body",
        usesWorktree: true,
      }),
    );
  };
  return { db, checkout, wake, store, facts, frozen };
}

/** S2's actual link/gate runs over an in-memory BackendConnection port. */
function connect(f: ReturnType<typeof fixture>, store: CloudProductStore, runnerId = RUNNER_A) {
  const queued: ClaimedJob[] = [];
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const accepted: { sessionId: string; sequence: number; kind: string }[] = [];
  const completed = new Map<string, JobOutcome>();
  const journal = sqliteJobJournalStore(f.db, store.ownerUserId);
  const query = vi.fn(async (_name: string, input: Record<string, unknown>) => ({
    ...f.facts,
    sessionId: input.sessionId,
    ownerUserId: store.ownerUserId,
  }));
  let wakeListener: ((value: unknown) => void) | undefined;
  let connected = true;
  let connectionListener: ((up: boolean) => void) | undefined;
  const connection: BackendConnection = {
    query,
    async mutation(name, args) {
      calls.push({ name, args });
      switch (name) {
        case "projectCheckouts:report":
          return null;
        case "workingCopies:report":
          return { workingCopyId: COPY };
        case "sessions:accept": {
          let through = 0;
          for (const text of args.events as string[]) {
            const event = JSON.parse(text) as {
              sessionId: string;
              sequence: number;
              payload: unknown;
            };
            const payload = decodeSessionEventPayload(event.payload, "in-memory accept");
            accepted.push({
              sessionId: event.sessionId,
              sequence: event.sequence,
              kind: payload.kind,
            });
            through = event.sequence;
          }
          return { acceptedThrough: through, duplicates: 0, quarantined: 0 };
        }
        case "runnerJobs:claim":
          return queued.splice(0, args.max as number);
        case "runnerJobs:renew":
          return {
            ok: true,
            lease: { bootId: args.bootId, attempt: args.attempt, expiresAt: Date.now() + 60_000 },
          };
        case "runnerJobs:complete": {
          const id = args.jobId as string;
          // The SQLite outcome must exist BEFORE a byte is reported.
          expect(journal.get(id)?.outcome).toEqual(args.outcome);
          completed.set(id, args.outcome as JobOutcome);
          return { ack: "recorded", status: "done" };
        }
        default:
          throw new Error(`Unexpected mutation: ${name}`);
      }
    },
    onUpdate: (name, _args, listener) => {
      if (name === "runnerJobs:wake") wakeListener = listener;
      return () => {
        wakeListener = undefined;
      };
    },
    isConnected: () => connected,
    onConnectionChange: (listener) => {
      connectionListener = listener;
      return () => {
        connectionListener = undefined;
      };
    },
    close: async () => {},
  };
  const link = createBackendLink({
    connect: () => connection,
    token: async () => "test-token",
    gate: createMutationGate(),
  });
  const presence: RunnerPresence = {
    start: async () => {},
    stop: async () => {},
    setState: async () => {},
    beatNow: async () => {},
    refreshCapabilities: async () => {},
    connected: true,
    revoked: false,
  };
  const sync = store.connect({ link, runnerId, bootId: "boot", presence });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await sync.stop();
    await link.close();
  };
  cleanups.push(close);
  return {
    sync,
    close,
    queued,
    calls,
    query,
    accepted,
    completed,
    journal,
    wake() {
      wakeListener?.({ ready: queued.length, nextAvailableAt: null });
    },
    setConnected(up: boolean) {
      connected = up;
      connectionListener?.(up);
    },
  };
}

async function birth(store: CloudProductStore, id: string, projectId = PROJECT, ticketId = TICKET) {
  await store.sessionBirth.beforeCreate({ projectId, ticketId, requestedSessionId: id });
  const { session } = await store.engine.createSession({
    commandId: `birth-${id}`,
    requestedSessionId: id,
    projectId,
    ticketId,
    role: "ticket",
    parentSessionId: null,
    title: null,
    provenance,
  });
  await store.engine.submit({
    commandId: `model-${id}`,
    sessionId: id,
    intent: {
      kind: "model.select",
      selection: { providerId: "scripted", modelId: "test", reasoningLevel: "off" },
    },
    provenance,
  });
  await store.engine.getOrRecordSessionInput({
    sessionId: id,
    input: { kind: "tool-surface", tools: ["read"] },
    provenance,
  });
  return session;
}

function runtimeContext(f: ReturnType<typeof fixture>, store: CloudProductStore) {
  return createRuntimeContextResolver({
    db: f.db,
    sessionEngine: store.engine,
    venue: LOCAL_RUNNER,
    mcpDispatch: hostMcpDispatch({ env: {}, packaged: true, log: vi.fn() }),
    waitForBirth: async () => {},
    toolSurface: () => null,
    brief: store.brief,
  });
}

function claimed(
  kind: "workingCopy.materialize" | "workingCopy.reclaim" | "session.command" | "session.followUp",
  id: string,
  runnerId: string,
  sessionId: string | null = null,
): ClaimedJob {
  return {
    job: {
      id,
      kind,
      runnerId,
      projectId: PROJECT,
      ticketId: TICKET,
      sessionId,
      workingCopyId: kind === "workingCopy.reclaim" ? COPY : null,
      commandId: kind.startsWith("workingCopy.") ? null : `command-${id}`,
      payload:
        kind === "workingCopy.materialize"
          ? { ticketId: TICKET, reason: "session_start" }
          : kind === "workingCopy.reclaim"
            ? { ticketId: TICKET, workingCopyId: COPY, reason: "retention" }
            : {
                format: SESSION_COMMAND_FORMAT,
                intent: JSON.stringify({ kind: "session.retitle", title: "Wrong owner" }),
              },
      priority: "normal",
      createdBy: { kind: "volli", reason: "policy" },
      createdAt: 0,
      availableAt: 0,
    },
    lease: { bootId: "boot", attempt: 1, expiresAt: Date.now() + 60_000 },
  } as ClaimedJob;
}

describe("cloud product store integration", () => {
  it("adopts frozen paths, commits owner/cursor at birth, and reattaches from a durable brief offline", async () => {
    const f = fixture();
    f.frozen();
    const adoptedCopy = join(root!, "existing-working-copy");
    git(f.checkout, [
      "worktree",
      "add",
      "-b",
      "volli/VC-42-cloud-materialization",
      adoptedCopy,
      "main",
    ]);
    f.db
      .prepare("UPDATE tickets SET worktree_path=?,branch=?,base_branch='main' WHERE id=?")
      .run(adoptedCopy, "volli/VC-42-cloud-materialization", TICKET);
    const originalProject = f.db.prepare("SELECT * FROM projects").get();
    const originalTicket = f.db.prepare("SELECT * FROM tickets").get();
    const a = f.store();
    // The saved runner id makes adoption possible before any backend link.
    expect(a.registry().checkouts.pathOf(PROJECT, REPO)).toBe(f.checkout);
    expect(a.registry().checkouts.get(PROJECT, REPO)?.adoptedFromFrozen).toBe(true);
    expect(a.registry().workingCopies.pathOf(TICKET, REPO)).toBe(adoptedCopy);
    expect(a.registry().workingCopies.get(TICKET, REPO)?.adoptedFromFrozen).toBe(true);
    const remote = connect(f, a);
    const seen: unknown[] = [];
    const off = f.wake.subscribe(({ event }) => {
      if (event.payload.kind === "session.created")
        seen.push({
          owner: event.payload.session.ownerUserId,
          cursorOwner: sqliteDrainCursorStore(f.db).get(event.sessionId)?.ownerUserId,
          venue: event.provenance.venue,
        });
    });
    const session = await birth(a, "session-a");
    off();
    expect(seen).toEqual([{ owner: "a", cursorOwner: "a", venue: LOCAL_RUNNER }]);
    expect(session.ownerUserId).toBe("a");
    expect(sqliteDrainCursorStore(f.db).get(session.id)).toMatchObject({
      ownerUserId: "a",
      acceptedThrough: 0,
    });
    const location = await a.locations.prepare(session);
    expect(location).toMatchObject({ directory: adoptedCopy, venue: LOCAL_RUNNER });
    expect(existsSync(join(location.directory, "README.md"))).toBe(true);
    expect(git(location.directory, ["branch", "--show-current"])).toBe(
      "volli/VC-42-cloud-materialization",
    );
    expect(remote.calls).toContainEqual({
      name: "projectCheckouts:report",
      args: expect.objectContaining({ headBranch: "main" }),
    });
    expect(remote.calls).toContainEqual({
      name: "workingCopies:report",
      args: expect.objectContaining({ ticketId: TICKET, state: "ready" }),
    });
    const first = await runtimeContext(f, a)(session.id);
    expect(first?.brief).toContain(f.facts.body);
    expect(first?.brief).toContain(f.facts.ticket!.title);
    expect(first?.brief).not.toContain("Frozen body");
    expect(remote.query).toHaveBeenCalledTimes(1);
    expect(remote.query).toHaveBeenCalledWith("runnerContext:forSession", {
      sessionId: session.id,
      projectId: PROJECT,
      ticketId: TICKET,
    });
    expect(f.db.prepare("SELECT * FROM projects").get()).toEqual(originalProject);
    expect(f.db.prepare("SELECT * FROM tickets").get()).toEqual(originalTicket);

    // A born-but-not-yet-briefed Session cannot first attach on a cold offline launch.
    const unbriefed = await birth(a, "unbriefed");
    await remote.close();
    a.dispose();
    const offline = f.store();
    mkdirSync(join(location.directory, ".agents"), { recursive: true });
    writeFileSync(
      join(location.directory, ".agents", "resume"),
      'printf "resumed\\n" >> resume-ran\n',
    );
    offline.bindEnvironment(
      createCloudEnvironmentPreparation({
        db: f.db,
        home: root!,
        environment: async () => ({
          shellPath: "/bin/sh",
          env: {
            PATH: process.env["PATH"] ?? "/usr/bin:/bin",
            VOLLI_CONCURRENCY_HINT: process.env["VOLLI_CONCURRENCY_HINT"] ?? "1",
          },
        }),
      }),
    );
    expect(await runtimeContext(f, offline)(session.id)).toEqual(first);
    expect(await offline.locations.prepare(session)).toEqual({
      directory: location.directory,
      venue: LOCAL_RUNNER,
    });
    expect(readFileSync(join(location.directory, "resume-ran"), "utf8")).toBe("resumed\n");
    writeFileSync(
      join(location.directory, ".agents", "setup"),
      "echo dependency-missing\nexit 7\n",
    );
    markFirstRunPending({ home: root! }, location.directory, TICKET, ["setup"]);
    await expect(offline.locations.prepare(session)).rejects.toThrow(
      ".agents/setup exited with code 7",
    );
    // A consumed setup marker must not let a later attach bypass the failed run.
    await expect(offline.locations.prepare(session)).rejects.toThrow(".agents/setup");
    expect(readFileSync(join(location.directory, "resume-ran"), "utf8")).toBe("resumed\n");
    await expect(runtimeContext(f, offline)(unbriefed.id)).rejects.toThrow(
      "Volli Cloud is unreachable",
    );
    const pending = await birth(offline, "new-offline");
    expect(pending.ownerUserId).toBe("a");
    expect(sqliteDrainCursorStore(f.db).get("new-offline")?.ownerUserId).toBe("a");
    await expect(runtimeContext(f, offline)(pending.id)).rejects.toThrow(
      "Volli Cloud is unreachable",
    );
    expect(remote.query).toHaveBeenCalledTimes(1);
    const siteHints = JSON.stringify(
      f.db.prepare("SELECT value FROM app_state WHERE key LIKE 'volli:runner-site:%'").all(),
    );
    expect(siteHints).not.toContain(f.facts.body);
    expect(siteHints).not.toContain(f.facts.ticket!.title);
  }, 20_000);

  it("materializes through connect/inbox/journal, drains only A, and rejects A's jobs on B", async () => {
    const f = fixture();
    f.frozen();
    const a = f.store();
    const remote = connect(f, a);
    const session = await birth(a, "session-a");
    const job = claimed(
      "workingCopy.materialize",
      "00000000-0000-4000-8000-000000000010",
      RUNNER_A,
    );
    remote.queued.push(job);
    remote.sync.start();
    await vi.waitFor(() => expect(remote.completed.get(job.job.id)?.status).toBe("done"), {
      timeout: 10_000,
    });
    await a.drain.idle();
    expect(remote.completed.get(job.job.id)).toMatchObject({
      status: "done",
      result: {
        kind: "materialized",
        workingCopy: {
          // A local act does not wait for the backend to mint this identity.
          workingCopyId: null,
          branch: "volli/VC-42-cloud-materialization",
          state: "ready",
        },
      },
    });
    expect(JSON.stringify(remote.completed.get(job.job.id))).not.toContain(root);
    const path = a.registry().workingCopies.pathOf(TICKET, REPO)!;
    expect(existsSync(join(path, "README.md"))).toBe(true);
    await vi.waitFor(() =>
      expect(a.registry().workingCopies.get(TICKET, REPO)?.workingCopyId).toBe(COPY),
    );
    await vi.waitFor(() => expect(remote.journal.get(job.job.id)).toBeNull());
    expect(
      remote.accepted.some(
        (event) => event.sessionId === session.id && event.kind === "session.created",
      ),
    ).toBe(true);
    expect(sqliteDrainCursorStore(f.db).get(session.id)!.acceptedThrough).toBeGreaterThan(0);
    await remote.close();
    a.dispose();

    const unreported = {
      jobId: "pending-a",
      kind: "workingCopy.refresh",
      lease: { bootId: "old-boot", attempt: 1 },
      state: "done" as const,
      outcome: { status: "done" as const, result: null },
      receivedAt: 1,
    };
    remote.journal.save(unreported);
    sqliteJobJournalStore(f.db).save({ ...unreported, jobId: "pending-legacy" });
    const followUp = vi.fn(async (): Promise<JobOutcome> => ({ status: "done", result: null }));
    const b = f.store("b", RUNNER_B, { "session.followUp": followUp });
    const other = connect(f, b, RUNNER_B);
    const foreignCommand = claimed(
      "session.command",
      "00000000-0000-4000-8000-000000000011",
      RUNNER_B,
      session.id,
    );
    const foreignFollowUp = claimed(
      "session.followUp",
      "00000000-0000-4000-8000-000000000012",
      RUNNER_B,
      session.id,
    );
    other.queued.push(foreignCommand, foreignFollowUp);
    other.sync.start();
    await vi.waitFor(() => expect(other.completed.size).toBe(2));
    for (const outcome of other.completed.values())
      expect(outcome).toMatchObject({
        status: "failed",
        code: "not_your_runner",
        retryable: false,
      });
    expect(followUp).not.toHaveBeenCalled();
    expect(await b.engine.listSessions({ projectId: PROJECT, scope: "all" })).toEqual([]);
    expect(await b.engine.getBaseSession({ sessionId: session.id })).toBeNull();
    expect(await b.engine.listEvents({ sessionId: session.id })).toEqual([]);
    await b.drain.idle();
    expect(other.accepted).toEqual([]);
    expect([...other.completed.keys()].toSorted()).toEqual(
      [foreignCommand.job.id, foreignFollowUp.job.id].toSorted(),
    );
    expect(remote.journal.get(unreported.jobId)).toEqual(unreported);
    expect(sqliteJobJournalStore(f.db).get("pending-legacy")).not.toBeNull();
    expect((await f.wake.engine.getSession({ sessionId: session.id }))?.session.title).toBeNull();
  }, 20_000);

  it("puts claimed notices into the owner-scoped outbox in Session lane order, answering on_runner", async () => {
    const f = fixture();
    f.frozen();
    const a = f.store();
    const outbox = scopeSqliteHostNoticeOutbox(
      f.db,
      createSqliteHostNoticeOutbox(f.db, createSqliteSessionLedger(f.db)),
      a.ownsSession,
    );
    a.bindNotices({ enqueue: (intent) => outbox.put(intent.compose()) });
    const remote = connect(f, a);
    const session = await birth(a, "session-a");
    const target = "00000000-0000-4000-8000-0000000000b1";
    const notice = (n: number): ClaimedJob => {
      const commandId = `watch:${session.id}:00000000-0000-4000-8000-00000000010${n}`;
      return {
        job: {
          id: commandId,
          kind: "session.notice",
          runnerId: RUNNER_A,
          projectId: PROJECT,
          ticketId: null,
          sessionId: session.id,
          workingCopyId: null,
          commandId,
          payload: {
            format: SESSION_NOTICE_FORMAT,
            notice: "watch",
            commandId,
            changes: [
              {
                subject: "session",
                sessionId: target,
                title: null,
                occurredAt: n,
                fact: "signaled-done",
                pendingSubagents: [],
                reason: null,
              },
            ],
            overflow: 0,
          },
          priority: "normal",
          createdBy: { kind: "volli", reason: "policy" },
          createdAt: 0,
          availableAt: 0,
        },
        lease: { bootId: "boot", attempt: 1, expiresAt: Date.now() + 60_000 },
      } as unknown as ClaimedJob;
    };
    remote.sync.start();
    remote.queued.push(notice(1), notice(2));
    // The backend's `runnerJobs.wake` subscription, not the poll, claims them.
    remote.wake();
    await vi.waitFor(() => expect(remote.completed.size).toBe(2));
    for (const outcome of remote.completed.values())
      expect(outcome).toEqual({ status: "done", result: { stage: "on_runner" } });
    const rows = f.db
      .prepare("SELECT command_id, session_id FROM host_notice_outbox ORDER BY ordinal")
      .all();
    expect(rows).toEqual([
      { command_id: notice(1).job.id, session_id: session.id },
      { command_id: notice(2).job.id, session_id: session.id },
    ]);
  });

  it("keeps cloud identity shadows and cursor Sessions out of the frozen local product", async () => {
    const f = fixture();
    f.frozen();
    const local = createLocalSessionEngine({ db: f.db, engine: f.wake.engine });
    const localSession = await local.createSession({
      commandId: "local-birth",
      projectId: PROJECT,
      ticketId: TICKET,
      role: "ticket",
      parentSessionId: null,
      title: "Local",
      provenance,
    });
    const a = f.store();
    connect(f, a);
    await birth(a, "cloud-on-frozen");
    const cloudProject = "00000000-0000-4000-8000-000000000021";
    const cloudTicket = "00000000-0000-4000-8000-000000000022";
    const cloudRepo = "00000000-0000-4000-8000-000000000023";
    f.facts.project = { id: cloudProject, name: "New cloud project" };
    f.facts.primaryRepo = { id: cloudRepo, projectId: cloudProject, baseBranch: "main" };
    f.facts.ticket = { ...f.facts.ticket!, id: cloudTicket, projectId: cloudProject };
    a.registry().checkouts.register({
      projectId: cloudProject,
      projectRepoId: cloudRepo,
      absPath: join(root!, "cloud-folder"),
    });
    await birth(a, "cloud-only", cloudProject, cloudTicket);
    expect(listProjects(f.db).map((project) => project.id)).toEqual([PROJECT]);
    expect(listTicketsByProject(f.db, PROJECT).map((ticket) => ticket.id)).toEqual([TICKET]);
    expect(listTicketsByProject(f.db, cloudProject)).toEqual([]);
    expect(
      (await local.listSessions({ projectId: PROJECT, scope: "all" })).map(
        (projection) => projection.session.id,
      ),
    ).toEqual([localSession.session.id]);
    expect(await local.listSessions({ projectId: cloudProject, scope: "all" })).toEqual([]);
    expect(
      (await a.engine.listSessions({ projectId: cloudProject, scope: "all" })).map(
        (projection) => projection.session.id,
      ),
    ).toEqual(["cloud-only"]);
    expect(f.db.prepare("SELECT title,body FROM tickets WHERE id=?").get(cloudTicket)).toEqual({
      title: "Volli Cloud ticket",
      body: "",
    });
    const b = f.store("b", RUNNER_B);
    expect(await b.engine.listSessions({ projectId: PROJECT, scope: "all" })).toEqual([]);
    expect(await b.engine.listSessions({ projectId: cloudProject, scope: "all" })).toEqual([]);
    expect(b.projectIds()).toEqual([]);
  });
});

it("recreates an already-briefed missing copy while the shared link is disconnected, then reports on reconnect", async () => {
  const f = fixture();
  f.frozen();
  const a = f.store();
  const remote = connect(f, a);
  remote.sync.start();
  const session = await birth(a, "offline-recreate");
  const location = await a.locations.prepare(session);
  await runtimeContext(f, a)(session.id);
  await a.drain.idle();
  const pendingReports = () =>
    (
      f.db
        .prepare("SELECT COUNT(*) AS n FROM app_state WHERE key LIKE 'volli:runner-report:%'")
        .get() as { n: number }
    ).n;
  await vi.waitFor(() => expect(pendingReports()).toBe(0));
  const calls = remote.calls.length;
  remote.setConnected(false);
  rmSync(location.directory, { recursive: true, force: true });
  await a.locations.reaffirm(session, location.directory);
  expect(existsSync(join(location.directory, "README.md"))).toBe(true);
  expect(remote.query).toHaveBeenCalledTimes(1);
  expect(remote.calls).toHaveLength(calls);
  expect(pendingReports()).toBeGreaterThan(0);
  remote.setConnected(true);
  await vi.waitFor(() => expect(pendingReports()).toBe(0));
  expect(remote.calls.slice(calls)).toContainEqual({
    name: "workingCopies:report",
    args: expect.objectContaining({ state: "ready", ticketId: TICKET }),
  });
}, 20_000);

it.each([false, true])(
  "durably closes idle attachments before inbox reclaim, refusing a failed detach (failure: %s)",
  async (detachFails) => {
    let runtime: ReturnType<typeof createSessionRuntime> | undefined;
    const unreadable = vi.fn();
    const busySites = vi.fn(async (directory: string) =>
      runtime !== undefined && (await agentTurnOpenWithin(runtime, directory, unreadable))
        ? [{ directory, surface: "agent" as const }]
        : [],
    );
    const f = fixture(busySites);
    f.frozen();
    const a = f.store();
    // Connect first: the inbox must read the runtime bound later by assembly.
    const remote = connect(f, a);
    const session = await birth(a, "idle-reclaim");
    const release = vi.fn(async () => {
      if (detachFails) throw new Error("Executor refused to detach");
    });
    const adapter: NativeHarnessAdapter = {
      id: "scripted",
      durableIdNamespace: "scripted",
      adapterVersion: "1",
      runtime: { path: "/scripted", version: "1", fingerprint: "scripted" },
      attach: async () => ({
        native: { id: "native", detail: null },
        dispatch: async (command) => ({
          commandId: command.commandId,
          status: "accepted" as const,
          acceptedAt: Date.now(),
          native: null,
        }),
        reconcile: async () => ({ cursor: null, observations: [], receipts: [] }),
        release,
      }),
    };
    const artifacts = createInMemoryTranscriptArtifactStore();
    let nextId = 0;
    runtime = createSessionRuntime({
      engine: a.engine,
      executors: createSessionExecutorSlot(adapter),
      artifacts,
      locations: a.locations,
      clock: { now: Date.now },
      ids: { next: (kind) => `${kind}-${++nextId}` },
    });
    const boundRuntime = runtime;
    cleanups.push(() => boundRuntime.close());
    a.bindRuntime(runtime, artifacts);
    const attached = await runtime.command({
      commandId: "attach-idle-reclaim",
      sessionId: session.id,
      command: { kind: "adapter.attach", continuity: "fresh" },
    });
    expect(attached.receipt?.status).toBe("accepted");
    expect((await runtime.projection({ sessionId: session.id })).projection.turnActive).toBe(false);
    const bindings = runtime.openNativeBindings();
    expect(bindings).toHaveLength(1);
    const { attachmentId, directory } = bindings[0]!;
    expect(directory).toBe(a.registry().workingCopies.pathOf(TICKET, REPO));
    await vi.waitFor(() =>
      expect(a.registry().workingCopies.get(TICKET, REPO)?.workingCopyId).toBe(COPY),
    );
    const closedWhilePresent: boolean[] = [];
    cleanups.push(
      f.wake.subscribe(({ event }) => {
        if (event.sessionId === session.id && event.payload.kind === "attachment.closed")
          closedWhilePresent.push(existsSync(directory));
      }),
    );
    f.facts.ticket!.status = "done";
    f.facts.retention = {
      doneEntryAt: Date.now() - 20 * 86400000,
      prUrl: null,
      prState: null,
    };
    const job = claimed("workingCopy.reclaim", "00000000-0000-4000-8000-000000000040", RUNNER_A);
    remote.queued.push(job);
    remote.sync.start();
    await vi.waitFor(() => expect(remote.completed.has(job.job.id)).toBe(true), {
      timeout: 10_000,
    });
    expect(remote.completed.get(job.job.id)).toMatchObject({
      status: "done",
      result: { kind: detachFails ? "skipped" : "reclaimed" },
    });
    expect(busySites).toHaveBeenCalledWith(directory);
    expect(unreadable).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledExactlyOnceWith("requested");
    expect(existsSync(directory)).toBe(detachFails);
    expect(runtime.openNativeBindings()).toHaveLength(detachFails ? 1 : 0);
    // A cold reader proves the close is in SQLite, not just runtime memory;
    // the post-commit wake above proves it preceded the directory's removal.
    const reader = createTestSessionEngine(f.db);
    const durable = await reader.getSession({ sessionId: session.id });
    const closed = (await reader.listEvents({ sessionId: session.id })).filter(
      (event) => event.payload.kind === "attachment.closed",
    );
    if (detachFails) {
      expect(closed).toEqual([]);
      expect(closedWhilePresent).toEqual([]);
      expect(durable?.liveExecutor?.id).toBe(attachmentId);
      expect(remote.calls).not.toContainEqual({
        name: "workingCopies:report",
        args: expect.objectContaining({ state: "reclaimed" }),
      });
    } else {
      expect(closed).toHaveLength(1);
      expect(closed[0]?.payload).toMatchObject({ attachmentId, outcome: "completed" });
      expect(closedWhilePresent).toEqual([true]);
      expect(durable?.liveExecutor).toBeNull();
      await vi.waitFor(() =>
        expect(remote.calls).toContainEqual({
          name: "workingCopies:report",
          args: expect.objectContaining({ state: "reclaimed" }),
        }),
      );
    }
    expect(JSON.stringify(remote.completed.get(job.job.id))).not.toContain(root);
  },
  20_000,
);

it("wires retention reclaim to fresh backend dates/PR facts and the machine TTL", async () => {
  const f = fixture();
  f.frozen();
  const a = f.store();
  const remote = connect(f, a);
  const make = claimed("workingCopy.materialize", "00000000-0000-4000-8000-000000000020", RUNNER_A);
  remote.queued.push(make);
  remote.sync.start();
  await vi.waitFor(() => expect(remote.completed.get(make.job.id)?.status).toBe("done"));
  const path = a.registry().workingCopies.pathOf(TICKET, REPO)!;
  await vi.waitFor(() =>
    expect(a.registry().workingCopies.get(TICKET, REPO)?.workingCopyId).toBe(COPY),
  );
  f.facts.ticket!.status = "done";
  const now = Date.now();
  const cases = [
    {
      doneEntryAt: now - 20 * 86400000,
      prUrl: "https://example.com/pr/1",
      prState: "open" as const,
    },
    { doneEntryAt: now - 86400000, prUrl: null, prState: null },
    { doneEntryAt: null, prUrl: null, prState: null },
    { doneEntryAt: now - 20 * 86400000, prUrl: null, prState: null },
  ];
  for (let index = 0; index < cases.length; index += 1) {
    f.facts.retention = cases[index]!;
    const job = claimed(
      "workingCopy.reclaim",
      `00000000-0000-4000-8000-00000000003${index}`,
      RUNNER_A,
    );
    remote.queued.push(job);
    remote.wake();
    await vi.waitFor(() => expect(remote.completed.has(job.job.id)).toBe(true));
    const expected = index === cases.length - 1 ? "reclaimed" : "skipped";
    expect(remote.completed.get(job.job.id)).toMatchObject({
      status: "done",
      result: { kind: expected },
    });
    expect(existsSync(path)).toBe(expected !== "reclaimed");
  }
}, 20_000);

it("runs a cloud Automation Run through connect/inbox/journal: fenced context, runner-born Session, drained creation", async () => {
  const f = fixture();
  const a = f.store();
  expect(a.jobCapabilities).toEqual(["automation.run"]);
  const remote = connect(f, a);
  const SESSION = "00000000-0000-4000-8000-000000000041";
  const RUN = "00000000-0000-4000-8000-000000000042";
  const AUTOMATION = "00000000-0000-4000-8000-000000000043";
  const payload = {
    trigger: "arrival",
    automationId: AUTOMATION,
    ticketId: TICKET,
    from: "todo",
    status: "doing",
    origin: "chosen",
    armedByUserId: null,
    runId: RUN,
    sessionId: SESSION,
    dueAt: 0,
    missedCount: 0,
    attendance: "attended",
    modelOverride: null,
    requestedBySessionId: null,
  };
  remote.query.mockImplementation((async (name: string, input: Record<string, unknown>) =>
    name === "automationRunner:runContext"
      ? {
          kind: "ready",
          payload,
          projectId: PROJECT,
          automation: {
            id: AUTOMATION,
            projectId: PROJECT,
            name: "Review",
            instructions: "Review the work",
            trigger: { kind: "columns", columns: ["doing"] },
            runtime: null,
            deletedAt: null,
          },
          ticket: { id: TICKET, projectId: PROJECT, status: "doing", archived: false },
          columnArming: null,
          scheduleArming: null,
          previousRunActive: false,
        }
      : { ...f.facts, sessionId: input.sessionId, ownerUserId: a.ownerUserId }) as never);
  const model = { providerId: "scripted", modelId: "test", reasoningLevel: "off" } as const;
  const command = vi.fn(async () => ({ receipt: { status: "accepted" } }));
  a.bindAutomations({
    sessions: {
      // The facade's runner-born birth, over this store's owner engine.
      create: async (input) => {
        await a.sessionBirth.beforeCreate(input);
        await a.engine.createSession({
          commandId: `${input.operationId}:create`,
          requestedSessionId: input.requestedSessionId!,
          projectId: input.projectId,
          ticketId: input.ticketId,
          role: input.role,
          parentSessionId: null,
          title: input.title,
          provenance,
        });
        return { sessionId: input.requestedSessionId!, model };
      },
      attach: async (input) => ({
        sessionId: input.sessionId,
        state: "ready",
        receipt: null,
        throughSequence: 0,
      }),
    },
    runtime: {
      command,
      openNativeBindings: () => [],
      reportMessageDeliveryFailure: async () => {},
    } as never,
    promptSupply: async () => ({ templates: [], skills: [] }),
    notify: () => {},
  });
  const job = {
    job: {
      id: "00000000-0000-4000-8000-000000000044",
      kind: "automation.run",
      runnerId: RUNNER_A,
      projectId: PROJECT,
      ticketId: TICKET,
      sessionId: SESSION,
      workingCopyId: null,
      commandId: null,
      payload,
      priority: "normal",
      createdBy: { kind: "volli", reason: "policy" },
      createdAt: 0,
      availableAt: 0,
    },
    lease: { bootId: "boot", attempt: 1, expiresAt: Date.now() + 60_000 },
  } as unknown as ClaimedJob;
  remote.queued.push(job);
  remote.sync.start();
  await vi.waitFor(() => expect(remote.completed.get(job.job.id)?.status).toBe("done"), {
    timeout: 10_000,
  });
  expect(remote.completed.get(job.job.id)).toEqual({
    status: "done",
    result: { kind: "started", sessionId: SESSION, model, attendance: "attended" },
  });
  expect(remote.query).toHaveBeenCalledWith("automationRunner:runContext", {
    jobId: job.job.id,
    bootId: "boot",
    attempt: 1,
  });
  expect(command).toHaveBeenCalledOnce();
  // The Session is this owner's and its creation drains to Volli Cloud.
  expect(a.ownsSession(SESSION)).toBe(true);
  await a.drain.idle();
  expect(remote.accepted).toContainEqual(
    expect.objectContaining({ sessionId: SESSION, kind: "session.created" }),
  );
}, 20_000);
