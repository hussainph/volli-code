/**
 * A Mac runner's sleep and wake, end to end in plain Node (VC-895):
 * "Waiting for <Mac>", and back.
 *
 * Everything on the runner side is the real composition the desktop runs
 * (`connection.ts` + the cloud store's `connect`): the backend link and its
 * mutation gate, the presence loop, the fact drain, the inbox worker, all
 * under `startRunnerSync`, and the power cycle under `watchSleep`, with sync
 * paused before the `asleep` report and resumed after the wake sequence, as
 * `runnerConnector` wraps it. Only the
 * backend is in memory, behind the link's own `BackendConnection` port:
 *
 * - it keeps `runnerJobs`' lease rules (`convex/functions/runnerJobs.ts`,
 *   `lib/jobs.ts`): a lease that runs out goes back to the queue with a
 *   backoff, `claim` leases it again at the next attempt (which fences the
 *   old one), and `renew` of a lapsed lease nothing replaced takes it back
 *   under the same attempt;
 * - `sessions.accept` is contiguous by sequence, duplicates allowed;
 * - runner status: `reportState` sets it, a beat flips `asleep`/`offline`
 *   back to `online`, and nothing else moves `asleep` (the offline sweep
 *   leaves it, `RUNNER_REPORTED_STATES`);
 * - each connection behaves like the stock Convex client: calls take a round
 *   trip, calls made while it is down are sent when it reconnects by itself,
 *   a closed connection sends nothing more, and a live query is answered
 *   once on (re)connect and after every write.
 *
 * Mac B's words are the shared `sessionPlaceState` / `pendingCommandLabel`
 * over the backend's runner row, i.e. what `runners.places` answers for a
 * Session Mac B can see (that query's visibility is `convex/test/runnerPlaces.test.ts`).
 *
 * **Sleep is simulated, and labelled so.** As in the desktop's smoke seam:
 * the real `suspend` is emitted, the `asleep` report lands, then the network
 * goes down. "Ten minutes asleep" moves the wall clock without running a
 * timer, which is what macOS sleep does to a process (its monotonic clock,
 * which timers run on, stops; `Date.now()` jumps).
 */
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { SessionEvent } from "@volli/shared";
import {
  JOB_LEASE_MS,
  pendingCommandLabel,
  sessionPlaceState,
  type ClaimedJob,
  type JobOutcome,
  type RunnerCapabilityReport,
  type RunnerLoad,
} from "@volli/shared/cloud";

import type { PowerPort } from "../ports/power";
import { createBackendLink, type BackendConnection, type ConnectBackend } from "./backend-link";
import {
  createFactDrain,
  type DrainCursor,
  type DrainCursorStore,
  type DrainLedger,
} from "./drain";
import { createMutationGate } from "./flow";
import { createInboxWorker, type JobJournalEntry, type JobJournalStore } from "./inbox";
import { createRunnerPresence, runnerPresenceBackend } from "./presence";
import { acceptOverLink, inboxOverLink, startRunnerSync, wakeOverLink } from "./sync";
import { createRunnerPowerCycle, watchSleep } from "./wake";

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const RUNNER = "00000000-0000-4000-8000-0000000000a2";
const BOOT = "00000000-0000-4000-8000-0000000000a3";
const PROJECT = "00000000-0000-4000-8000-0000000000a4";
const SESSION = "00000000-0000-4000-8000-0000000000a5";
/** A long job that is running when the lid closes (a clone). */
const MATERIALIZE = "00000000-0000-4000-8000-0000000000b1";
/** Mac B's command, sent while Mac A sleeps. */
const SEND = "00000000-0000-4000-8000-0000000000b2";
const NAME = "hp-mac-dev";

/** One call's round trip. */
const RTT_MS = 40;
/** A connection's (re)connect handshake. */
const HANDSHAKE_MS = 20;
/** `retryDelayMs(1)` in `convex/functions/lib/jobs.ts`: the backoff after a lapsed first lease. */
const LAPSED_RETRY_MS = 5_000;
const ASLEEP_FOR_MS = 10 * 60_000;

