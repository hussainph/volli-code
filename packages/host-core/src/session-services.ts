/** The one host composition of the Session writer and its post-commit observers. */
import type Database from "better-sqlite3";
import type {
  HostNoticeOutbox,
  OpenNativeBinding,
  SessionEngine,
  SubmitSessionCommandRequest,
} from "@volli/session-engine";
import type { SessionLedger, SessionProjection } from "@volli/shared";
import type { Logger } from "./log/logger";
import { readAutomationRunAttendance } from "./db/automations-repo";
import { readSessionProvenance } from "./db/session-provenance-repo";
import { markSessionUnread, readSessionUnread, writeSessionUnread } from "./db/session-read-repo";
import { createRunAttentionWatch } from "./automations/run-attention";
import {
  createSqliteSessionLedger,
  createHostLiveWork,
  createSessionReadWatch,
  publishSessionListingRow,
  watchSessionActivity,
  type SessionActivityWatch,
  type HostLiveWorkWatch,
  type SessionActivityWatchPorts,
  type SessionReadWatch,
} from "./session-control";
import {
  assertProjectWritable,
  assertSessionWritable,
  cloudClaimsSessionWrite,
} from "./cloud-move/freeze";
import { createHostSessionEngine } from "./sessions/engine";
import type { AttentionDeliveryPort } from "./ports/attention";
import type { HostEventBus } from "./ports/events";
import { createSqliteHostNoticeOutbox } from "./session-runtime/sqlite-host-notice-outbox";
import { observeSessionResumptions } from "./session-runtime/session-resumptions";
import { createSessionWakeBus, type SessionWakeBus } from "./session-control/session-wake";

/** Only the process-owned edges of Session composition; no window mechanisms. */
export interface HostSessionPorts {
  /** Session listing rows (`session-activity`) and resumption notices (`data-changed`). */
  events: HostEventBus;
  /** Unattended Run alerts, and which Sessions a focused client is showing. */
  attention: AttentionDeliveryPort;
  log: Pick<Logger, "error" | "warn">;
}

/**
 * What the Session runtime tells the Session services built before it:
 * which executor bindings are open (a listing row is live only while one
 * is), each folded projection for scheduled resume, and the runtime's turn
 * start latch. Not ports: host-core's runner composition
 * (`session-runtime/runner`) binds them, once, through
 * {@link SESSION_RUNTIME} as it builds the runtime and its lifecycle
 * (VC-632, VC-671). Until then nothing is open and nothing is scheduled.
 */
export interface SessionRuntimeWiring {
  openNativeBindings(): readonly Pick<OpenNativeBinding, "attachmentId" | "sessionId">[];
  observeScheduledResume(projection: SessionProjection): void;
  /** Accepted, not yet opened turn starts (VC-577): `HostedSessionRuntime.pendingTurnStarts`. */
  pendingTurnStarts(): ReadonlySet<string>;
  /** The runtime's idle-exit start latch (VC-577). */
  holdTurnStarts(): void;
  releaseTurnStarts(): void;
}

const NO_PENDING_STARTS: ReadonlySet<string> = new Set();

/**
 * The key of the services' one runtime slot. Package-private: no entry
 * exports it, so only host-core's runner composition (and host-core's own
 * tests) can bind a runtime to the host's Session services.
 */
export const SESSION_RUNTIME: unique symbol = Symbol("host-core Session runtime wiring");

/** The slot a host's Session services hold for the one runtime composed over them. */
export interface SessionRuntimeSlot {
  /**
   * Once per host, before anything is composed: a second runtime over one
   * engine is a composition error, even after a first composition threw
   * (its claim is not returned). Answers the binder the runtime's answers go
   * through once they exist.
   */
  claim(): (wiring: Partial<SessionRuntimeWiring>) => void;
  /** The durable shell-notice outbox, which only the runtime's lifecycle delivers. */
  readonly hostNoticeOutbox: HostNoticeOutbox;
}

export interface HostSessionServices {
  readonly sessionLedger: SessionLedger;
  readonly hostNoticeOutbox: HostNoticeOutbox;
  readonly sessionWakeBus: SessionWakeBus;
  readonly sessionReadWatch: SessionReadWatch;
  /** Running turns and shells, read synchronously by a quit decision (VC-577). */
  readonly liveWork: HostLiveWorkWatch;
  readonly sessionActivityWatch: SessionActivityWatch;
  readonly sessionEngine: SessionEngine;
  readonly [SESSION_RUNTIME]: SessionRuntimeSlot;
}

/** Commands that only ever stop work: a frozen project still takes them. */
const STOPPING_INTENTS: ReadonlySet<SubmitSessionCommandRequest["intent"]["kind"]> = new Set([
  "session.stop",
  "executor.stop",
  "executor.interrupt",
] as const);

/**
 * The engine with the move freeze in front of its two person-intent writes
 * (VC-993): a project moving to Volli Cloud starts no local Session and its
 * local Sessions take no command, except one that stops work. A Session Volli
 * Cloud claims (`cloudClaimsSessionWrite`: the moved ones after the handover,
 * a cloud launch's new ones) is the cloud project's and is never held.
 * Runtime observations still land, and a cloud launch's drain carries any
 * past the moved head.
 */
