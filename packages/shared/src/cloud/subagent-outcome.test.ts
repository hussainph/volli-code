import { describe, expect, test } from "vite-plus/test";
import type { SessionEvent, SessionEventPayload } from "../session-ledger";
import type { SessionOrigin } from "../session-origin";
import type { SessionStopDetail } from "../session-stop";
import {
  isSubagentHostNoticeOrigin,
  subagentCommandOrigin,
  subagentNoticeIds,
  subagentOutcome,
  suppressSubagentAnswer,
} from "./subagent-outcome";

const OP = "parent:call";
const turn = { attachmentId: "attachment", turnId: "turn" };
const stopDetail: SessionStopDetail = {
  category: "network",
  message: "Network lost",
  providerType: null,
  httpStatus: null,
  retry: "not-retried",
  resetsAt: null,
};
const receipt = (commandId: string, rejected = true): SessionEventPayload => ({
  kind: "command.receipt.recorded",
  receipt: rejected
    ? {
        id: "receipt",
        commandId,
        sequence: 1,
        status: "rejected",
        code: "invalid_state",
        detail: "not attached",
        recordedAt: 1,
      }
    : {
        id: "receipt",
        commandId,
        sequence: 1,
        status: "accepted",
        acceptedAt: 1,
        result: { kind: "message.submitted", sessionId: "child" },
        recordedAt: 1,
      },
});

const originEvent = (detail: unknown, commandOrigin?: SessionOrigin | null) =>
  ({
    commandOrigin,
    provenance: { source: { detail } },
  }) as SessionEvent;

describe("durable subagent outcomes", () => {
  test.each([
    [{ kind: "turn.completed", ...turn }, "completed"],
    [{ kind: "turn.interrupted", ...turn }, "interrupted"],
    [{ kind: "attachment.closed", attachmentId: "a", outcome: "interrupted" }, "interrupted"],
    [{ kind: "attachment.closed", attachmentId: "a", outcome: "failed" }, "failed"],
    // No attachment or failure fields participate in the outcome rule.
    [{ kind: "attachment.failed" } as SessionEventPayload, "failed"],
    [receipt(`${OP}:kickoff`), "failed"],
  ] as const)("recognizes %j", (payload, state) => {
    expect(subagentOutcome(payload as SessionEventPayload, OP)).toEqual({
      state,
      stoppedBy: null,
      stopDetail: null,
    });
  });

  test("a stale original kickoff rejection cannot end a resumed watch", () => {
    expect(subagentOutcome(receipt(`${OP}:kickoff`), OP, true)).toBeNull();
    expect(subagentOutcome({ kind: "turn.completed", ...turn }, OP, true)?.state).toBe("completed");
  });

  test("retains structured interruption detail", () => {
    expect(
      subagentOutcome({ kind: "turn.interrupted", ...turn, stopDetail }, OP)?.stopDetail,
    ).toEqual(stopDetail);
  });

  test.each([
    { kind: "session.archived" },
    { kind: "attachment.closed", attachmentId: "a", outcome: "completed" },
    receipt("other:kickoff"),
    receipt(`${OP}:kickoff`, false),
  ] as const)("does not treat %j as an outcome", (payload) => {
    expect(subagentOutcome(payload as SessionEventPayload, OP)).toBeNull();
  });

  test("notice ids retain the frozen local spelling for original and resumed work", () => {
    expect(subagentNoticeIds(OP)).toEqual({
      commandId: `${OP}:answer`,
      messageId: `${OP}:answer-message`,
    });
    expect(subagentNoticeIds(OP, "turn:1")).toEqual({
      commandId: `${OP}:resume:turn:1:answer`,
      messageId: `${OP}:resume:turn:1:answer-message`,
    });
  });

  test("only host notices are excluded from answered-child resumptions", () => {
    for (const reason of [
      "watch-notice",
      "subagent-notice",
      "browser-notice",
      "shell-notice",
      "worktree-notice",
    ] as const) {
      expect(isSubagentHostNoticeOrigin({ kind: "volli", reason })).toBe(true);
    }
    for (const reason of [
      "relaunch-recovery",
      "scheduled-resume",
      "supervision",
      "auto-title",
    ] as const) {
      expect(isSubagentHostNoticeOrigin({ kind: "volli", reason })).toBe(false);
    }
    for (const origin of [
      null,
      { kind: "user" },
      { kind: "session", sessionId: "parent" },
    ] as const) {
      expect(isSubagentHostNoticeOrigin(origin)).toBe(false);
    }
  });

  test("command origin prefers the slim field, including explicit unknown, then falls back to provenance", () => {
    expect(subagentCommandOrigin(originEvent({ sessionOrigin: { kind: "user" } }))).toEqual({
      kind: "user",
    });
    expect(
      subagentCommandOrigin(originEvent({ sessionOrigin: { kind: "user" } }, null)),
    ).toBeNull();
    expect(
      subagentCommandOrigin(originEvent(null, { kind: "session", sessionId: "parent" })),
    ).toEqual({
      kind: "session",
      sessionId: "parent",
    });
    for (const detail of [null, [], "text", 1, {}, { sessionOrigin: { kind: "unknown" } }]) {
      expect(subagentCommandOrigin(originEvent(detail))).toBeNull();
    }
    expect(subagentCommandOrigin({} as SessionEvent)).toBeNull();
  });

  test("only a parent's own earliest stop suppresses the answer", () => {
    const own = subagentOutcome(
      { kind: "session.stopped", reason: null, by: { kind: "session", sessionId: "parent" } },
      OP,
    )!;
    expect(suppressSubagentAnswer(own, "parent")).toBe(true);
    expect(suppressSubagentAnswer(own, "other")).toBe(false);
    expect(suppressSubagentAnswer({ ...own, stoppedBy: null }, "parent")).toBe(false);
    for (const by of [{ kind: "user" }, { kind: "watchdog" }] as const) {
      const stopped = subagentOutcome({ kind: "session.stopped", reason: null, by }, OP)!;
      expect(suppressSubagentAnswer(stopped, "parent")).toBe(false);
    }
    const candidates: SessionEventPayload[] = [
      { kind: "session.archived" },
      receipt(`${OP}:kickoff`),
      { kind: "session.stopped", reason: null, by: { kind: "session", sessionId: "parent" } },
    ];
    const first = candidates
      .map((payload) => subagentOutcome(payload, OP))
      .find((outcome) => outcome !== null)!;
    expect(first.state).toBe("failed");
    expect(suppressSubagentAnswer(first, "parent")).toBe(false);
    expect(
      suppressSubagentAnswer(subagentOutcome({ kind: "turn.completed", ...turn }, OP)!, "parent"),
    ).toBe(false);
  });
});