const LOAD: RunnerLoad = {
  activeSessions: 1,
  activeTurns: 0,
  queueDepth: 0,
  freeDiskMb: 10_000,
  freeMemMb: 4_000,
};
/** The presence loop only compares and forwards the report; its fields are N1's tests'. */
const CAPABILITIES = { version: 1 } as unknown as RunnerCapabilityReport;

type JobRow = {
  job: ClaimedJob["job"];
  status: "queued" | "leased" | "done" | "failed";
  lease: { bootId: string; attempt: number; expiresAt: number } | null;
  availableAt: number;
  failure: { attempt: number; by: "runner" | "backend" } | null;
  outcome: { attempt: number; outcome: JobOutcome } | null;
};

type Applied = { at: number; connection: number; name: string; args: Record<string, unknown> };

type LeaseRef = { bootId: string; attempt: number };

const isLease = (row: JobRow, ref: LeaseRef) =>
  row.lease !== null && row.lease.bootId === ref.bootId && row.lease.attempt === ref.attempt;

/** `leaseMayContinue` (convex/functions/lib/jobs.ts). */
const mayContinue = (row: JobRow, ref: LeaseRef) =>
  isLease(row, ref) &&
  (row.status === "leased" ||
    (row.status === "queued" &&
      !(row.failure?.by === "runner" && row.failure.attempt === ref.attempt)));

const refusal = (code: string, acceptedThrough: number) =>
  Object.assign(new Error(code), { data: { code, message: code, acceptedThrough } });

