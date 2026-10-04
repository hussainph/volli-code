/** The one host composition of the Session writer and its post-commit observers. */
import type Database from "better-sqlite3";
import type { HostNoticeOutbox, OpenNativeBinding, SessionEngine } from "@volli/session-engine";
import { errorMessage, type SessionLedger, type SessionProjection } from "@volli/shared";
import { readAutomationRunAttendance } from "./db/automations-repo";
import { readSessionProvenance } from "./db/session-provenance-repo";
import { markSessionUnread, readSessionUnread, writeSessionUnread } from "./db/session-read-repo";
import { createRunAttentionWatch } from "./automations/run-attention";
import {
  createDesktopSessionEngine,
  createSqliteSessionLedger,
  createSessionReadWatch,
  publishSessionListingRow,
  watchSessionActivity,
  type SessionActivityWatch,
  type SessionActivityWatchPorts,
  type SessionReadWatch,
} from "./session-control";
import type { AttentionDeliveryPort } from "./ports/attention";
import type { HostEventBus } from "./ports/events";
import { createSqliteHostNoticeOutbox } from "./session-runtime/sqlite-host-notice-outbox";
import { observeSessionResumptions } from "./session-runtime/session-resumptions";
import { createSessionWakeBus, type SessionWakeBus } from "./session-wake";

/** Only the process-owned edges of Session composition; no window mechanisms. */
export interface HostSessionPorts {
  /** Session listing rows (`session-activity`) and resumption notices (`data-changed`). */
  events: HostEventBus;
  /** Unattended Run alerts, and which Sessions a focused client is showing. */
  attention: AttentionDeliveryPort;
  listOpenNativeBindings(): readonly Pick<OpenNativeBinding, "attachmentId">[];
  /** Installed by desktop once its runtime-dependent scheduled-resume host exists. */
  observeScheduledResume(projection: SessionProjection): void;
  log: Pick<Console, "error" | "warn">;
}

export interface HostSessionServices {
  readonly sessionLedger: SessionLedger | null;
  readonly hostNoticeOutbox: HostNoticeOutbox | null;
  readonly sessionWakeBus: SessionWakeBus | null;
  readonly sessionReadWatch: SessionReadWatch | null;
  readonly sessionActivityWatch: SessionActivityWatch | null;
  readonly sessionEngine: SessionEngine | null;
}

export function createHostSessionServices(
  db: Database.Database | null,
  ports: HostSessionPorts,
): HostSessionServices {
  if (db === null) {
    return {
      sessionLedger: null,
      hostNoticeOutbox: null,
      sessionWakeBus: null,
      sessionReadWatch: null,
      sessionActivityWatch: null,
      sessionEngine: null,
    };
  }
  // The outbox and engine share exactly one Session transaction writer.
  const sessionLedger = createSqliteSessionLedger(db);
  const hostNoticeOutbox = createSqliteHostNoticeOutbox(db, sessionLedger);
  const runAttention = createRunAttentionWatch({
    attendanceOf: (sessionId) => readAutomationRunAttendance(db, sessionId),
    notify: (request) => {
      ports.attention.deliver(request);
    },
  });
  // Wake committed facts before marking listing rows dirty, as in desktop.
  const sessionWakeBus = createSessionWakeBus(
    createDesktopSessionEngine(db, { ledger: sessionLedger }),
    {
      db,
    },
  );
  const publishSessionActivity: SessionActivityWatchPorts["publish"] = (notice) =>
    ports.events.publish("session-activity", notice);
  const publishSessionRow = (sessionId: string): void => {
    void publishSessionListingRow(
      {
        db,
        getSession: (query) => sessionEngine.getSession(query),
        liveAttachmentIds: () =>
          new Set(ports.listOpenNativeBindings().map((binding) => binding.attachmentId)),
        publish: publishSessionActivity,
      },
      sessionId,
    ).catch((error: unknown) => {
      ports.log.warn(`[volli] could not publish the read row of ${sessionId}:`, error);
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
  const sessionActivityWatch = watchSessionActivity(sessionWakeBus.engine, {
    publish: publishSessionActivity,
    provenanceOf: (born) => readSessionProvenance(db, born),
    readOf: (sessionId) => readSessionUnread(db, sessionId),
    listOpenNativeBindings: () => ports.listOpenNativeBindings(),
    observe: (projection) => {
      observeSessionResumptions(db, projection, {
        publish: (change) => ports.events.publish("data-changed", change),
        report: (error) =>
          ports.log.error("[volli] failed to record Session resumption:", errorMessage(error)),
      });
      runAttention.observe(projection);
      ports.observeScheduledResume(projection);
      sessionReadWatch.observe(projection);
    },
    observeBirth: (sessionId) => {
      runAttention.observeBirth(sessionId);
      sessionReadWatch.observeBirth(sessionId);
    },
  });
  const sessionEngine = sessionActivityWatch.engine;
  return {
    sessionLedger,
    hostNoticeOutbox,
    sessionWakeBus,
    sessionReadWatch,
    sessionActivityWatch,
    sessionEngine,
  };
}
