/**
 * VC-456: VC-441's scripted turn, driven through Volli's real turn path.
 *
 * VC-441 (`packages/agent-runtime/bench/turn-to-completion/measurement.ts`) ran
 * its turns straight against VC-119's instrumentation, so no Session runtime,
 * input queue, agent loop or ledger was on the path, and a queue
 * in any of them was absent by construction. This composition puts every one of
 * them back, in one Node process with no Electron:
 *
 * - **Session runtime.** `createSessionRuntime` from `@volli/session-engine`,
 *   composed port for port as `createDesktopSessionRuntime` composes it: the
 *   Session Engine over the desktop's `SqliteSessionLedger`, the file
 *   transcript-artifact store, one checkpoint failure reporter, `Date.now`,
 *   random ids, and the opt-in VC-119 sink. Two ports differ, both listed in
 *   {@link createRealPathComposition}.
 * - **Input queue.** Every message goes through `SessionRuntime.command`, so it
 *   takes the real per-Session admission tail, binding lookup and dispatch, and
 *   `turn-queue` is the runtime's own measurement (VC-455), not a timer.
 * - **Agent loop.** The real desktop Pi adapter (`createPiRuntimeHost`) over the
 *   real `createPiAgentRuntime`: Pi's `Agent`, stream supervision, VC-119's
 *   `instrumentStreamFn`, the real `read` and `bash` tools, and overflow
 *   compaction through Pi's own summarizer. Only the provider is a stand-in:
 *   `realPathProvider` from `@volli/agent-runtime/bench/turn-to-completion`.
 * - **Ledger.** A disposable profile directory holding a migrated `volli.db`
 *   opened by the production `openVolliDb`, a transcript directory and Pi's
 *   session sidecars. The directory is deleted when the composition closes.
 *
 * Nothing opens a socket: `globalThis.fetch` is replaced for the whole run with
 * one that counts and refuses, and the usage-limit probe is handed the same
 * refusal. No real profile, Session, credential or file outside the disposable
 * directory is read.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers";
import {
  realPathProvider,
  type RealPathRequestKind,
} from "@volli/agent-runtime/bench/turn-to-completion";
import {
  createInMemoryTranscriptArtifactStore,
  createSessionEngine,
  createSessionRuntime,
  isSessionStreamFrame,
  sessionRootThreadId,
  type SessionLocationResolver,
  type TranscriptArtifactStore,
} from "@volli/session-engine";
import { type ObservabilityEvent, type ObservabilitySink, type SessionLedger } from "@volli/shared";

import { openVolliDb } from "@volli/host-core/db";
import { insertProject } from "@volli/host-core/db/projects-repo";
import {
  createCheckpointFailureReporter,
  createSqliteSessionLedger,
} from "@volli/host-core/session-control";
import {
  createPiRuntimeHost,
  type PiRuntimeContext,
} from "@volli/host-core/session-runtime/pi-adapter";
import { createFileTranscriptArtifactStore } from "@volli/host-core/session-runtime/transcript-artifacts";

import { PRIVATE_CONTENT_CANARY, type SubscriberMode } from "./constants";

export { PRIVATE_CONTENT_CANARY, type SubscriberMode } from "./constants";

const FIXTURE_TOOL_SURFACE = ["read", "edit", "write", "execute"] as const;

/** Which transcript-artifact store the composition runs on. */
export type ArtifactStoreKind = "file" | "memory";

export interface RealPathOptions {
  /**
   * `file` (the default) is the production store. `memory` is a diagnostic
   * control only: the Session engine's in-memory store, used to attribute time
   * to artifact durability. The headline arms always run `file`.
   */
  artifactStore?: ArtifactStoreKind;
  /** Text deltas the provider stand-in streams per reply. Default 8. */
  deltasPerReply?: number;
  /**
   * `all` (the default): every Session has a live subscriber, as a chat open
   * in a tab does. `none`: nobody subscribes, as for Sessions working in the
   * background.
   */
  subscribers?: SubscriberMode;
}

/** One durable fact as the Session Engine committed it. */
export interface LedgerCommit {
  sequence: number;
  kind: string;
  commandId: string | null;
  /** `performance.now()` when the engine call that wrote it resolved. */
  committedAt: number;
}