/** The backend, in memory. */
function fakeCloud() {
  let network = true;
  const connections: FakeConnection[] = [];
  const applied: Applied[] = [];
  const statuses: { at: number; status: string }[] = [];
  const runner = { status: "offline", statusChangedAt: 0, lastBeatAt: 0 };
  const jobs = new Map<string, JobRow>();
  const heads = new Map<string, number>();

  function setStatus(status: string) {
    if (runner.status === status) return;
    runner.status = status;
    runner.statusChangedAt = Date.now();
    statuses.push({ at: Date.now(), status });
  }

  /** `expireLease`, applied whenever the backend is read (its scheduled check, done lazily). */
  function lapse(now: number) {
    for (const row of jobs.values()) {
      if (row.status !== "leased" || row.lease!.expiresAt > now) continue;
      row.status = "queued";
      row.availableAt = row.lease!.expiresAt + LAPSED_RETRY_MS;
      row.failure = { attempt: row.lease!.attempt, by: "backend" };
    }
  }

  function wake() {
    const now = Date.now();
    lapse(now);
    let ready = 0;
    let next: number | null = null;
    for (const row of jobs.values()) {
      if (row.status !== "queued") continue;
      if (row.availableAt <= now) ready += 1;
      else next = next === null ? row.availableAt : Math.min(next, row.availableAt);
    }
    return { ready: Math.min(ready, 4), nextAvailableAt: next };
  }

  function apply(connection: number, name: string, args: Record<string, unknown>): unknown {
    const now = Date.now();
    applied.push({ at: now, connection, name, args });
    switch (name) {
      case "runners:reportCapabilities":
        return null;
      case "runners:reportState":
        setStatus(args.state as string);
        return null;
      case "runners:heartbeat":
        runner.lastBeatAt = now;
        if (["offline", "stopped", "asleep"].includes(runner.status)) setStatus("online");
        return {
          serverTime: now,
          status: runner.status,
          targetVersion: null,
          minVersion: null,
          autoUpdate: { enabled: false, channel: "stable", pinnedVersion: null },
        };
      case "sessions:accept": {
        const sessionId = args.sessionId as string;
        let head = heads.get(sessionId) ?? 0;
        let duplicates = 0;
        for (const text of args.events as string[]) {
          const { sequence } = JSON.parse(text) as { sequence: number };
          if (sequence <= head) {
            duplicates += 1;
            continue;
          }
          if (sequence !== head + 1) throw refusal("out_of_order", head);
          head = sequence;
        }
        heads.set(sessionId, head);
        return { acceptedThrough: head, duplicates, quarantined: 0 };
      }
      case "runnerJobs:claim": {
        lapse(now);
        const claimed: ClaimedJob[] = [];
        for (const row of jobs.values()) {
          if (claimed.length >= (args.max as number)) break;
          const elsewhere = row.status === "leased" && row.lease!.bootId !== args.bootId;
          const ready = row.status === "queued" && row.availableAt <= now;
          if (!elsewhere && !ready) continue;
          row.status = "leased";
          row.lease = {
            bootId: args.bootId as string,
            attempt: (row.lease?.attempt ?? 0) + 1,
            expiresAt: now + JOB_LEASE_MS,
          };
          claimed.push({ job: row.job, lease: { ...row.lease } });
        }
        return claimed;
      }
      case "runnerJobs:renew": {
        lapse(now);
        const row = jobs.get(args.jobId as string);
        const ref = { bootId: args.bootId as string, attempt: args.attempt as number };
        if (row === undefined) return { ok: false, reason: "gone" };
        if (!mayContinue(row, ref)) return { ok: false, reason: "fenced" };
        const extended = now + ((args.extendMs as number | undefined) ?? JOB_LEASE_MS);
        if (row.status === "leased") {
          row.lease!.expiresAt = Math.max(row.lease!.expiresAt, extended);
        } else {
          row.status = "leased";
          row.lease = { ...ref, expiresAt: extended };
        }
        return { ok: true, lease: { ...row.lease! } };
      }
      case "runnerJobs:complete": {
        lapse(now);
        const row = jobs.get(args.jobId as string);
        const ref = { bootId: args.bootId as string, attempt: args.attempt as number };
        if (row === undefined) return { ack: "superseded", reason: "gone" };
        if (row.outcome?.attempt === ref.attempt) return { ack: "duplicate", status: row.status };
        if (!mayContinue(row, ref)) return { ack: "superseded", reason: "fenced" };
        const outcome = args.outcome as JobOutcome;
        row.outcome = { attempt: ref.attempt, outcome };
        if (outcome.status === "done") row.status = "done";
        else if (outcome.retryable) {
          row.status = "queued";
          row.availableAt = now + LAPSED_RETRY_MS;
          row.failure = { attempt: ref.attempt, by: "runner" };
        } else row.status = "failed";
        return { ack: "recorded", status: row.status };
      }
      default:
        throw new Error(`The in-memory backend has no ${name}`);
    }
  }

  /** Every live query of every connection that is up, answered again after a write. */
  function publish() {
    for (const connection of connections) connection.answerQueries();
  }

  const cloud = {
    connections,
    applied,
    statuses,
    runner,
    heads,
    get network() {
      return network;
    },
    apply(connection: number, name: string, args: Record<string, unknown>) {
      try {
        return apply(connection, name, args);
      } finally {
        publish();
      }
    },
    query(name: string): unknown {
      if (name === "runnerJobs:wake") return wake();
      throw new Error(`The in-memory backend has no live query ${name}`);
    },
    setNetwork(up: boolean) {
      network = up;
      for (const connection of connections) connection.networkChanged();
    },
    /** A job the backend queued (Mac B's command, a board effect). */
    enqueue(id: string, kind: string, sessionId: string | null) {
      jobs.set(id, {
        job: {
          id,
          runnerId: RUNNER,
          kind,
          projectId: PROJECT,
          sessionId,
          ticketId: null,
          workingCopyId: null,
          commandId: kind === "session.command" ? id : null,
          payload: {},
          priority: "normal",
          createdBy: { kind: "user", userId: OWNER },
          createdAt: Date.now(),
          availableAt: Date.now(),
        } as unknown as ClaimedJob["job"],
        status: "queued",
        lease: null,
        availableAt: Date.now(),
        failure: null,
        outcome: null,
      });
      publish();
    },
    /** A job as the backend holds it now (its lapsed leases applied). */
    job(id: string): JobRow {
      lapse(Date.now());
      return jobs.get(id)!;
    },
    connect: ((token) => {
      const connection = new FakeConnection(cloud, connections.length + 1, token);
      connections.push(connection);
      return connection;
    }) as ConnectBackend,
  };
  return cloud;
}