function freezeGatedEngine(db: Database.Database, engine: SessionEngine): SessionEngine {
  return {
    ...engine,
    createSession: async (request) => {
      // A cloud launch's birth (it names its owner) is the cloud project's.
      const birth = { kind: "birth", ownerUserId: request.ownerUserId } as const;
      if (!cloudClaimsSessionWrite(db, birth)) assertProjectWritable(db, request.projectId);
      return engine.createSession(request);
    },
    submit: async (request) => {
      if (!STOPPING_INTENTS.has(request.intent.kind)) assertSessionWritable(db, request.sessionId);
      return engine.submit(request);
    },
  };
}

export function createHostSessionServices(
  db: Database.Database,
  ports: HostSessionPorts,
): HostSessionServices {
  // The outbox and engine share exactly one Session transaction writer.
  const sessionLedger = createSqliteSessionLedger(db);
  const runtime: SessionRuntimeWiring = {
    openNativeBindings: () => [],
    observeScheduledResume: () => undefined,
    pendingTurnStarts: () => NO_PENDING_STARTS,
    holdTurnStarts: () => undefined,
    releaseTurnStarts: () => undefined,
  };
  const hostNoticeOutbox = createSqliteHostNoticeOutbox(db, sessionLedger);
  const runAttention = createRunAttentionWatch({
    attendanceOf: (sessionId) => readAutomationRunAttendance(db, sessionId),
    notify: (request) => {
      ports.attention.deliver(request);
    },
  });
  // The process's one Engine decorator: every committed Session Event is
  // announced here, after its transaction, to every observer below.
  const sessionWakeBus = createSessionWakeBus(
    freezeGatedEngine(db, createHostSessionEngine(sessionLedger)),
    { db },
  );
  const publishSessionActivity: SessionActivityWatchPorts["publish"] = (notice) =>
    ports.events.publish("session-activity", notice);
  const publishSessionRow = (sessionId: string): void => {
    void publishSessionListingRow(
      {
        db,
        getSession: (query) => sessionEngine.getSession(query),
        liveAttachmentIds: () =>
          new Set(runtime.openNativeBindings().map((binding) => binding.attachmentId)),
        publish: publishSessionActivity,
      },
      sessionId,
    ).catch((error: unknown) => {
      ports.log.warn("could not publish the session's read row", { sessionId, error });
    });
  };
  const sessionReadWatch = createSessionReadWatch({
    focusedSessionIds: () => ports.attention.focusedSessionIds(),
    markUnread: (sessionId, at) => {
      // No publish: the activity fold reads this receipt after observe runs.
      markSessionUnread(db, sessionId, at);
    },
    markRead: (sessionId) => {
      if (readSessionUnread(db, sessionId).unreadSince === null) return;
      writeSessionUnread(db, sessionId, null);
      publishSessionRow(sessionId);
    },
  });
  const liveWork = createHostLiveWork({
    openSessionIds: () => new Set(runtime.openNativeBindings().map((binding) => binding.sessionId)),
    pendingStartSessionIds: () => runtime.pendingTurnStarts(),
    starts: { hold: () => runtime.holdTurnStarts(), release: () => runtime.releaseTurnStarts() },
    onError: (error) => ports.log.warn("live work listener failed", { error }),
  });
  // The one decorator over the Engine is the wake bus; the activity watch and
  // the Session runtime's open chat streams both listen to it (VC-790).
  const sessionActivityWatch = watchSessionActivity(sessionWakeBus, {
    publish: publishSessionActivity,
    provenanceOf: (born) => readSessionProvenance(db, born),
    readOf: (sessionId) => readSessionUnread(db, sessionId),
    listOpenNativeBindings: () => runtime.openNativeBindings(),
    observe: (projection) => {
      observeSessionResumptions(db, projection, {
        publish: (change) => ports.events.publish("data-changed", change),
        report: (error) => ports.log.error("failed to record session resumption", { error }),
      });
      runAttention.observe(projection);
      runtime.observeScheduledResume(projection);
      sessionReadWatch.observe(projection);
      liveWork.observeSession(projection);
    },
    // Synchronous, as each write commits: a quit decision must never lag a
    // committed `turn.started` behind the coalesced fold above (VC-577).
    observeEvent: (event) => liveWork.observeEvent(event),
    observeBirth: (sessionId) => {
      runAttention.observeBirth(sessionId);
      sessionReadWatch.observeBirth(sessionId);
    },
  });
  const sessionEngine = sessionWakeBus.engine;
  let claimed = false;
  const slot: SessionRuntimeSlot = {
    claim() {
      if (claimed) throw new Error("A Session runtime already claimed these Session services.");
      claimed = true;
      return (wiring) => {
        // Only the answers given replace the inert defaults.
        for (const [key, answer] of Object.entries(wiring)) {
          if (answer !== undefined) Object.assign(runtime, { [key]: answer });
        }
      };
    },
    hostNoticeOutbox,
  };
  return {
    [SESSION_RUNTIME]: slot,
    sessionLedger,
    hostNoticeOutbox,
    sessionWakeBus,
    sessionReadWatch,
    liveWork,
    sessionActivityWatch,
    sessionEngine,
  };
}
