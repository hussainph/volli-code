import { describe, expect, it } from "vite-plus/test";
import type { SessionAttachmentProjection, SessionProjection } from "@volli/shared";
import { chatSessionRecord, latestStructuredAttachment } from "./chat-attachment";

function projectionWith(attachments: SessionAttachmentProjection[]): SessionProjection {
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
    capabilities: [],
    interactions: { active: [], resolved: [] },
    signal: null,
  };
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

  it("falls back to a generic title for a Session that was never given one", () => {
    const projection = projectionWith([]);
    expect(
      chatSessionRecord({ ...projection, session: { ...projection.session, title: null } }),
    ).toMatchObject({
      title: "Session",
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