type FakeCloud = ReturnType<typeof fakeCloud>;

/** What a connection reaches of the backend. */
interface CloudWire {
  readonly network: boolean;
  apply(connection: number, name: string, args: Record<string, unknown>): unknown;
  query(name: string): unknown;
}

/** One connection, with the stock Convex client's behaviour around outages. */
class FakeConnection implements BackendConnection {
  private up = false;
  private closed = false;
  private dialing = false;
  /** Sends waiting for the connection to come back. */
  private outbox: (() => void)[] = [];
  private readonly changes = new Set<(connected: boolean) => void>();
  private readonly queries = new Set<{
    name: string;
    listener: (value: unknown) => void;
    last: string | null;
  }>();

  constructor(
    private readonly cloud: CloudWire,
    readonly id: number,
    private readonly token: Parameters<ConnectBackend>[0],
  ) {
    this.dial();
  }

  private dial() {
    if (this.closed || this.up || this.dialing || !this.cloud.network) return;
    this.dialing = true;
    setTimeout(() => {
      void (async () => {
        this.dialing = false;
        if (this.closed || !this.cloud.network) return;
        await this.token({ forceRefreshToken: false });
        if (this.closed || !this.cloud.network) return;
        this.up = true;
        // What waited is sent first, then the client says it is connected.
        for (const send of this.outbox.splice(0)) send();
        for (const listener of this.changes) listener(true);
        this.answerQueries();
      })();
    }, HANDSHAKE_MS);
  }

  networkChanged() {
    if (this.closed) return;
    if (this.cloud.network) {
      this.dial();
      return;
    }
    if (!this.up) return;
    this.up = false;
    for (const listener of this.changes) listener(false);
  }

  answerQueries() {
    if (!this.up || this.closed) return;
    for (const query of this.queries) {
      setTimeout(() => {
        if (!this.up || this.closed || !this.queries.has(query)) return;
        const value = this.cloud.query(query.name);
        const key = JSON.stringify(value);
        if (key === query.last) return;
        query.last = key;
        query.listener(value);
      }, RTT_MS / 2);
    }
  }

  mutation(name: string, args: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const send = () => {
        setTimeout(() => {
          // A closed client sends nothing more; its caller (the link) gave up on it.
          if (this.closed) return;
          // Dropped on the way: the client sends it again when it reconnects.
          if (!this.up) {
            this.outbox.push(send);
            return;
          }
          try {
            resolve(this.cloud.apply(this.id, name, args));
          } catch (error) {
            reject(error);
          }
        }, RTT_MS);
      };
      if (this.up) send();
      else this.outbox.push(send);
    });
  }

  onUpdate(name: string, _args: Record<string, unknown>, listener: (value: unknown) => void) {
    const query = { name, listener, last: null as string | null };
    this.queries.add(query);
    this.answerQueries();
    return () => void this.queries.delete(query);
  }

  isConnected() {
    return this.up && !this.closed;
  }

  onConnectionChange(listener: (connected: boolean) => void) {
    this.changes.add(listener);
    return () => void this.changes.delete(listener);
  }

  async close() {
    this.closed = true;
    this.up = false;
    this.outbox = [];
  }
}

function event(sessionId: string, sequence: number): SessionEvent {
  return {
    id: `${sessionId}:e${sequence}`,
    sessionId,
    sequence,
    occurredAt: sequence,
    recordedAt: sequence,
    attachmentId: null,
    commandId: null,
    provenance: { kind: "test" },
    payload: { kind: "note.recorded", text: `fact ${sequence}` },
  } as unknown as SessionEvent;
}

/** The runner-local ledger the drain reads (the Session tables, in memory). */
function memoryLedger() {
  const events: SessionEvent[] = [];
  const ledger: DrainLedger = {
    listEvents: ({ afterSequence, limit }) =>
      events.filter((e) => e.sequence > afterSequence).slice(0, limit),
    latestEventSequence: () => events.length,
  };
  return {
    ledger,
    append(count: number) {
      for (let n = 0; n < count; n += 1) events.push(event(SESSION, events.length + 1));
      return events.length;
    },
  };
}

