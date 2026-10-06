/** The one host composition of the Session writer and its post-commit observers. */
import type Database from "better-sqlite3";
import type { HostNoticeOutbox, OpenNativeBinding, SessionEngine } from "@volli/session-engine";
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
 * What the Session runtime host-core assembles later tells the Session
 * services it built first: which executor bindings are open (a listing row is
 * live only while one is), and each folded projection, for scheduled resume.
 * Not ports: both answers come from host-core's own runtime assembly
 * (`session-runtime/assembly`) and lifecycle (`session-runtime/lifecycle`),
 * which wire them here as they are built (VC-632). Until then nothing is open
 * and nothing is scheduled.
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

/** Keyed by the composed engine, which is the identity every runtime constructor receives. */
const runtimeWiring = new WeakMap<SessionEngine, SessionRuntimeWiring>();

/** Internal: the runtime assembly and lifecycle report into the services that own `engine`. */
export function wireSessionRuntime(
  engine: SessionEngine,
  wiring: Partial<SessionRuntimeWiring>,
): void {
  const slot = runtimeWiring.get(engine);
  if (slot === undefined) return;
  if (wiring.openNativeBindings !== undefined) slot.openNativeBindings = wiring.openNativeBindings;
  if (wiring.observeScheduledResume !== undefined) {
    slot.observeScheduledResume = wiring.observeScheduledResume;
  }
  if (wiring.pendingTurnStarts !== undefined) slot.pendingTurnStarts = wiring.pendingTurnStarts;
  if (wiring.holdTurnStarts !== undefined) slot.holdTurnStarts = wiring.holdTurnStarts;
  if (wiring.releaseTurnStarts !== undefined) slot.releaseTurnStarts = wiring.releaseTurnStarts;
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
  // Wake committed facts before marking listing rows dirty, as in desktop.
  const sessionWakeBus = createSessionWakeBus(createHostSessionEngine(sessionLedger), {
    db,
  });
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
  const sessionActivityWatch = watchSessionActivity(sessionWakeBus.engine, {
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
    // Synchronous, as each write resolves: a quit decision must never lag a
    // committed `turn.started` behind the coalesced fold above (VC-577).
    observeEvent: (event) => liveWork.observeEvent(event),
    observeBirth: (sessionId) => {
      runAttention.observeBirth(sessionId);
      sessionReadWatch.observeBirth(sessionId);
    },
  });
  const sessionEngine = sessionActivityWatch.engine;
  runtimeWiring.set(sessionEngine, runtime);
  return {
    sessionLedger,
    hostNoticeOutbox,
    sessionWakeBus,
    sessionReadWatch,
    liveWork,
    sessionActivityWatch,
    sessionEngine,
  };
}
