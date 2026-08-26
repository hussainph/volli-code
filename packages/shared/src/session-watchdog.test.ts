import { describe, expect, it } from "vite-plus/test";
import { EMPTY_SESSION_USAGE_SUMMARY } from "./session-usage";
import type { SessionAttention, SessionInteraction, SessionProjection } from "./session-ledger";

import { DEFAULT_SESSION_WATCHDOG_SILENCE_MS, sessionWedge } from "./session-watchdog";

function projection(overrides: Partial<SessionProjection> = {}): SessionProjection {
  return {
    session: {
      id: "session-1",
      projectId: "project-1",
      ticketId: null,
      title: "Implementer",
      createdAt: 0,
    },
    status: "open",
    commands: [],
    receipts: [],
    pendingExecutorStart: null,
    attachments: [],
    liveExecutor: null,
    attention: { active: [], primary: null },
    interactions: { active: [], resolved: [] },
    signal: null,
    stopped: null,
    modelSelection: null,
    turnActive: true,
    authorityDenials: 0,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    lastActivityAt: 0,
    bornTicketless: true,
    ...overrides,
  };
}

const T = DEFAULT_SESSION_WATCHDOG_SILENCE_MS;

describe("sessionWedge", () => {
  it("calls a live turn silent past the threshold wedged, and says for how long", () => {
    expect(sessionWedge(projection(), T + 5_000, T)).toEqual({
      wedged: true,
      silentForMs: T + 5_000,
    });
  });

  it("keeps watching a live turn still inside the threshold", () => {
    expect(sessionWedge(projection(), T - 1, T)).toEqual({ wedged: false, reason: "active" });
    // The boundary itself trips: N minutes of silence IS the claim.
    expect(sessionWedge(projection(), T, T)).toEqual({ wedged: true, silentForMs: T });
  });

  it("never calls a Session with no open turn wedged, however silent", () => {
    expect(sessionWedge(projection({ turnActive: false }), T * 10, T)).toEqual({
      wedged: false,
      reason: "no-turn",
    });
  });

  it("never calls a stopped Session wedged — its work was ended, not lost", () => {
    expect(
      sessionWedge(
        projection({ stopped: { at: 1, reason: null, by: { kind: "user" } } }),
        T * 10,
        T,
      ),
    ).toEqual({ wedged: false, reason: "stopped" });
  });

  // Attention doctrine: silence alone never becomes a lifecycle fact ABOUT THE
  // AGENT when a human is the blocker. A permission prompt can sit for an hour
  // legitimately, and it already self-reports through Attention.
  it("never calls a Session waiting on a person wedged", () => {
    const interaction: SessionInteraction = {
      id: "interaction-1",
      attachmentId: "attachment-1",
      kind: "permission",
      title: "Allow?",
      detail: null,
      options: [],
      multiple: false,
      native: { id: null, detail: null },
    };
    expect(
      sessionWedge(
        projection({ interactions: { active: [interaction], resolved: [] } }),
        T * 10,
        T,
      ),
    ).toEqual({ wedged: false, reason: "awaiting-user" });

    const attention = {
      id: "attention-1",
      kind: "permission_required",
      attachmentId: null,
      detail: null,
      diagnostic: null,
    } as SessionAttention;
    expect(
      sessionWedge(
        projection({ attention: { active: [attention], primary: attention } }),
        T * 10,
        T,
      ),
    ).toEqual({ wedged: false, reason: "awaiting-user" });
  });

  it("measures silence from the newest durable fact, clamped at zero", () => {
    expect(sessionWedge(projection({ lastActivityAt: 500 }), T + 500, T)).toEqual({
      wedged: true,
      silentForMs: T,
    });
    // A clock that reads earlier than the fact is an active session, not a
    // negative silence.
    expect(sessionWedge(projection({ lastActivityAt: 900 }), 800, T)).toEqual({
      wedged: false,
      reason: "active",
    });
  });

  it("defaults to ten minutes — one app-wide threshold, the compaction precedent", () => {
    expect(DEFAULT_SESSION_WATCHDOG_SILENCE_MS).toBe(10 * 60_000);
  });
});
