import { describe, expect, it } from "vite-plus/test";
import type { SessionProjection } from "@volli/shared";
import {
  readTerminalAttachmentDetail,
  terminalNativeReference,
  terminalSessionRecord,
} from "./terminal-attachment";

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
    const projection: SessionProjection = {
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
      attachments: [
        {
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
        },
      ],
      liveExecutor: null,
      attention: { active: [], primary: null },
      capabilities: [],
      interactions: { active: [], resolved: [] },
      signal: null,
    };

    expect(terminalSessionRecord(projection).endedAt).toBe(42);
  });
});