function memoryCursors(initial: DrainCursor): DrainCursorStore {
  const rows = new Map([[initial.sessionId, initial]]);
  return {
    list: () => [...rows.values()],
    get: (sessionId) => rows.get(sessionId) ?? null,
    save: (cursor) => void rows.set(cursor.sessionId, cursor),
    update: (cursor) =>
      rows.get(cursor.sessionId)?.ownerUserId === cursor.ownerUserId &&
      !!rows.set(cursor.sessionId, cursor),
  };
}

function memoryJournal(): JobJournalStore {
  const entries = new Map<string, JobJournalEntry>();
  return {
    get: (jobId) => entries.get(jobId) ?? null,
    save: (entry) => void entries.set(entry.jobId, { ...entry }),
    unreported: () => [...entries.values()].filter((entry) => entry.outcome !== null),
    remove(jobId, attempt) {
      if (entries.get(jobId)?.lease.attempt === attempt) entries.delete(jobId);
    },
  };
}

/** Mac A: the runner, composed as the desktop composes it, over the in-memory backend. */
function macA(cloud: FakeCloud) {
  const tokens: { at: number; force: boolean }[] = [];
  const token = async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
    tokens.push({ at: Date.now(), force: forceRefreshToken });
    return "runner-token";
  };
  const link = createBackendLink({ connect: cloud.connect, token, gate: createMutationGate() });
  const presence = createRunnerPresence({
    backend: runnerPresenceBackend(link.call),
    bootId: BOOT,
    readLoad: () => LOAD,
    readCapabilities: () => CAPABILITIES,
  });
  const ledger = memoryLedger();
  const drain = createFactDrain({
    ledger: ledger.ledger,
    cursors: memoryCursors({
      sessionId: SESSION,
      ownerUserId: OWNER,
      generation: 1,
      acceptedThrough: 0,
      blocked: null,
    }),
    accept: acceptOverLink(link),
    ownerUserId: OWNER,
  });
  const inbox = createInboxWorker({
    backend: inboxOverLink(link),
    journal: memoryJournal(),
    wake: wakeOverLink(link),
    bootId: BOOT,
  });

  /** Every time an executor started a job, under which lease, and whether it was taken away. */
  const runs: { jobId: string; attempt: number; signal: AbortSignal }[] = [];
  let finishMaterialize: (() => void) | null = null;
  inbox.register("workingCopy.materialize", (claimed, context) => {
    runs.push({ jobId: claimed.job.id, attempt: claimed.lease.attempt, signal: context.signal });
    return new Promise<JobOutcome>((resolve) => {
      finishMaterialize = () => resolve({ status: "done", result: { materialized: true } });
      context.signal.addEventListener("abort", () =>
        resolve({
          status: "failed",
          code: "lease_lost",
          detail: String(context.signal.reason),
          retryable: false,
        }),
      );
    });
  });
  // A Session command lands as facts in the runner's ledger, which the drain then ships.
  inbox.register("session.command", async (claimed, context) => {
    runs.push({ jobId: claimed.job.id, attempt: claimed.lease.attempt, signal: context.signal });
    ledger.append(2);
    drain.nudge(SESSION);
    return { status: "done", result: null };
  });

  const sync = startRunnerSync({ link, drain, inbox, presence });
  const power = new EventEmitter() as EventEmitter & PowerPort;
  const cycle = createRunnerPowerCycle({ link, token, presence });
  // As `runnerConnector` wraps the cycle (sync paused before the asleep
  // report, resumed after the wake sequence) and `mac-runner.ts` calls it.
  const offPower = watchSleep(power, {
    onSleep: () => {
      sync.suspend();
      void cycle.suspend();
    },
    onWake: () => void cycle.resume().then(() => sync.resume()),
  });
  return {
    link,
    presence,
    drain,
    inbox,
    ledger,
    power,
    runs,
    tokens,
    finishMaterialize: () => finishMaterialize?.(),
    async stop() {
      offPower();
      const stopping = sync.stop();
      await vi.advanceTimersByTimeAsync(6_000);
      await stopping;
    },
  };
}

