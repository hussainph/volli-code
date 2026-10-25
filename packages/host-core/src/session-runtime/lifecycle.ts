/**
 * Session boot/drain ownership (VC-622). Construction is synchronous; the quit
 * hold is installed before recovery can yield. Consumers receive services only
 * from ready(), after stale attachments → delegations → durable shell notices.
 * The attachment assembly supplied to this owner already holds every executor
 * port, including the browser backend. Recovery uses the same host engine.
 */
import { randomUUID } from "node:crypto";
import type { HostNotice, HostedSessionRuntime, SessionEngine } from "@volli/session-engine";
import {
  logErrorSummary,
  type LogErrorSummary,
  type SessionProjection,
  type RunnerIdentity,
} from "@volli/shared";
import { isLiveHost, type HostCore, type HostCorePorts } from "../index";
import { shutdownNativeSessions } from "../host-shutdown";
import { SESSION_RUNTIME } from "../session-services";
import { listProjects } from "../db/projects-repo";
import {
  consumeFollowUpCleanClose,
  FOLLOW_UP_DOWNGRADE_HOLD_DETAIL,
} from "../db/session-follow-up-repo";
import { listScheduledResumeSessionIds } from "../db/scheduled-resume-repo";
import {
  createScheduledResumeHost,
  createSessionWatchdog,
  createSuspendClock,
} from "../session-control";
import type { AgentObservability } from "../observability/settings";
import { relayShellNotices } from "../shell/shell-notices";
import type { BackgroundShellNotice } from "../shell/background-shell-host";
import {
  closeStaleAttachments,
  type BootRecoveredTurns,
  type BootRecoveryFailure,
  type BootRecoveryReason,
} from "./boot-recovery";
import { resumeRecoveredTurns } from "./restart-resume";
import { createHostNoticeDelivery } from "./durable-host-notice-delivery";
import { readSqliteHostNotice, scopeSqliteHostNoticeOutbox } from "./sqlite-host-notice-outbox";
import { catchUpSessionResumptions } from "./session-resumptions";
import type { TicketSessionDelegationStore } from "./delegation-store";
import type { Delegations } from "./delegate-session";
import { hostLogger } from "../log/root";

const log = hostLogger("session-lifecycle");

/**
 * How long host readiness waits for the startup follow-up release sweep
 * (VC-675). Releasing before Clients connect keeps a restart's queued message
 * ahead of a fresh send, but the sweep attaches executors and waits for each
 * turn to open: a hung executor must not hold the whole host unready. Past
 * this bound the sweep keeps running in the background; close still waits
 * for it before the database closes.
 */
export const FOLLOW_UP_RECOVERY_READY_WAIT_MS = 5_000;

/** Expected host teardown, not a failed boot or a notice delivery error. */
export class SessionRuntimeClosingError extends Error {
  override name = "SessionRuntimeClosingError";
}

const recoveredServices = Symbol("recovered Session services");
const issuedProofs = new WeakSet<object>();
/** Runtime guard: a structural cast or copied symbol is not a recovery proof. */
export function readRecoveredSessionServices<Services>(
  ready: RecoveredSessionServices<Services>,
): Services {
  if (!issuedProofs.has(ready)) throw new Error("The Session services have no recovery proof.");
  return ready.services;
}
/** Derive a port view only from an issued proof; every later read retains its revocation. */
export function mapRecoveredSessionServices<Source, Services>(
  ready: RecoveredSessionServices<Source>,
  map: (services: Source) => Services,
): RecoveredSessionServices<Services> {
  readRecoveredSessionServices(ready);
  const proof: RecoveredSessionServices<Services> = {
    [recoveredServices]: true,
    get services() {
      return map(readRecoveredSessionServices(ready));
    },
  };
  issuedProofs.add(proof);
  return proof;
}

/**
 * What this launch's boot recovery did, for a support report (VC-926): when it
 * finished, how many lost turns it rebuilt onto a live attachment, how many
 * attachments it closed, and every structured attachment whose reconcile
 * failed, classified. Counts, reasons and error class names only — never a
 * Session id, a path or a message: a support report is pasted in public.
 */
export interface BootRecoveryReport {
  readonly finishedAt: number;
  /** The sweep itself threw, so the counts cover only what it did before. */
  readonly error: LogErrorSummary | null;
  readonly recovered: number;
  readonly closed: number;
  readonly failures: readonly {
    readonly reason: Exclude<BootRecoveryReason, "not_rebuildable">;
    readonly outcome: BootRecoveryFailure["outcome"];
    readonly error: LogErrorSummary;
  }[];
}

