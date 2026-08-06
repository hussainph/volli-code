import { describe, expect, it } from "vite-plus/test";
import type { SessionAttachmentProjection, SessionProjection } from "@volli/shared";
import {
  readTerminalAttachmentDetail,
  terminalNativeReference,
  terminalSessionRecord,
} from "./terminal-attachment";

function projectionWith(attachments: SessionAttachmentProjection[]): SessionProjection {
  return {
    session: {
      id: "session",
      projectId: "project",
      ticketId: null,
      title: "Failed",
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
    turnActive: false,
    lastActivityAt: 1,
  };
}

const terminalAttachment: SessionAttachmentProjection = {
  id: "attachment",
  sessionId: "session",
  adapterId: "terminal",
  venue: { id: "local", kind: "local" },
  continuity: "fresh",
  native: terminalNativeReference({
    kind: "volli.terminal.v1",
    cwd: "/repo",
    harnessId: "claude-code",
    activeHarnessId: null,
    harnessSessionId: null,
    launchKind: "agent",
    placement: "tab",
    exitCode: null,
  }),
  status: "failed",
  openedAt: null,
  closedAt: 42,
  outcome: "failed",
  failure: { code: "terminal_start_failed", detail: null, diagnostic: null },
};

describe("readTerminalAttachmentDetail", () => {
  it("rejects terminal native details whose harness ids are not valid harness slugs", () => {
    expect(
      readTerminalAttachmentDetail({
        id: null,
        detail: {
          kind: "volli.terminal.v1",
          cwd: "/repo",
          harnessId: "../../not-a-harness",
          activeHarnessId: "also invalid!",
          harnessSessionId: null,
          launchKind: "agent",
          placement: "tab",
          exitCode: null,
        },
      }),
    ).toBeNull();
  });

  it("projects the failed terminal attachment timestamp as an ended session", () => {
    expect(terminalSessionRecord(projectionWith([terminalAttachment]))).toEqual({
      id: "session",
      projectId: "project",
      ticketId: null,
      harnessId: "claude-code",
      activeHarnessId: null,
      harnessSessionId: null,
      launchKind: "agent",
      placement: "tab",
      title: "Failed",
      cwd: "/repo",
      createdAt: 1,
      endedAt: 42,
      exitCode: null,
    });
  });

  // The record is terminal facts end to end, so a Session that never had a
  // terminal has none of them. Fabricating the row is what made a structured
  // chat Session read as a never-ending claude-code terminal.
  it("has no record for a Session that never opened a terminal attachment", () => {
    expect(terminalSessionRecord(projectionWith([]))).toBeNull();
  });

  it("has no record for a Session whose only attachment is a structured adapter", () => {
    expect(
      terminalSessionRecord(
        projectionWith([{ ...terminalAttachment, adapterId: "opencode", native: null }]),
      ),
    ).toBeNull();
  });

  // A terminal whose native detail cannot be read is still honestly a terminal:
  // the record survives, carrying the `unknown` metadata reserved for exactly
  // that. This is the one case the defaults below `null` still serve.
  it("keeps a record for a terminal attachment whose native detail is unreadable", () => {
    expect(
      terminalSessionRecord(projectionWith([{ ...terminalAttachment, native: null }])),
    ).toEqual({
      id: "session",
      projectId: "project",
      ticketId: null,
      harnessId: "claude-code",
      activeHarnessId: null,
      harnessSessionId: null,
      launchKind: "unknown",
      placement: "unknown",
      title: "Failed",
      cwd: "",
      createdAt: 1,
      endedAt: 42,
      exitCode: null,
    });
  });
});
