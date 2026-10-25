import { describe, expect, test } from "vite-plus/test";

import { noticeProse, type WatchChangeV1 } from "../session-notice";
import {
  INVALID_JOB_PAYLOAD,
  InvalidJobPayloadError,
  JOB_PAYLOAD_MAX_CHARS,
  SESSION_NOTICE_FORMAT,
  WATCH_NOTICE_MAX_CHANGES,
  parseJobPayload,
  type SubagentNoticeJobPayload,
  type WatchNoticeJobPayload,
} from "./job-payloads";
import {
  boardEventWatchActor,
  composeSessionNotice,
  mergeWatchNotice,
  newWatchNotice,
  sessionNoticeMessageId,
  watchNoticeCommandId,
} from "./notices";
import type { UserId } from "./ids";

const WATCHER = "aaaaaaaa-0000-4000-8000-000000000000";
const TARGET = "bbbbbbbb-0000-4000-8000-000000000000";
const CHILD = "dddddddd-0000-4000-8000-000000000000";
const TICKET = "6f1c2a4e-8b3d-4c5e-9f60-718293a4b5c6";
const USER = "99999999-8888-4777-8666-555555555555" as UserId;
const JOB = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const COMMAND = watchNoticeCommandId(WATCHER, JOB);

const DETAIL = {
  category: "rate-limited",
  message: "slow down",
  providerType: "rate_limit_error",
  httpStatus: 429,
  retry: "exhausted",
  resetsAt: 5,
} as const;

const session = { subject: "session" as const, sessionId: TARGET, title: "Fix", occurredAt: 1 };
const ticket = {
  subject: "ticket" as const,
  ticketId: TICKET,
  display: "VC-12",
  by: { kind: "session" as const, sessionId: TARGET },
  occurredAt: null,
};

/** One of every change shape, every optional field both ways across the list. */
const CHANGES: WatchChangeV1[] = [
  {
    ...session,
    fact: "turn-completed",
    pendingSubagents: [CHILD],
    lastMessage: { state: "text", message: noticeProse("said") },
  },
  { ...session, fact: "turn-completed", pendingSubagents: [], lastMessage: { state: "unread" } },
  {
    ...session,
    title: null,
    fact: "turn-interrupted",
    pendingSubagents: [],
    stopDetail: DETAIL,
    lastMessage: { state: "unreadable", error: "gone" },
  },
  {
    ...session,
    fact: "turn-interrupted",
    pendingSubagents: [],
    stopDetail: { ...DETAIL, message: null, providerType: null, httpStatus: null, resetsAt: null },
    lastMessage: { state: "none" },
  },
  {
    ...session,
    fact: "turn-interrupted",
    pendingSubagents: [],
    stopDetail: null,
    lastMessage: { state: "unreadable", error: null },
  },
  { ...session, fact: "signaled-done", pendingSubagents: [], reason: noticeProse("ok") },
  { ...session, fact: "signaled-blocked", pendingSubagents: [], reason: null },
  {
    ...session,
    fact: "stopped",
    by: { kind: "session", sessionId: CHILD },
    reason: noticeProse("x"),
  },
  { ...session, fact: "stopped", by: { kind: "user" }, reason: null },
  { ...ticket, fact: "ticket-moved", from: "todo", to: "doing" },
  {
    ...ticket,
    by: { kind: "session", sessionId: null },
    fact: "ticket-commented",
    comment: noticeProse("hi"),
  },
  { ...ticket, by: { kind: "person" }, fact: "ticket-commented", comment: null },
  {
    ...ticket,
    fact: "ticket-signaled",
    signalKind: "review",
    verdict: "pass",
    detail: noticeProse("d"),
  },
  {
    ...ticket,
    by: { kind: "volli" },
    fact: "ticket-signaled",
    signalKind: "merge",
    verdict: "fail",
    detail: null,
  },
];

const SUBAGENT: SubagentNoticeJobPayload = {
  format: SESSION_NOTICE_FORMAT,
  notice: "subagent",
  commandId: `${WATCHER}:call-1:answer`,
  childSessionId: CHILD as SubagentNoticeJobPayload["childSessionId"],
  title: "Review",
  state: "stopped",
  reason: null,
  stoppedBy: { kind: "session", sessionId: WATCHER },
  stopDetail: DETAIL,
  answer: { state: "text", message: noticeProse("All good.") },
};

function refusal(value: unknown): string {
  try {
    parseJobPayload("session.notice", value);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidJobPayloadError);
    expect((error as InvalidJobPayloadError).code).toBe(INVALID_JOB_PAYLOAD);
    return (error as Error).message;
  }
  throw new Error(`accepted ${JSON.stringify(value)}`);
}

