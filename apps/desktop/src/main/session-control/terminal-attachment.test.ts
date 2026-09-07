import { describe, expect, it } from "vite-plus/test";
import { EMPTY_SESSION_USAGE_SUMMARY } from "@volli/shared";
import type { SessionAttachmentProjection, SessionProjection } from "@volli/shared";
import {
  readTerminalAttachmentDetail,
  terminalExitDetail,
  terminalNativeReference,
  terminalSessionRecord,
} from "./terminal-attachment";

function projectionWith(attachments: SessionAttachmentProjection[]): SessionProjection {
  return {
    session: {
      id: "session",
      projectId: "project",
      ticketId: null,
      role: "project",
      parentSessionId: null,
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
    interactions: { active: [], resolved: [] },
    signal: null,
    stopped: null,
    modelSelection: null,
    modelTier: null,
    turnActive: false,
    lastTurnOutcome: null,
    authorityDenials: 0,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    lastActivityAt: 1,
    bornTicketless: true,
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
  authority: null,
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
      lastActivityAt: 1,
      bornTicketless: true,
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
      lastActivityAt: 1,
      bornTicketless: true,
    });
  });

  it("passes the projection's bornTicketless through untouched", () => {
    expect(
      terminalSessionRecord({
        ...projectionWith([terminalAttachment]),
        bornTicketless: false,
      }),
    ).toMatchObject({ bornTicketless: false });
  });
});

/**
 * The exit code the PTY observed, on its way into the durable record (VC-290).
 * Before this, `onExit` sent the number to the live renderer and saved only a
 * completed/failed outcome, so every CLOSED terminal read back `exitCode: null`
 * — indistinguishable from a boot sweep that never saw the process at all.
 */
describe("terminalExitDetail", () => {
  const openTerminal: SessionAttachmentProjection = {
    ...terminalAttachment,
    status: "open",
    openedAt: 10,
    closedAt: null,
    outcome: null,
    failure: null,
  };

  it("stamps the observed code onto the attachment's current native detail", () => {
    expect(terminalExitDetail(projectionWith([openTerminal]), "attachment", 137)).toEqual({
      kind: "volli.terminal.v1",
      cwd: "/repo",
      harnessId: "claude-code",
      activeHarnessId: null,
      harnessSessionId: null,
      launchKind: "agent",
      placement: "tab",
      exitCode: 137,
    });
  });

  it("records a clean exit as the number 0, not as an absence", () => {
    expect(terminalExitDetail(projectionWith([openTerminal]), "attachment", 0)).toMatchObject({
      exitCode: 0,
    });
  });

  // The launch snapshot is NOT what gets re-emitted: hooks and the CLI socket
  // may have linked a newer harness id to this attachment since it opened, and
  // stamping an exit code must not roll that evidence back.
  it("preserves harness evidence linked after launch", () => {
    const linked: SessionAttachmentProjection = {
      ...openTerminal,
      native: terminalNativeReference({
        kind: "volli.terminal.v1",
        cwd: "/repo",
        harnessId: "claude-code",
        activeHarnessId: "codex",
        harnessSessionId: "harness-uuid",
        launchKind: "agent",
        placement: "tab",
        exitCode: null,
      }),
    };

    expect(terminalExitDetail(projectionWith([linked]), "attachment", 1)).toMatchObject({
      activeHarnessId: "codex",
      harnessSessionId: "harness-uuid",
      exitCode: 1,
    });
  });

  it("writes nothing when the code it would record is already there", () => {
    const stamped: SessionAttachmentProjection = {
      ...openTerminal,
      native: terminalNativeReference({
        kind: "volli.terminal.v1",
        cwd: "/repo",
        harnessId: "claude-code",
        activeHarnessId: null,
        harnessSessionId: null,
        launchKind: "agent",
        placement: "tab",
        exitCode: 2,
      }),
    };

    expect(terminalExitDetail(projectionWith([stamped]), "attachment", 2)).toBeNull();
  });

  it("writes nothing for a Session, attachment or detail it cannot read", () => {
    expect(terminalExitDetail(null, "attachment", 0)).toBeNull();
    expect(terminalExitDetail(projectionWith([openTerminal]), "other-attachment", 0)).toBeNull();
    expect(
      terminalExitDetail(projectionWith([{ ...openTerminal, native: null }]), "attachment", 0),
    ).toBeNull();
  });

  // An attachment the ledger has already closed is history. Re-referencing its
  // native detail would be writing to a finished record.
  it("writes nothing for an attachment that is no longer open", () => {
    expect(terminalExitDetail(projectionWith([terminalAttachment]), "attachment", 0)).toBeNull();
  });
});