/** Only the lifecycle can issue this proof that boot recovery has finished. */
export interface RecoveredSessionServices<Services> {
  readonly [recoveredServices]: true;
  readonly services: Services;
}

/** A notice by its ids, composed only if the outbox has never held them. */
export interface HostNoticeIntent {
  sessionId: string;
  commandId: string;
  compose(): HostNotice;
}

export interface SessionRuntimeLifecycle<Services> {
  /** No raw services on this owner: ledger consumers must await recovery. */
  ready(): Promise<RecoveredSessionServices<Services>>;
  close(): Promise<void>;
  observeScheduledResume(projection: SessionProjection): void;
  /** Starts/joins recovery if needed; fresh external notices never bypass it. */
  relayShellNotice(notice: BackgroundShellNotice): void;
  /**
   * Commits one host notice to this launch's (owner-scoped) durable outbox and
   * resolves once that put has committed: the stored first payload, or `null`
   * when the id already has a terminal receipt. `compose` runs only for an id
   * the outbox has never held, so a replayed producer never rebuilds the text
   * or mints a second nonce. Delivery then runs behind boot recovery, exactly
   * as for a recovered notice: live → steer, idle → a turn, detached → parked,
   * stopped → dropped. Rejects when this launch has no delivery (no runtime),
   * is closing, or does not own the Session; nothing was stored.
   *
   * Production caller: the cloud product store's `session.notice` inbox
   * executor (`cloud-store/notice-jobs.ts`), bound by the runner composition.
   */
  enqueueHostNotice(input: HostNoticeIntent): Promise<HostNotice | null>;
  /** This launch's stale-attachment sweep, once it has finished; `null` before then. */
  bootRecovery(): BootRecoveryReport | null;
}