/** Mac B's words for the Session, from the backend's row for its Place. */
function macBSees(cloud: FakeCloud) {
  const place = sessionPlaceState({
    session: { turnActive: false },
    runner: {
      id: RUNNER,
      name: NAME,
      kind: "mac",
      status: cloud.runner.status,
      statusChangedAt: cloud.runner.statusChangedAt,
      statusReason: null,
      owned: true,
    },
    viewerRunnerId: null,
    now: Date.now(),
    formatSince: (at) => hhmm(at),
  });
  return { place, pending: pendingCommandLabel(place) };
}

const hhmm = (at: number) => new Date(at).toISOString().slice(11, 16);

async function until(what: string, check: () => boolean, withinMs = 30_000) {
  const deadline = Date.now() + withinMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
    await vi.advanceTimersByTimeAsync(10);
  }
}

/** The runner-job calls the backend applied from `since` on, in its order. */
function jobCalls(cloud: FakeCloud, since: number) {
  return cloud.applied
    .filter(({ at, name }) => at >= since && name.startsWith("runnerJobs:"))
    .map(({ name, args }) =>
      name === "runnerJobs:claim"
        ? "claim"
        : `${name.slice("runnerJobs:".length)} ${String(args.jobId)}#${String(args.attempt)}`,
    );
}

/**
 * Up to the lid closing, the same for every wake: a Session with facts
 * accepted, a long job running under its first lease, Mac B watching.
 * Then the simulated sleep, ten minutes of it, and Mac B's command.
 */
async function sleepTenMinutes() {
  const cloud = fakeCloud();
  const a = macA(cloud);
  await until("Mac A online", () => cloud.runner.status === "online" && a.presence.connected);

  a.ledger.append(3);
  a.drain.nudge(SESSION);
  await until("the first facts accepted", () => cloud.heads.get(SESSION) === 3);

  cloud.enqueue(MATERIALIZE, "workingCopy.materialize", null);
  await until("the clone claimed and running", () => a.runs.length === 1);
  expect(a.runs[0]).toMatchObject({ jobId: MATERIALIZE, attempt: 1 });
  expect(macBSees(cloud)).toEqual({
    place: expect.objectContaining({ kind: "online", label: `Running on ${NAME}` }),
    pending: null,
  });

  // The lid closes (SIMULATED): the real suspend, the asleep report lands,
  // then the network goes, with two facts the turn wrote still unsent.
  const suspendAt = Date.now();
  a.power.emit("suspend");
  await until("asleep reported", () => cloud.runner.status === "asleep", 3_000);
  const asleepSince = cloud.runner.statusChangedAt;
  expect(asleepSince - suspendAt).toBeLessThanOrEqual(2 * RTT_MS);
  cloud.setNetwork(false);
  const head = a.ledger.append(2);
  a.drain.nudge(SESSION);

  // Ten minutes asleep: the wall clock moves, no timer runs.
  vi.setSystemTime(Date.now() + ASLEEP_FOR_MS);

  // Mac B, meanwhile: waiting, since the moment the lid closed.
  expect(macBSees(cloud).place).toMatchObject({
    kind: "waiting",
    reason: "asleep",
    since: asleepSince,
    label: `Waiting for ${NAME} — asleep since ${hhmm(asleepSince)}`,
  });
  // The clone's lease ran out and went back to the queue.
  expect(cloud.job(MATERIALIZE)).toMatchObject({
    status: "queued",
    lease: { bootId: BOOT, attempt: 1 },
    failure: { attempt: 1, by: "backend" },
  });
  // Mac B sends; it waits in the inbox.
  cloud.enqueue(SEND, "session.command", SESSION);
  expect(macBSees(cloud).pending).toBe(`Sent — waiting for ${NAME}`);
  expect(cloud.job(SEND).status).toBe("queued");
  expect(cloud.heads.get(SESSION)).toBe(3);
  return { cloud, a, head, asleepSince };
}