/** One VC-119 envelope as the shared sink saw it. */
export interface RecordedEnvelope {
  event: ObservabilityEvent;
  /** `performance.now()` when the sink received it. */
  recordedAt: number;
  /** Position in the sink's own emission order, across every Session. */
  order: number;
  /**
   * The Session whose async work recorded it, read from an `AsyncLocalStorage`
   * scope the harness opens around each Session's commands. VC-119 envelopes
   * carry no Session identity by design (a `runId` at most, and `turn-queue`
   * not even that), so this is how the bench joins them to a turn. Null means
   * the envelope escaped every scope; the run refuses to publish if one does.
   */
  sessionId: string | null;
}

/** One durable ledger fact as a live subscriber received it: kind and position, no content. */
export interface LedgerFrame {
  sequence: number;
  kind: string;
  commandId: string | null;
  /** `performance.now()` when the subscriber received the frame. */
  arrivedAt: number;
}

export interface TimerSample {
  kind: "ttft" | "completion";
  /** Signed: negative when Node fired the timer before its target. */
  latenessMs: number;
}

/** One transcript-artifact store call, timed around the real store. */
export interface ArtifactCall {
  op: "write" | "read";
  durationMs: number;
}

/** One `SessionLedger.transaction`, timed around the desktop's SQLite ledger. */
export interface LedgerTransaction {
  /** From the call to the moment its work began: time behind the ledger's queue. */
  waitMs: number;
  /** The work itself, which runs synchronously on the event loop. */
  serviceMs: number;
}

/** Everything one measured turn left behind, before analysis. */
export interface RawTurn {
  sessionId: string;
  concurrency: number;
  wave: number;
  commandId: string;
  /** `performance.now()` just before `command(message.submit)` was called. */
  submittedAt: number;
  /** When `command()` resolved: the default `turn` settle, so after the turn ended. */
  resolvedAt: number;
  receiptStatus: string | null;
  envelopes: RecordedEnvelope[];
  /** Every durable fact written for the turn, when its engine call resolved. */
  commits: LedgerCommit[];
  /** The Session's live frames from the submit on; empty without a subscriber. */
  frames: LedgerFrame[];
  /** The same Session's ledger, read back from SQLite after the wave settled. */
  ledger: Array<{ sequence: number; kind: string; commandId: string | null }>;
  /**
   * Session Engine calls made for this turn, by method. Counts, not times, so
   * they survive a loaded host: `listEvents` is one ledger read transaction.
   */
  engineCalls: Record<string, number>;
  timers: TimerSample[];
  artifactCalls: ArtifactCall[];
  ledgerTransactions: LedgerTransaction[];
  /** Time in the ledger's BEGIN IMMEDIATE and COMMIT statements for this turn. */
  ledgerBoundaryMs: number;
}

/** One wave: its turns, and what its measured phase cost the process. */
export interface WaveResult {
  turns: RawTurn[];
  /** From the first submit to the last turn's `command()` resolving. */
  measuredWallMs: number;
  /** Process CPU (user + system) over the same window: every Session's work on the one loop. */
  measuredCpuMs: number;
}

export interface RealPathComposition {
  readonly artifactStore: ArtifactStoreKind;
  readonly subscribers: SubscriberMode;
  /**
   * `around` wraps only the measured phase (every submit, until every turn
   * settled), so a diagnostic can profile it without setup or teardown.
   */
  runWave(input: {
    concurrency: number;
    wave: number;
    around?: (measure: () => Promise<void>) => Promise<void>;
  }): Promise<WaveResult>;
  /** Envelopes recorded outside every Session scope, across the composition's life. */
  unscopedEnvelopeCount(): number;
  /** Envelopes whose `runId` was recorded under two different Sessions. */
  runIdConflictCount(): number;
  /** Stand-in provider requests served, by kind. */
  requests(): Readonly<Record<RealPathRequestKind, number>>;
  /** Calls the refusing `fetch` stand-in received. Must stay zero. */
  networkAttempts(): number;
  close(): Promise<void>;
}

