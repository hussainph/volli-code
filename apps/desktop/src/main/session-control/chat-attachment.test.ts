import { describe, expect, it } from "vite-plus/test";
import {
  EMPTY_SESSION_USAGE_SUMMARY,
  SESSION_ATTENTION_KINDS,
  SESSION_USER_BLOCKING_ATTENTION_KINDS,
} from "@volli/shared";
import type {
  ChatWaitingReason,
  SessionAttachmentProjection,
  SessionAttention,
  SessionAttentionKind,
  SessionInteraction,
  SessionProjection,
} from "@volli/shared";
import { chatSessionRecord, latestStructuredAttachment } from "./chat-attachment";

function projectionWith(
  attachments: SessionAttachmentProjection[],
  overrides: Partial<SessionProjection> = {},
): SessionProjection {
  return {
    session: {
      id: "session",
      projectId: "project",
      ticketId: null,
      title: "Plan the migration",
      createdAt: 1,
    },
    status: "open",
    commands: [],
    receipts: [],
    pendingExecutorStart: null,
    attachments,
    liveExecutor: null,
    attention: { active: [], primary: null },
    interactions: { active: [], resolved: [] },
    signal: null,
    turnActive: false,
    authorityDenials: 0,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    lastActivityAt: 1,
    bornTicketless: true,
    ...overrides,
    modelSelection: overrides.modelSelection ?? null,
  };
}

function attentionOf(kind: SessionAttentionKind): Pick<SessionProjection, "attention"> {
  const raised = {
    id: `attention-${kind}`,
    kind,
    attachmentId: null,
    detail: null,
    diagnostic: null,
    retryAt: null,
    resetAt: null,
  } as SessionAttention;
  return { attention: { active: [raised], primary: raised } };
}

function openInteraction(): Pick<SessionProjection, "interactions"> {
  const interaction: SessionInteraction = {
    id: "interaction-1",
    attachmentId: "attachment",
    kind: "permission",
    title: "Allow the edit?",
    detail: null,
    options: [],
    multiple: false,
    native: { id: null, detail: null },
  };
  return { interactions: { active: [interaction], resolved: [] } };
}

function structuredAttachment(
  overrides: Partial<SessionAttachmentProjection> = {},
): SessionAttachmentProjection {
  return {
    id: "attachment",
    sessionId: "session",
    adapterId: "opencode",
    venue: { id: "local", kind: "local" },
    continuity: "fresh",
    native: null,
    status: "open",
    openedAt: 1,
    closedAt: null,
    outcome: null,
    failure: null,
    ...overrides,
  };
}

describe("chatSessionRecord", () => {
  it("has an honest, non-null record for a Session with no attachment at all", () => {
    expect(chatSessionRecord(projectionWith([]))).toEqual({
      sessionId: "session",
      title: "Plan the migration",
      projectId: "project",
      ticketId: null,
      createdAt: 1,
      adapterId: null,
      live: false,
      activity: "idle",
      waitingOn: null,
      lastActivityAt: 1,
      bornTicketless: true,
    });
  });

  it("reads the latest structured attachment's adapter and openness", () => {
    expect(chatSessionRecord(projectionWith([structuredAttachment()]))).toEqual({
      sessionId: "session",
      title: "Plan the migration",
      projectId: "project",
      ticketId: null,
      createdAt: 1,
      adapterId: "opencode",
      live: true,
      activity: "idle",
      waitingOn: null,
      lastActivityAt: 1,
      bornTicketless: true,
    });
  });

  it("reads a closed structured attachment as not live, keeping its adapter", () => {
    expect(
      chatSessionRecord(projectionWith([structuredAttachment({ status: "closed", closedAt: 5 })])),
    ).toMatchObject({ adapterId: "opencode", live: false });
  });

  it("names the newest structured attachment when more than one has ever attached", () => {
    expect(
      chatSessionRecord(
        projectionWith([
          structuredAttachment({ id: "first", status: "closed", closedAt: 5 }),
          structuredAttachment({ id: "second", adapterId: "claude-code", status: "open" }),
        ]),
      ),
    ).toMatchObject({ adapterId: "claude-code", live: true });
  });

  it("calls an untitled structured Session a chat, never a generic Session", () => {
    const projection = projectionWith([]);
    expect(
      chatSessionRecord({ ...projection, session: { ...projection.session, title: null } }),
    ).toMatchObject({
      title: "Chat",
    });
  });

  // A terminal attachment is never this function's business — the precedence
  // between terminal and chat rows is decided by the caller, not here.
  it("ignores a terminal attachment entirely, whether or not a structured one is also present", () => {
    const terminal = structuredAttachment({ id: "terminal", adapterId: "terminal", native: null });
    expect(chatSessionRecord(projectionWith([terminal]))).toMatchObject({
      adapterId: null,
      live: false,
    });
    // A newer terminal attachment does not become the adapter this names, and
    // does not close the structured one that is still open behind it.
    expect(
      chatSessionRecord(projectionWith([structuredAttachment({ id: "structured" }), terminal])),
    ).toMatchObject({ adapterId: "opencode", live: true });
  });
});

