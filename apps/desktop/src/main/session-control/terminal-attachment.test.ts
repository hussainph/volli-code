import { describe, expect, it } from "vite-plus/test";
import { EMPTY_SESSION_USAGE_SUMMARY } from "@volli/shared";
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
  exitCode: null,
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
 * The exit code the PTY observed, on its way out of the durable record
 * (VC-290).
 *
 * Before this, `onExit` sent the number to the live renderer and the ledger
 * saved only a completed/failed outcome, so every CLOSED terminal read back
 * `exitCode: null` — indistinguishable from a boot sweep that never saw the
 * process at all. The code is now the ledger's own `attachment.exited` fact and
 * this DTO only carries the projection's answer along; nothing here reparses an
 * adapter's native payload to find it.
 */
describe("terminalSessionRecord exit code", () => {
  const closedTerminal: SessionAttachmentProjection = {
    ...terminalAttachment,
    status: "closed",
    openedAt: 10,
    closedAt: 42,
    outcome: "completed",
    failure: null,
  };

  it("reports a clean exit as the number 0, not as an absence", () => {
    expect(
      terminalSessionRecord(projectionWith([{ ...closedTerminal, exitCode: 0 }])),
    ).toMatchObject({ endedAt: 42, exitCode: 0 });
  });

  it("reports a non-zero code exactly", () => {
    expect(
      terminalSessionRecord(projectionWith([{ ...closedTerminal, exitCode: 137 }])),
    ).toMatchObject({ endedAt: 42, exitCode: 137 });
  });

  // The relaunch sweep closes attachments whose process nobody watched end.
  // That record must stay unavailable rather than borrow the close's outcome.
  it("leaves an unobserved exit null however the attachment was closed", () => {
    expect(
      terminalSessionRecord(projectionWith([{ ...closedTerminal, exitCode: null }])),
    ).toMatchObject({ endedAt: 42, exitCode: null });
  });

  // The projection is the only source. A stale `exitCode` inside an adapter's
  // native detail is not product vocabulary and must not be read back as one.
  it("ignores an exit code left in the adapter's native detail", () => {
    const withNativeExit: SessionAttachmentProjection = {
      ...closedTerminal,
      native: {
        id: null,
        detail: {
          kind: "volli.terminal.v1",
          cwd: "/repo",
          harnessId: "claude-code",
          activeHarnessId: null,
          harnessSessionId: null,
          launchKind: "agent",
          placement: "tab",
          exitCode: 3,
        },
      },
      exitCode: null,
    };

    expect(terminalSessionRecord(projectionWith([withNativeExit]))).toMatchObject({
      cwd: "/repo",
      exitCode: null,
    });
  });
});