export function createSessionRuntimeLifecycle<Services>(options: {
  host: HostCore;
  /** Launch-selected engine, used by every ledger consumer during recovery. */
  sessionEngine?: SessionEngine;
  /** Filters machine-state queues before they can reach runtime recovery. */
  ownsSession?(sessionId: string): boolean;
  projectIds?(): readonly string[];
  venue?: RunnerIdentity;
  /** Upgrade-only ownership supplied by the host, not the executor. */
  ownsLegacyRunner?(runner: RunnerIdentity): boolean;
  ports: Pick<HostCorePorts, "power" | "attention" | "events" | "log">;
  runtime: HostedSessionRuntime | null;
  /** A transport constructed from ready services may bind after recovery. */
  rpc(): { close(): Promise<void> } | null;
  observability: AgentObservability | null;
  delegation: TicketSessionDelegationStore | null;
  delegationsFor(): Pick<Delegations, "recover"> | null;
  /** Captured, never called until recovery finishes. */
  services(): Services;
  /** Synchronous host lifecycle hook; desktop installs its accepted-quit hold. */
  installQuitHold(close: () => Promise<void>): void;
  stopProducers(): void;
  /** Tests only: {@link FOLLOW_UP_RECOVERY_READY_WAIT_MS}. */
  followUpRecoveryWaitMs?: number;
  /**
   * Whether this launch shows Volli Cloud's board rather than this host's
   * (VC-889): a turn the last process cut short then waits for a launch that
   * shows it, and is not resumed on its own. Absent is a local launch.
   */
  cloudLaunch?(): boolean;
}): SessionRuntimeLifecycle<Services> {
  const { host, ports, runtime, rpc, observability, delegation } = options;
  const { database } = host;
  const liveHost = isLiveHost(host) ? host : undefined;
  const sessionEngine =
    liveHost === undefined ? null : (options.sessionEngine ?? liveHost.sessionEngine);
  const ownsSession = options.ownsSession ?? (() => true);
  const rawNoticeOutbox = liveHost?.[SESSION_RUNTIME].hostNoticeOutbox ?? null;
  const hostNoticeOutbox =
    rawNoticeOutbox === null || options.ownsSession === undefined || !database.ok
      ? rawNoticeOutbox
      : scopeSqliteHostNoticeOutbox(database.db, rawNoticeOutbox, ownsSession);
  const sessionWakeBus = liveHost?.sessionWakeBus ?? null;
  const notices =
    runtime === null || hostNoticeOutbox === null
      ? null
      : createHostNoticeDelivery({
          runtime,
          outbox: hostNoticeOutbox,
          ...(sessionWakeBus === null
            ? {}
            : {
                subscribeEvents: (listener) =>
                  sessionWakeBus.subscribe(({ event }) => listener(event)),
              }),
          report: (message) => ports.log.error("host notice delivery failed", { detail: message }),
        });
  const relay =
    runtime === null || notices === null
      ? null
      : relayShellNotices({
          runtime,
          delivery: notices,
          report: (message) => ports.log.error("shell notice relay failed", { detail: message }),
        });
  const suspendClock =
    runtime !== null && sessionEngine !== null ? createSuspendClock(ports.power) : null;
  const watchdog =
    runtime !== null && sessionEngine !== null && suspendClock !== null
      ? createSessionWatchdog({
          ...(options.venue === undefined ? {} : { venue: options.venue }),
          listBindings: () => runtime.openNativeBindings(),
          suspendedMsWithin: suspendClock.suspendedMsWithin,
          projection: async (sessionId) => (await runtime.projection({ sessionId })).projection,
          submit: (request) => sessionEngine.submit(request),
          notify: (request) => ports.attention.deliver(request),
        })
      : null;
  watchdog?.start();
  const resume =
    runtime !== null && sessionEngine !== null && database.ok
      ? createScheduledResumeHost({
          candidates: async () => listScheduledResumeSessionIds(database.db).filter(ownsSession),
          projection: async (sessionId) => (await runtime.projection({ sessionId })).projection,
          ticketSessions: ({ projectId, ticketId }) =>
            sessionEngine.listSessions({ projectId, scope: "ticket", ticketId }),
          command: (request) => runtime.command(request),
          notify: (request) => ports.attention.deliver(request),
        })
      : null;
  const wake = () => {
    if (!closing) void resume?.pass();
  };
  let bootRecovery: BootRecoveryReport | null = null;
  let boot: Promise<RecoveredSessionServices<Services>> | undefined;
  let drain: Promise<void> | undefined;
  let closing = false;
  // The startup release sweep, which may outlive readiness (never rejects).
  let followUpRecovery: Promise<void> | undefined;
  // Turns a restart resume continued, which outlive readiness (never rejects).
  let restartResumeRuns: Promise<void> | undefined;
  const closed = Promise.withResolvers<false>();

  function close(): Promise<void> {
    if (drain !== undefined) return drain;
    closing = true;
    closed.resolve(false);
    options.stopProducers();
    suspendClock?.close();
    ports.power.removeListener("resume", wake);
    // Preserve VC-618's stop → RPC/runtime → MCP backstop → export flush.
    // Its caller still owns the unchanged aggregate shutdown deadline.
    const shutdown = shutdownNativeSessions({
      log: ports.log,
      sessionWatchdog: watchdog,
      scheduledResumeHost: resume,
      shellHostNotices: notices,
      sessionRpc: rpc(),
      sessionRuntime: runtime,
      agentObservability: observability,
    });
    // A host may close the database only after both drain and an in-flight boot
    // sweep finish. Closing the runtime also unblocks its reconciliation path.
    // A startup release that outlived readiness still writes the queue ledger.
    drain = Promise.all([
      shutdown,
      boot?.catch(() => undefined),
      followUpRecovery,
      restartResumeRuns,
    ]).then(() => undefined);
    return drain;
  }
  options.installQuitHold(close);

  async function recover(): Promise<RecoveredSessionServices<Services>> {
    let held: string[] = [];
    // The restart resume the sweep armed, run once the queue has had its turn.
    // Written by the sweep's callback, so held in a box TypeScript cannot narrow.
    const recovery: { resume?: () => Promise<void> } = {};
    if (database.ok && sessionEngine !== null) {
      // Compare before recovery itself can append events. A present watermark
      // is consumed in the same transaction that refuses any stale queued rows.
      held = consumeFollowUpCleanClose(
        database.db,
        (sessionId, error) => ports.log.error("unreadable follow-up queue", { sessionId, error }),
        options.ownsSession,
      );
      const failures: BootRecoveryReport["failures"][number][] = [];
      let recoveredTurns = 0;
      try {
        const closedAttachments = await closeStaleAttachments({
          engine: sessionEngine,
          ...(options.venue === undefined ? {} : { venue: options.venue }),
          ...(options.ownsLegacyRunner === undefined
            ? {}
            : { ownsLegacyRunner: options.ownsLegacyRunner }),
          shouldStop: () => closing,
          reconcile: (input) =>
            runtime === null
              ? Promise.reject(
                  new Error("The Session runtime is unavailable during boot recovery."),
                )
              : runtime.reconcile(input),
          projectIds:
            options.projectIds?.() ?? listProjects(database.db).map((project) => project.id),
          newId: randomUUID,
          now: Date.now,
          // A binding the runtime holds after a failed reconcile was rebuilt.
          holdsBinding: (attachmentId) =>
            runtime
              ?.openNativeBindings()
              .some((binding) => binding.attachmentId === attachmentId) ?? false,
          onError: (attachmentId, error) =>
            ports.log.error("failed to recover attachment", { attachmentId, error }),
          onFailure: ({ sessionId, attachmentId, reason, outcome, error }) => {
            failures.push({ reason, outcome, error: logErrorSummary(error) });
            const fields = { sessionId, attachmentId, reason, outcome, error };
            // A recovered turn kept its attachment: worth a look, not an outage.
            if (outcome === "recovered") {
              ports.log.warn("recovered an attachment whose reconcile failed", fields);
            } else {
              ports.log.error("failed to recover attachment", fields);
            }
          },
          onRecovered: (recovered) => {
            recoveredTurns = recovered.turns.length;
            if (runtime === null) return;
            recovery.resume = () => resumeRestartTurns(runtime, sessionEngine, recovered);
          },
        });
        if (!closing) {
          bootRecovery = {
            finishedAt: Date.now(),
            error: null,
            recovered: recoveredTurns,
            closed: closedAttachments,
            failures,
          };
        }
      } catch (error) {
        ports.log.error("failed to recover stale attachments", { error });
        // The launch most likely to be reported: say the sweep failed, not "not finished".
        if (!closing) {
          bootRecovery = {
            finishedAt: Date.now(),
            error: logErrorSummary(error),
            recovered: recoveredTurns,
            closed: 0,
            failures,
          };
        }
      }
      if (delegation !== null && !closing) {
        try {
          // Construct even with nothing unanswered: this arms resumed-child notices.
          const delegateHost = options.delegationsFor();
          const unanswered = delegation
            .listUnansweredSubagents()
            .filter(
              (child) => ownsSession(child.childSessionId) && ownsSession(child.parentSessionId),
            );
          if (unanswered.length > 0) {
            const recovered = await delegateHost?.recover(unanswered);
            if (recovered !== undefined) {
              log.info("delegations recovered", {
                unanswered: unanswered.length,
                answered: recovered.answered,
                reported: recovered.reported,
                skipped: recovered.skipped,
              });
            }
          }
        } catch (error) {
          ports.log.error("failed to recover delegations", { error });
        }
      }
    }
    if (closing)
      throw new SessionRuntimeClosingError("The Session runtime closed during recovery.");
    // Explain durable holds after stale bindings are retired, so the Attention
    // belongs to today's executor. Failure cannot unhold a row; retry next boot.
    for (const sessionId of held.filter(ownsSession)) {
      try {
        await runtime?.reportMessageDeliveryFailure({
          sessionId,
          commandId: `follow-up:${sessionId}`,
          detail: FOLLOW_UP_DOWNGRADE_HOLD_DETAIL,
        });
      } catch (error) {
        ports.log.error("failed to explain held follow-ups", { sessionId, error });
      }
    }
    if (runtime !== null) await recoverFollowUps(runtime);
    if (closing)
      throw new SessionRuntimeClosingError("The Session runtime closed during recovery.");
    // After the queue: a message the person queued behind the lost turn is
    // their own word on what comes next, and a turn it opened is one the
    // restart resume then leaves alone (VC-450). Its turns outlive readiness;
    // close waits for them.
    restartResumeRuns = recovery.resume?.();
    try {
      await notices?.recover();
    } catch (error) {
      ports.log.error("failed to recover host notices", { error });
    }
    if (closing)
      throw new SessionRuntimeClosingError("The Session runtime closed during recovery.");
    if (database.ok && sessionEngine !== null) {
      setImmediate(() => {
        if (closing) return;
        const work = catchUpSessionResumptions(database.db, sessionEngine, {
          publish: (change) => ports.events.publish("data-changed", change),
          report: (error) => ports.log.error("failed to catch up session resumptions", { error }),
        });
        liveHost?.detachedWork.track(work);
      });
    }
    if (resume !== null) {
      // A due retry can take minutes; only recovery, not that turn, gates ready.
      void resume.start();
      ports.power.on("resume", wake);
    }
    const services = options.services();
    const proof: RecoveredSessionServices<Services> = {
      [recoveredServices]: true,
      get services() {
        // Close can win after ready resolves but before a host's continuation
        // constructs its transport. Never bind that late consumer to a drain.
        if (closing) throw new SessionRuntimeClosingError("The Session runtime is closing.");
        return services;
      },
    };
    issuedProofs.add(proof);
    return proof;
  }
  /** The restart resume over this host's runtime and engine (VC-450). */
  function resumeRestartTurns(
    hosted: HostedSessionRuntime,
    engine: NonNullable<typeof sessionEngine>,
    recovered: BootRecoveredTurns,
  ): Promise<void> {
    return resumeRecoveredTurns(
      {
        projection: async (sessionId) => (await hosted.projection({ sessionId })).projection,
        ticketSessions: ({ projectId, ticketId }) =>
          engine.listSessions({ projectId, scope: "ticket", ticketId }),
        resumeBoundary: (input) => hosted.resumeBoundary(input),
        pendingTurnStarts: () => hosted.pendingTurnStarts(),
        command: (request) => hosted.command(request),
        shouldStop: () => closing,
        ...(options.cloudLaunch === undefined ? {} : { cloudLaunch: options.cloudLaunch }),
      },
      recovered,
    );
  }
  /**
   * Release/reconcile durable follow-ups, preferably before any Client or
   * producer can write. Recovery schedules turns and waits only for them to
   * open, and only up to the bound: a hung executor attach leaves the sweep
   * running in the background instead of holding readiness. Failure is
   * reported, not fatal: every queued payload stays durable for the next pass.
   */
  async function recoverFollowUps(hosted: HostedSessionRuntime): Promise<void> {
    const waitMs = options.followUpRecoveryWaitMs ?? FOLLOW_UP_RECOVERY_READY_WAIT_MS;
    const sweep = hosted.recoverFollowUps().catch((error: unknown) => {
      ports.log.error("failed to recover queued follow-ups", { error });
    });
    followUpRecovery = sweep;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), waitMs);
    });
    try {
      const finished = await Promise.race([sweep.then(() => true), bound, closed.promise]);
      if (!finished && !closing) {
        ports.log.warn(
          "queued follow-up recovery is still running; the host is ready and release continues in the background",
          { waitMs },
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
  function ready(): Promise<RecoveredSessionServices<Services>> {
    if (closing)
      return Promise.reject(new SessionRuntimeClosingError("The Session runtime is closing."));
    boot ??= recover();
    return boot;
  }
  const observeScheduledResume = (projection: SessionProjection): void => {
    if (
      !closing &&
      resume !== null &&
      (options.ownsSession === undefined || ownsSession(projection.session.id))
    )
      resume.observe(projection);
  };
  return {
    ready,
    close,
    observeScheduledResume,
    bootRecovery: () => bootRecovery,
    relayShellNotice: (notice) => {
      if (closing || relay === null || !ownsSession(notice.sessionId)) return;
      // A fresh external notice cannot read the ledger while boot recovery is
      // still reconciling it. Recovery's durable outbox remains an internal port.
      void ready().then(
        () => {
          if (!closing) void relay(notice);
        },
        (error: unknown) => {
          if (error instanceof SessionRuntimeClosingError) return;
          ports.log.error("failed to ready a shell notice", { error });
        },
      );
    },
    enqueueHostNotice: async ({ sessionId, commandId, compose }) => {
      if (closing) throw new SessionRuntimeClosingError("The Session runtime is closing.");
      if (hostNoticeOutbox === null || notices === null || !database.ok)
        throw new Error("This launch has no host notice delivery.");
      if (!ownsSession(sessionId))
        throw new Error("The host notice is outside this launch's Session scope");
      const known = readSqliteHostNotice(database.db, commandId, sessionId);
      if (known.state === "settled") return null;
      let stored: HostNotice | null;
      if (known.state === "pending") stored = known.notice;
      else {
        const notice = compose();
        if (notice.sessionId !== sessionId || notice.commandId !== commandId)
          throw new Error(`Host notice ${commandId} was composed for another id`);
        // Committed before anything else: the caller may report success from here.
        stored = await hostNoticeOutbox.put(notice);
      }
      if (stored === null) return null;
      const committed = stored;
      // Delivery reads the ledger, so it waits for boot recovery like every
      // fresh producer. `deliver` re-puts the same id and gets the same first
      // payload back, so the stored text and nonce are what is sent.
      void ready()
        .then(() => notices.deliver(committed))
        .catch((error: unknown) => {
          // A close that won: the payload stays durable for the next launch.
          if (closing) return;
          ports.log.error("host notice delivery failed", { detail: committed.label, error });
        });
      return committed;
    },
  };
}