describe("the session.notice codec", () => {
  test("round-trips a watch notice with every change shape, and a subagent notice", () => {
    const watch = mergeWatchNotice(newWatchNotice(COMMAND), CHANGES);
    expect(watch.changes).toHaveLength(CHANGES.length);
    expect(parseJobPayload("session.notice", JSON.parse(JSON.stringify(watch)))).toEqual(watch);
    expect(parseJobPayload("session.notice", SUBAGENT)).toEqual(SUBAGENT);
    for (const variant of [
      { reason: "app-relaunched", stoppedBy: { kind: "user" }, stopDetail: null },
      { stoppedBy: null, answer: { state: "none" } },
      { answer: { state: "unread" } },
      { answer: { state: "unreadable", error: null } },
    ]) {
      const payload = { ...SUBAGENT, ...variant };
      expect(parseJobPayload("session.notice", payload)).toEqual(payload);
    }
  });

  test("refuses ids that are not a notice's frozen shape", () => {
    expect(refusal({ ...newWatchNotice("op:answer") })).toMatch(/not a watch notice id/);
    expect(refusal({ ...SUBAGENT, commandId: COMMAND })).toMatch(/not a subagent answer id/);
    expect(refusal({ ...SUBAGENT, notice: "other" })).toMatch(
      /notice is not one of watch, subagent/,
    );
    expect(refusal({ ...SUBAGENT, extra: 1 })).toMatch(/unexpected field "extra"/);
    expect(refusal({ ...newWatchNotice(COMMAND), extra: 1 })).toMatch(/unexpected field "extra"/);
    expect(refusal({ ...SUBAGENT, reason: "later" })).toMatch(
      /reason is not one of app-relaunched/,
    );
  });

  test("refuses malformed changes, naming where", () => {
    const watch = (change: unknown, extra: Record<string, unknown> = {}) => ({
      ...newWatchNotice(COMMAND),
      changes: [change],
      ...extra,
    });
    expect(refusal(watch(null, { changes: "no" }))).toMatch(/changes is not a list of at most 50/);
    expect(refusal(watch(null))).toMatch(/changes\[0\] is not an object/);
    expect(refusal(watch(CHANGES[0], { overflow: -1 }))).toMatch(
      /overflow is not a non-negative integer/,
    );
    expect(refusal(watch({ ...CHANGES[0], occurredAt: 1.5 }))).toMatch(
      /changes\[0\]\.occurredAt is not a non-negative integer/,
    );
    expect(refusal(watch({ ...CHANGES[0], pendingSubagents: ["x"] }))).toMatch(
      /changes\[0\]\.pendingSubagents\[0\] is not a UUID/,
    );
    expect(refusal(watch({ ...CHANGES[0], title: 3 }))).toMatch(
      /title is not a string of at most 200/,
    );
    expect(
      refusal(
        watch({
          ...CHANGES[0],
          lastMessage: { state: "text", message: { text: "abc", totalChars: 2 } },
        }),
      ),
    ).toMatch(/lastMessage\.message\.totalChars is shorter than text/);
    expect(refusal(watch({ ...CHANGES[0], lastMessage: { state: "none", extra: 1 } }))).toMatch(
      /unexpected field "extra"/,
    );
    expect(refusal(watch({ ...CHANGES[2], stopDetail: { ...DETAIL, retry: "maybe" } }))).toMatch(
      /stopDetail\.retry is not one of/,
    );
    expect(refusal(watch({ ...CHANGES[7], by: { kind: "session", sessionId: "x" } }))).toMatch(
      /by\.sessionId is not a UUID/,
    );
    expect(refusal(watch({ ...CHANGES[8], by: { kind: "user", sessionId: TARGET } }))).toMatch(
      /unexpected field "sessionId"/,
    );
    expect(refusal(watch({ ...CHANGES[9], to: "nowhere" }))).toMatch(/to is not one of/);
    expect(refusal(watch({ ...CHANGES[9], display: "" }))).toMatch(
      /display is not text of 1 to 64/,
    );
    expect(refusal(watch({ ...CHANGES[11], by: { kind: "person", sessionId: null } }))).toMatch(
      /unexpected field "sessionId"/,
    );
    expect(refusal(watch({ ...CHANGES[9], fact: "turn-completed" }))).toMatch(/fact is not one of/);
    expect(refusal(watch({ ...CHANGES[0], subject: "board" }))).toMatch(/subject is not one of/);
    expect(refusal(watch({ ...CHANGES[0], stopDetail: null }))).toMatch(
      /unexpected field "stopDetail"/,
    );
    for (const index of [2, 5, 7, 10, 12]) {
      expect(refusal(watch({ ...CHANGES[index], extra: 1 }))).toMatch(/unexpected field "extra"/);
    }
    expect(
      refusal(
        watch(null, {
          changes: Array.from({ length: WATCH_NOTICE_MAX_CHANGES + 1 }, () => CHANGES[1]),
        }),
      ),
    ).toMatch(/changes is not a list of at most 50 items/);
  });
});

