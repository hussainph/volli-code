import { describe, expect, it } from "vite-plus/test";
import type {
  ApprovalCommand,
  ApprovalCommandReceipt,
  ApprovalMutationEvent,
  AuthorityApproval,
} from "@volli/shared";
import { executeApprovalCommand, type ApprovalCommandStore } from "./approval-commands";

const row: AuthorityApproval = {
  id: "a",
  projectId: "p",
  scope: "project",
  sessionId: null,
  operation: "read",
  key: "/outside/file",
  rule: "path.outside-workspace",
  summary: "Read /outside/file",
  createdAt: 1,
  useCount: 0,
  lastUsedAt: null,
  lastUsedBySessionId: null,
  provenance: {
    sessionId: "s",
    sessionTitle: null,
    ticketDisplayId: null,
    asked: "read",
    reason: "outside",
    interactionId: "i",
  },
};
function fixture(exists = true) {
  const commands = new Map<string, { command: ApprovalCommand; receipt: ApprovalCommandReceipt }>();
  const events: ApprovalMutationEvent[] = [];
  const store: ApprovalCommandStore = {
    transact: (run) => run(),
    read: (id) => commands.get(id) ?? null,
    approval: () => (exists ? row : null),
    commit: (command, receipt, event) => {
      commands.set(command.commandId, { command, receipt });
      if (event !== null) events.push(event);
    },
  };
  return { store, commands, events };
}
describe("approval Command boundary", () => {
  it.each(["approval.revoke", "approval.restore"] as const)(
    "records and replays %s without a second event",
    (kind) => {
      const f = fixture();
      const command = { commandId: "command", kind, approvalId: "a" };
      const receipt = executeApprovalCommand(f.store, command, () => 10);
      expect(receipt).toEqual({
        commandId: "command",
        status: "accepted",
        eventId: "approval-command:command",
        approval: row,
      });
      expect(f.events).toEqual([
        {
          id: "approval-command:command",
          commandId: "command",
          kind: kind === "approval.revoke" ? "approval.revoked" : "approval.restored",
          approvalId: "a",
          occurredAt: 10,
          approval: row,
        },
      ]);
      expect(executeApprovalCommand(f.store, command, () => 20)).toEqual(receipt);
      expect(f.events).toHaveLength(1);
      expect(
        executeApprovalCommand(f.store, { ...command, approvalId: "different" }, () => 20),
      ).toEqual({ commandId: "command", status: "rejected", code: "APPROVAL_COMMAND_CONFLICT" });
      expect(
        executeApprovalCommand(
          f.store,
          { ...command, kind: kind === "approval.revoke" ? "approval.restore" : "approval.revoke" },
          () => 20,
        ),
      ).toMatchObject({ code: "APPROVAL_COMMAND_CONFLICT" });
    },
  );
  it("durably rejects missing rows and replays the rejection", () => {
    const f = fixture(false);
    const command = {
      commandId: "missing",
      kind: "approval.revoke" as const,
      approvalId: "missing",
    };
    const receipt = executeApprovalCommand(f.store, command, () => 10);
    expect(receipt).toEqual({
      commandId: "missing",
      status: "rejected",
      code: "APPROVAL_NOT_FOUND",
    });
    expect(f.events).toEqual([]);
    expect(executeApprovalCommand(f.store, command, () => 20)).toEqual(receipt);
  });
});