/** After the wake: everything caught up, and nothing ran twice. */
async function expectCaughtUp(
  { cloud, a, head }: Awaited<ReturnType<typeof sleepTenMinutes>>,
  thawAt: number,
) {
  await until("Mac B's command delivered", () => cloud.job(SEND).status === "done");
  await until(
    "every fact accepted",
    () => cloud.heads.get(SESSION) === head + 2 && a.drain.status().waiting === 0,
  );
  const calls = jobCalls(cloud, thawAt);
  const renew = calls.indexOf(`renew ${MATERIALIZE}#1`);
  const claim = calls.indexOf("claim");
  const order = calls.join(", ");
  expect(renew, `the running clone's lease is renewed after the wake: ${order}`).not.toBe(-1);
  expect(claim, `a claim after the wake: ${order}`).not.toBe(-1);
  // Renew before claim: a claim first would lease the lapsed clone again at attempt 2.
  expect(renew, `renew before claim: ${order}`).toBeLessThan(claim);
  expect(cloud.job(MATERIALIZE)).toMatchObject({ status: "leased", lease: { attempt: 1 } });
  // The clone ran once, under its first lease, through the sleep; Mac B's command once.
  expect(a.runs.map(({ jobId, attempt, signal }) => [jobId, attempt, signal.aborted])).toEqual([
    [MATERIALIZE, 1, false],
    [SEND, 1, false],
  ]);

  a.finishMaterialize();
  await until("the clone's outcome recorded", () => cloud.job(MATERIALIZE).status === "done");
  expect(cloud.job(MATERIALIZE).outcome?.attempt).toBe(1);

  expect(cloud.runner.status).toBe("online");
  expect(macBSees(cloud)).toEqual({
    place: expect.objectContaining({ kind: "online", label: `Running on ${NAME}` }),
    pending: null,
  });
  // asleep at the suspend, online after the wake, nothing in between.
  expect(cloud.statuses.map(({ status }) => status)).toEqual(["online", "asleep", "online"]);
  expect(cloud.statuses[2]!.at).toBeGreaterThanOrEqual(thawAt);
  await a.stop();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T14:01:30.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a Mac runner's wake sequence (SIMULATED sleep: power events + network barrier)", () => {
  it("lid opens, then the network: online within one round trip, renew before claim, facts and Mac B's command catch up", async () => {
    const asleep = await sleepTenMinutes();
    const { cloud, a } = asleep;
    const thawAt = Date.now();
    a.power.emit("resume");
    cloud.setNetwork(true);

    // The wake sequence's order (wake.ts): replace the connection, force a
    // fresh token, report online, beat; then sync renews, claims and drains.
    expect(a.tokens.find(({ at }) => at >= thawAt)?.force).toBe(true);
    await until("Mac A online again", () => cloud.runner.status === "online", 2_000);
    const firstWakeReport = cloud.applied.find(
      ({ at, name }) => at >= thawAt && name.startsWith("runners:"),
    );
    expect(firstWakeReport).toMatchObject({
      name: "runners:reportState",
      args: { state: "online" },
    });
    // Within one round trip of the new connection coming up, not at the next 30 s beat.
    expect(cloud.runner.statusChangedAt - thawAt).toBeLessThanOrEqual(HANDSHAKE_MS + 2 * RTT_MS);

    await expectCaughtUp(asleep, thawAt);
  });

  // Regression for the reconnect race: the stock client is back on its own
  // (Wi-Fi up, or a dark wake) a moment before the wake event replaces the
  // connection. Before sync paused across sleep, that reconnect's catch-up
  // renew was on the wire when the wake stranded it (LinkResetError, read as
  // transient), and the catch-up claimed anyway, on the next connection,
  // ahead of the next renew: the lapsed clone was leased again at attempt 2,
  // its running attempt 1 fenced, aborted, and run again later.
  it("network back just before the wake event: still renew before claim, and the running job is never fenced", async () => {
    const asleep = await sleepTenMinutes();
    const { cloud, a } = asleep;
    const thawAt = Date.now();
    cloud.setNetwork(true);
    await until("the link back by itself", () => a.link.status.state === "connected", 2_000);
    // At once: within the round trip a reconnect catch-up's renew would take.
    a.power.emit("resume");

    await expectCaughtUp(asleep, thawAt);
  });
});