/** Per-Session evidence, filed under the Session's scope as it is produced. */
interface SessionEvidence {
  /** Session Engine calls made on this Session's behalf, by method. */
  engineCalls: Record<string, number>;
  commits: LedgerCommit[];
  timers: TimerSample[];
  artifactCalls: ArtifactCall[];
  ledgerTransactions: LedgerTransaction[];
  /** Time in the ledger's BEGIN IMMEDIATE and COMMIT statements. */
  ledgerBoundaryMs: number;
}

/**
 * The desktop's resolver reads the project row and takes a worktree start lease
 * through modules that import Electron. For a ticketless Session it resolves
 * the project root and does nothing else, so this answers that directory.
 */
function fixedLocations(directory: string): SessionLocationResolver {
  const at = async () => ({ directory, venue: { id: "local", kind: "local" as const } });
  return { resolve: at, prepare: at, reaffirm: async () => undefined };
}

/** The host engine's yield (`packages/host-core/src/session-control/index.ts`), which is private there. */
function yieldToMainProcess(): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    setImmediate(resolvePromise);
  });
}

interface WrittenEvent {
  sequence: number;
  commandId?: string | null;
  payload: Record<string, unknown>;
}

function isWrittenEvent(value: unknown): value is WrittenEvent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const payload = record["payload"];
  return (
    typeof record["sequence"] === "number" &&
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as Record<string, unknown>)["kind"] === "string"
  );
}

/**
 * The events one `observe` or `submit` committed: the event itself, or the
 * events a submit result carries beside its command (`commandEvent`, `event`,
 * `receiptEvent`), in sequence order.
 */
function writtenEvents(written: unknown): WrittenEvent[] {
  if (isWrittenEvent(written)) return [written];
  if (typeof written !== "object" || written === null) return [];
  return Object.values(written as Record<string, unknown>)
    .filter(isWrittenEvent)
    .toSorted((left, right) => left.sequence - right.sequence);
}

const doNothing = (): void => undefined;

export async function createRealPathComposition(
  options: RealPathOptions = {},
): Promise<RealPathComposition> {
  const profile = mkdtempSync(join(tmpdir(), "volli-vc456-profile-"));
  const realFetch = globalThis.fetch;
  const opened: { db?: { close(): unknown } } = {};
  try {
    return await compose(profile, realFetch, opened, options);
  } catch (error) {
    // A composition that failed to build leaves nothing behind: not the
    // refusing `fetch`, not the database handle, not the profile.
    opened.db?.close();
    globalThis.fetch = realFetch;
    rmSync(profile, { recursive: true, force: true });
    throw error;
  }
}