describe("chatSessionRecord activity", () => {
  it("reads an open turn on an open attachment as working", () => {
    expect(
      chatSessionRecord(projectionWith([structuredAttachment()], { turnActive: true })),
    ).toMatchObject({ activity: "working" });
  });

  it("is idle with no turn open, however live the attachment is", () => {
    expect(chatSessionRecord(projectionWith([structuredAttachment()]))).toMatchObject({
      activity: "idle",
    });
  });

  // A turn that outlived its executor is a crash, not progress: the fold clears
  // `turnActive` on the attachment ending, and this pins the second guard that
  // stops a stale one from reading as work anyway.
  it("is idle when the attachment has closed, even under a stale open turn", () => {
    expect(
      chatSessionRecord(
        projectionWith([structuredAttachment({ status: "closed", closedAt: 5 })], {
          turnActive: true,
        }),
      ),
    ).toMatchObject({ activity: "idle" });
    expect(chatSessionRecord(projectionWith([], { turnActive: true }))).toMatchObject({
      activity: "idle",
    });
  });

  it("reads an unanswered Interaction as waiting on a question", () => {
    expect(
      chatSessionRecord(projectionWith([structuredAttachment()], openInteraction())),
    ).toMatchObject({ activity: "waiting", waitingOn: "question" });
  });

  it("reads every Attention a human clears as waiting, with the word for it", () => {
    const expected: Record<
      (typeof SESSION_USER_BLOCKING_ATTENTION_KINDS)[number],
      ChatWaitingReason
    > = {
      input_required: "question",
      permission_required: "permission",
      auth_required: "auth",
    };
    for (const kind of SESSION_USER_BLOCKING_ATTENTION_KINDS) {
      expect(
        chatSessionRecord(projectionWith([structuredAttachment()], attentionOf(kind))),
      ).toMatchObject({ activity: "waiting", waitingOn: expected[kind] });
    }
    // A rate limit stops the agent too, but nobody is being asked anything —
    // so there is no word for it, and the row must not prompt anyone to act.
    expect(
      chatSessionRecord(projectionWith([structuredAttachment()], attentionOf("rate_limited"))),
    ).toMatchObject({ activity: "idle", waitingOn: null });
  });

  it("lets an open Interaction outrank a concurrent Attention", () => {
    expect(
      chatSessionRecord(
        projectionWith([structuredAttachment()], {
          ...openInteraction(),
          ...attentionOf("auth_required"),
        }),
      ),
    ).toMatchObject({ activity: "waiting", waitingOn: "question" });
  });

  // The two fields are derived separately and must not be able to disagree: a
  // row saying a human is needed while having nothing for them to do (or vice
  // versa) is the drift the shared `sessionAwaitsUser` predicate exists to stop.
  it("keeps waiting and waitingOn inseparable across every projection shape", () => {
    const shapes: Partial<SessionProjection>[] = [
      {},
      { turnActive: true },
      openInteraction(),
      ...SESSION_ATTENTION_KINDS.map((kind) => attentionOf(kind)),
      { turnActive: true, ...openInteraction() },
    ];
    for (const shape of shapes) {
      const record = chatSessionRecord(projectionWith([structuredAttachment()], shape));
      expect(record.waitingOn !== null).toBe(record.activity === "waiting");
    }
  });

  it("lets waiting outrank working, so a mid-turn question is not hidden", () => {
    expect(
      chatSessionRecord(
        projectionWith([structuredAttachment()], { turnActive: true, ...openInteraction() }),
      ),
    ).toMatchObject({ activity: "waiting" });
  });

  it("passes the projection's recency through untouched", () => {
    expect(chatSessionRecord(projectionWith([], { lastActivityAt: 4242 }))).toMatchObject({
      lastActivityAt: 4242,
    });
  });

  it("passes the projection's bornTicketless through untouched", () => {
    expect(chatSessionRecord(projectionWith([], { bornTicketless: false }))).toMatchObject({
      bornTicketless: false,
    });
  });
});

describe("latestStructuredAttachment", () => {
  it("is null when nothing has ever attached", () => {
    expect(latestStructuredAttachment([])).toBeNull();
  });

  it("skips terminal attachments", () => {
    const terminal = structuredAttachment({ adapterId: "terminal" });
    expect(latestStructuredAttachment([terminal])).toBeNull();
  });

  it("picks the newest non-terminal attachment", () => {
    const first = structuredAttachment({ id: "first" });
    const second = structuredAttachment({ id: "second", adapterId: "claude-code" });
    expect(latestStructuredAttachment([first, second])).toEqual(second);
  });
});