describe("mergeWatchNotice", () => {
  test("appends in order without touching the notice it was given", () => {
    const first = mergeWatchNotice(newWatchNotice(COMMAND), [CHANGES[0]!]);
    const second = mergeWatchNotice(first, [CHANGES[9]!, CHANGES[5]!]);
    expect(first.changes).toEqual([CHANGES[0]]);
    expect(second).toEqual({
      format: SESSION_NOTICE_FORMAT,
      notice: "watch",
      commandId: COMMAND,
      changes: [CHANGES[0], CHANGES[9], CHANGES[5]],
      overflow: 0,
    });
  });

  test("lists the first 50 changes and counts the rest", () => {
    const many = Array.from({ length: 53 }, () => CHANGES[1]!);
    const notice = mergeWatchNotice(newWatchNotice(COMMAND), many);
    expect(notice.changes).toHaveLength(WATCH_NOTICE_MAX_CHANGES);
    expect(notice.overflow).toBe(3);
    expect(mergeWatchNotice(notice, [CHANGES[1]!]).overflow).toBe(4);
  });

  test("a change that would pass the payload bound overflows, and so does every later one", () => {
    const big: WatchChangeV1 = {
      ...ticket,
      fact: "ticket-commented",
      comment: noticeProse("z".repeat(JOB_PAYLOAD_MAX_CHARS)),
    };
    const notice: WatchNoticeJobPayload = mergeWatchNotice(newWatchNotice(COMMAND), [
      CHANGES[1]!,
      big,
      CHANGES[1]!,
    ]);
    expect(notice.changes).toEqual([CHANGES[1]]);
    expect(notice.overflow).toBe(2);
    expect(JSON.stringify(notice).length).toBeLessThanOrEqual(JOB_PAYLOAD_MAX_CHARS);
  });
});

describe("helpers", () => {
  test("message ids derive from command ids as the local writers derive them", () => {
    expect(sessionNoticeMessageId(newWatchNotice(COMMAND))).toBe(`watch:${WATCHER}:${JOB}:message`);
    expect(sessionNoticeMessageId(SUBAGENT)).toBe(`${WATCHER}:call-1:answer-message`);
    expect(sessionNoticeMessageId({ ...SUBAGENT, commandId: "op:resume:turn-2:answer" })).toBe(
      "op:resume:turn-2:answer-message",
    );
  });

  test("a board event's actor, and the Session it names as its author", () => {
    expect(boardEventWatchActor({ kind: "person", userId: USER })).toEqual({
      by: { kind: "person" },
      actorSessionId: null,
    });
    expect(
      boardEventWatchActor({ kind: "agent", userId: USER, sessionId: TARGET as never }),
    ).toEqual({ by: { kind: "session", sessionId: TARGET }, actorSessionId: TARGET });
    expect(
      boardEventWatchActor({ kind: "automation", userId: USER, automationId: "a", runId: "r" }),
    ).toEqual({ by: { kind: "automation" }, actorSessionId: null });
    expect(
      boardEventWatchActor({
        kind: "automation",
        userId: USER,
        automationId: "a",
        runId: "r",
        sessionId: TARGET as never,
      }),
    ).toEqual({ by: { kind: "automation" }, actorSessionId: TARGET });
    expect(boardEventWatchActor({ kind: "volli", reason: "retention" })).toEqual({
      by: { kind: "volli" },
      actorSessionId: null,
    });
    expect(boardEventWatchActor({ kind: "legacy", was: "session", sessionId: "s1" })).toEqual({
      by: { kind: "session", sessionId: "s1" },
      actorSessionId: "s1",
    });
    expect(boardEventWatchActor({ kind: "legacy", was: "session" })).toEqual({
      by: { kind: "session", sessionId: null },
      actorSessionId: null,
    });
    expect(boardEventWatchActor({ kind: "legacy", was: "automation" }).by).toEqual({
      kind: "automation",
    });
    expect(boardEventWatchActor({ kind: "legacy", was: "unauthenticated" }).by).toEqual({
      kind: "unauthenticated",
    });
    expect(boardEventWatchActor({ kind: "legacy", was: "user" }).by).toEqual({ kind: "person" });
  });

  test("a runner composes either notice with its ids, minting nonces only for a watch", () => {
    let minted = 0;
    const nonce = () => `nonce-${++minted}`;
    const watch = composeSessionNotice(
      mergeWatchNotice(newWatchNotice(COMMAND), [CHANGES[5]!, CHANGES[1]!]),
      { sessionId: WATCHER, nonce },
    );
    expect(watch.commandId).toBe(COMMAND);
    expect(watch.messageId).toBe(`${COMMAND}:message`);
    expect(watch.text).toContain("--- begin untrusted signal reason nonce-1 ---");
    expect(watch.metadata.notice.kind).toBe("watch");
    const overflowed = composeSessionNotice(
      { ...newWatchNotice(COMMAND), overflow: 2 },
      {
        sessionId: WATCHER,
        nonce,
      },
    );
    expect(overflowed.text).toContain("2 more changes did not fit");
    const subagent = composeSessionNotice(SUBAGENT, { sessionId: WATCHER, nonce });
    expect(minted).toBe(1);
    expect(subagent.messageId).toBe(`${WATCHER}:call-1:answer-message`);
    expect(subagent.text.split("\n")[0]).toBe(
      `[Subagent Session dddddddd ("Review") was stopped by you before it answered. This notice is from Volli, not your user.]`,
    );
    expect(subagent.metadata.notice).toEqual({
      kind: "subagent",
      childSessionId: CHILD,
      title: "Review",
      state: "stopped",
      reason: null,
    });
  });
});