async function compose(
  profile: string,
  realFetch: typeof fetch,
  opened: { db?: { close(): unknown } },
  options: RealPathOptions,
): Promise<RealPathComposition> {
  const artifactStore = options.artifactStore ?? "file";
  const subscribers = options.subscribers ?? "all";
  const workspace = join(profile, "workspace");
  const sessionDataDir = join(profile, "pi-sessions");
  const transcriptDirectory = join(profile, "transcripts");
  for (const directory of [workspace, sessionDataDir, transcriptDirectory]) {
    mkdirSync(directory, { recursive: true });
  }
  const insideFile = join(workspace, "fixture-inside.txt");
  writeFileSync(insideFile, `${PRIVATE_CONTENT_CANARY}\n`.repeat(8));

  // Nothing on this path may reach a network; a call here fails the run.
  let networkAttempts = 0;
  const refusingFetch = (async () => {
    networkAttempts += 1;
    throw new Error("VC-456 bench: network access is refused");
  }) as typeof fetch;
  globalThis.fetch = refusingFetch;

  const scope = new AsyncLocalStorage<string>();
  const evidence = new Map<string, SessionEvidence>();
  const evidenceFor = (): SessionEvidence | undefined => {
    const sessionId = scope.getStore();
    return sessionId === undefined ? undefined : evidence.get(sessionId);
  };

  const envelopes: RecordedEnvelope[] = [];
  const runIdOwners = new Map<string, string>();
  let unscoped = 0;
  let runIdConflicts = 0;
  const sink: ObservabilitySink = {
    record(event) {
      const sessionId = scope.getStore() ?? null;
      if (sessionId === null) unscoped += 1;
      const runId = "runId" in event ? event.runId : undefined;
      if (runId !== undefined && sessionId !== null) {
        const owner = runIdOwners.get(runId);
        if (owner === undefined) runIdOwners.set(runId, sessionId);
        else if (owner !== sessionId) runIdConflicts += 1;
      }
      envelopes.push({ event, recordedAt: performance.now(), order: envelopes.length, sessionId });
    },
  };

  const provider = realPathProvider({
    replyText: PRIVATE_CONTENT_CANARY,
    toolCalls: [
      { name: "read", arguments: { path: insideFile } },
      { name: "bash", arguments: { command: "printf vc456" } },
    ],
    // Fired inside the stand-in's timer callbacks, which inherit the scope of
    // the Session whose request started them.
    onTimer: (kind, latenessMs) => evidenceFor()?.timers.push({ kind, latenessMs }),
    ...(options.deltasPerReply === undefined ? {} : { deltasPerReply: options.deltasPerReply }),
  });

  const db = openVolliDb(join(profile, "volli.db"));
  opened.db = db;
  const projectId = "vc456-project";
  insertProject(db, {
    id: projectId,
    name: "VC-456 fixture",
    path: workspace,
    ticketPrefix: "VC",
    baseBranch: null,
    setupCommand: null,
    colorIndex: 0,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
  });

  // Identity that main resolves from SQLite (`resolveRuntimeContext`); fixed
  // here because every Session is the same ticketless project Session.
  const context = (sessionId: string): PiRuntimeContext => ({
    role: "project",
    ticketId: null,
    projectId,
    rootThreadId: sessionRootThreadId(sessionId),
    brief: "VC-456 fixture Session. Run the scripted turn.",
    model: { providerId: provider.providerId, modelId: provider.modelId, reasoningLevel: "off" },
    toolSurface: [...FIXTURE_TOOL_SURFACE],
    promptResources: [],
  });

  const host = createPiRuntimeHost({
    sessionDataDir,
    resolveRuntimeContext: async (sessionId) => context(sessionId),
    models: provider.models,
    observability: sink,
    usageLimits: { fetch: refusingFetch },
  });

  // The host's private Session engine, with the ledger's transactions timed. The
  // ledger runs BEGIN IMMEDIATE and COMMIT outside the work callback, so the
  // handle it is given times those statements too. Both are filed under the
  // Session whose call queued the transaction: the ledger runs it as a
  // reaction registered in that caller's async context.
  const timedDb = new Proxy(db, {
    get(target, property) {
      if (property === "exec") {
        return (sql: string) => {
          const filed = evidenceFor();
          const startedAt = performance.now();
          try {
            return target.exec(sql);
          } finally {
            if (filed !== undefined) filed.ledgerBoundaryMs += performance.now() - startedAt;
          }
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const sqliteLedger = createSqliteSessionLedger(timedDb);
  const ledger: SessionLedger = {
    transaction(work) {
      const calledAt = performance.now();
      const filed = evidenceFor();
      return sqliteLedger.transaction((transaction) => {
        const startedAt = performance.now();
        try {
          return work(transaction);
        } finally {
          filed?.ledgerTransactions.push({
            waitMs: startedAt - calledAt,
            serviceMs: performance.now() - startedAt,
          });
        }
      });
    },
  };
  const onProjectionCheckpointFailure = createCheckpointFailureReporter();
  const now = Date.now;
  const desktopEngine = createSessionEngine({
    ledger,
    clock: { now },
    ids: { next: () => randomUUID() },
    onProjectionCheckpointFailure,
    yieldToHost: yieldToMainProcess,
  });
  // Counts each engine call under the Session it was made for, and files the
  // facts each write committed, with when its call resolved.
  const engine = new Proxy(desktopEngine, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const sessionId = scope.getStore();
        const filed = evidenceFor();
        if (filed !== undefined) {
          const name = String(property);
          filed.engineCalls[name] = (filed.engineCalls[name] ?? 0) + 1;
        }
        const result = (value as (...values: unknown[]) => unknown).apply(target, args);
        if (filed === undefined || sessionId === undefined || !(result instanceof Promise)) {
          return result;
        }
        if (property !== "observe" && property !== "submit") return result;
        return result.then((written: unknown) => {
          const committedAt = performance.now();
          for (const event of writtenEvents(written)) {
            const commit: LedgerCommit = {
              sequence: event.sequence,
              kind: String(event.payload["kind"]),
              commandId: event.commandId ?? null,
              committedAt,
            };
            filed.commits.push(commit);
          }
          return written;
        });
      };
    },
  });

  const innerArtifacts =
    artifactStore === "memory"
      ? createInMemoryTranscriptArtifactStore()
      : createFileTranscriptArtifactStore(transcriptDirectory);
  const timedArtifact = async <T>(op: ArtifactCall["op"], run: () => Promise<T>): Promise<T> => {
    const filed = evidenceFor();
    const startedAt = performance.now();
    try {
      return await run();
    } finally {
      filed?.artifactCalls.push({ op, durationMs: performance.now() - startedAt });
    }
  };
  const artifacts: TranscriptArtifactStore = {
    write: (artifact) => timedArtifact("write", () => innerArtifacts.write(artifact)),
    read: (reference) => timedArtifact("read", () => innerArtifacts.read(reference)),
  };

  // `createDesktopSessionRuntime`, port for port, except:
  // - `locations`: the Electron-free resolver above;
  // - `engine`: composed above so its ledger transactions can be timed. Same
  //   ledger class, clock, ids, reporter and host yield as the desktop's.
  const runtime = createSessionRuntime({
    engine,
    executor: host.adapter,
    artifacts,
    locations: fixedLocations(workspace),
    clock: { now },
    ids: { next: () => randomUUID() },
    onProjectionCheckpointFailure,
    observability: sink,
  });

  async function runWave(input: {
    concurrency: number;
    wave: number;
    around?: (measure: () => Promise<void>) => Promise<void>;
  }): Promise<WaveResult> {
    const { concurrency, wave } = input;
    // Setup, untimed: N fresh Sessions, each attached (and subscribed, when the
    // composition subscribes), so every measured turn is the first turn of an
    // identical Session.
    const sessions = await Promise.all(
      Array.from({ length: concurrency }, async (_value, index) => {
        const sessionId = randomUUID();
        const filed: SessionEvidence = {
          engineCalls: {},
          commits: [],
          timers: [],
          artifactCalls: [],
          ledgerTransactions: [],
          ledgerBoundaryMs: 0,
        };
        evidence.set(sessionId, filed);
        const frames: LedgerFrame[] = [];
        const attached = await scope.run(sessionId, async () => {
          await runtime.command({
            commandId: randomUUID(),
            command: {
              kind: "session.create",
              projectId,
              ticketId: null,
              role: "project",
              parentSessionId: null,
              title: `VC-456 ${concurrency}/${wave}/${index}`,
              requestedSessionId: sessionId,
            },
          });
          return runtime.command({
            commandId: randomUUID(),
            sessionId,
            command: { kind: "adapter.attach", continuity: "fresh" },
          });
        });
        const receipt = attached.receipt;
        if (receipt?.status !== "accepted" && receipt?.status !== "completed") {
          const why =
            receipt?.status === "rejected"
              ? `${receipt.code}: ${receipt.detail ?? "no detail"}`
              : (receipt?.status ?? "no receipt");
          throw new Error(`VC-456 bench: attach was not accepted (${why})`);
        }
        const attachment = (await engine.listEvents({ sessionId })).findLast(
          (event) => event.payload.kind === "attachment.opened",
        );
        if (attachment?.payload.kind !== "attachment.opened") {
          throw new Error("VC-456 bench: the attach recorded no opened attachment");
        }
        const attachmentId = attachment.payload.attachment.id;
        let unsubscribe = doNothing;
        if (subscribers === "all") {
          unsubscribe = await runtime.subscribe(
            { sessionId, afterSequence: attached.throughSequence },
            (emission) => {
              if (!isSessionStreamFrame(emission)) return;
              const arrivedAt = performance.now();
              const payload = emission.event.payload as unknown as Record<string, unknown>;
              const kind = String(payload["kind"]);
              frames.push({
                sequence: emission.sequence,
                kind,
                commandId: emission.event.commandId ?? null,
                arrivedAt,
              });
            },
          );
        }
        return { sessionId, attachmentId, filed, frames, unsubscribe };
      }),
    );
    // Only the measured turn's evidence counts; setup's is dropped.
    for (const session of sessions) {
      session.filed.engineCalls = {};
      session.filed.commits.length = 0;
      session.filed.timers.length = 0;
      session.filed.artifactCalls.length = 0;
      session.filed.ledgerTransactions.length = 0;
      session.filed.ledgerBoundaryMs = 0;
    }

    // Measured: every Session submits at once, as a wave of VC-441 did.
    const firstEnvelope = envelopes.length;
    type Measured = {
      session: (typeof sessions)[number];
      commandId: string;
      submittedAt: number;
      resolvedAt: number;
      receiptStatus: string | null;
    };
    let measured: Measured[] = [];
    let measuredWallMs = 0;
    let measuredCpuMs = 0;
    const measure = async (): Promise<void> => {
      const cpuBefore = process.cpuUsage();
      const startedAt = performance.now();
      measured = await Promise.all(
        sessions.map((session) =>
          scope.run(session.sessionId, async () => {
            const commandId = randomUUID();
            const submittedAt = performance.now();
            const result = await runtime.command({
              commandId,
              sessionId: session.sessionId,
              command: {
                kind: "message.submit",
                message: {
                  id: randomUUID(),
                  role: "user",
                  parts: [{ type: "text", text: PRIVATE_CONTENT_CANARY }],
                },
              },
            });
            return {
              session,
              commandId,
              submittedAt,
              resolvedAt: performance.now(),
              receiptStatus: result.receipt?.status ?? null,
            };
          }),
        ),
      );
      measuredWallMs = performance.now() - startedAt;
      const cpu = process.cpuUsage(cpuBefore);
      measuredCpuMs = (cpu.user + cpu.system) / 1_000;
    };
    await (input.around === undefined ? measure() : input.around(measure));
    const waveEnvelopes = envelopes.slice(firstEnvelope);

    // Teardown, untimed: copy the evidence out, release every attachment so
    // the next wave starts with none open, and read each ledger back.
    const turns: RawTurn[] = [];
    for (const entry of measured) {
      const { session } = entry;
      session.unsubscribe();
      const engineCalls = { ...session.filed.engineCalls };
      const commits = [...session.filed.commits];
      const timers = [...session.filed.timers];
      const artifactCalls = [...session.filed.artifactCalls];
      const ledgerTransactions = [...session.filed.ledgerTransactions];
      const ledgerBoundaryMs = session.filed.ledgerBoundaryMs;
      evidence.delete(session.sessionId);
      await scope.run(session.sessionId, () =>
        runtime.command({
          commandId: randomUUID(),
          sessionId: session.sessionId,
          command: { kind: "adapter.release", attachmentId: session.attachmentId },
        }),
      );
      const ledgerEvents = await engine.listEvents({ sessionId: session.sessionId });
      turns.push({
        sessionId: session.sessionId,
        concurrency,
        wave,
        commandId: entry.commandId,
        submittedAt: entry.submittedAt,
        resolvedAt: entry.resolvedAt,
        receiptStatus: entry.receiptStatus,
        envelopes: waveEnvelopes.filter((envelope) => envelope.sessionId === session.sessionId),
        frames: session.frames.filter((frame) => frame.arrivedAt >= entry.submittedAt),
        ledger: ledgerEvents.map((event) => ({
          sequence: event.sequence,
          kind: event.payload.kind,
          commandId: event.commandId ?? null,
        })),
        engineCalls,
        commits,
        timers,
        artifactCalls,
        ledgerTransactions,
        ledgerBoundaryMs,
      });
    }
    return { turns, measuredWallMs, measuredCpuMs };
  }

  return {
    artifactStore,
    subscribers,
    runWave,
    unscopedEnvelopeCount: () => unscoped,
    runIdConflictCount: () => runIdConflicts,
    requests: () => provider.requests,
    networkAttempts: () => networkAttempts,
    async close() {
      try {
        await runtime.close();
      } finally {
        db.close();
        globalThis.fetch = realFetch;
        rmSync(profile, { recursive: true, force: true });
      }
    },
  };
}
