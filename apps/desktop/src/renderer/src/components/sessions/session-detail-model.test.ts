import { describe, expect, it } from "vite-plus/test";
import type { SessionRecord, Ticket } from "@volli/shared";

import {
  buildTerminalSessionDetail,
  TERMINAL_LAST_COMMAND_NOT_RECORDED,
  TERMINAL_OUTPUT_NOT_SAVED,
} from "./session-detail-model";

function record(overrides: Partial<SessionRecord> & { id: string }): SessionRecord {
  return {
    id: overrides.id,
    projectId: overrides.projectId ?? "p1",
    ticketId: overrides.ticketId ?? null,
    harnessId: overrides.harnessId ?? "claude-code",
    activeHarnessId: overrides.activeHarnessId ?? null,
    harnessSessionId: overrides.harnessSessionId ?? null,
    launchKind: overrides.launchKind ?? "agent",
    placement: overrides.placement ?? "tab",
    title: overrides.title ?? "Session 2",
    cwd: overrides.cwd ?? "/repo/worktrees/vc-290",
    createdAt: overrides.createdAt ?? 1_000,
    // `??` would turn an explicit `null` (a still-live record) back into a stamp.
    endedAt: overrides.endedAt === undefined ? 2_000 : overrides.endedAt,
    exitCode: overrides.exitCode ?? null,
    lastActivityAt: overrides.lastActivityAt ?? 2_000,
    bornTicketless: overrides.bornTicketless ?? (overrides.ticketId ?? null) === null,
  };
}

function ticket(overrides: Partial<Ticket> & { id: string }): Ticket {
  return {
    id: overrides.id,
    projectId: "p1",
    ticketNumber: overrides.ticketNumber ?? 290,
    title: overrides.title ?? "Closed terminal history",
    body: "",
    status: overrides.status ?? "doing",
    priority: "medium",
    labels: [],
    usesWorktree: true,
    preferredHarnessId: "claude-code",
    order: 0,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("buildTerminalSessionDetail", () => {
  it("names the ticket a ticket Session belongs to", () => {
    const detail = buildTerminalSessionDetail({
      record: record({ id: "s1", ticketId: "t1" }),
      ticket: ticket({ id: "t1" }),
      ticketPrefix: "VC",
    });

    expect(detail.scope).toEqual({
      kind: "ticket",
      ticketId: "t1",
      displayId: "VC-290",
      title: "Closed terminal history",
    });
    expect(detail.scopeLabel).toBe("VC-290 · Closed terminal history");
    expect(detail.recreate).toEqual({ kind: "ticket", ticketId: "t1" });
  });

  it("calls a Session born without a ticket a project session", () => {
    const detail = buildTerminalSessionDetail({
      record: record({ id: "s1", ticketId: null, bornTicketless: true }),
      ticket: null,
      ticketPrefix: "VC",
    });

    expect(detail.scope).toEqual({ kind: "project" });
    expect(detail.scopeLabel).toBe("Project session");
    expect(detail.recreate).toEqual({ kind: "project" });
  });

  it("says the ticket is unavailable when the record names one nothing can find", () => {
    const detail = buildTerminalSessionDetail({
      record: record({ id: "s1", ticketId: "gone" }),
      ticket: null,
      ticketPrefix: "VC",
    });

    expect(detail.scope).toEqual({ kind: "unavailable" });
    expect(detail.scopeLabel).toBe("Ticket unavailable");
    // Nothing to recreate INTO: the ticket scope this Session ran in is gone,
    // and a project terminal would be a different scope wearing its name.
    expect(detail.recreate).toBeNull();
  });

  it("says the ticket is unavailable for a Session orphaned out of one", () => {
    // `ticketId` is ON DELETE SET NULL, so a deleted ticket leaves a null id on
    // a Session that was never ticketless. It is not a project session.
    const detail = buildTerminalSessionDetail({
      record: record({ id: "s1", ticketId: null, bornTicketless: false }),
      ticket: null,
      ticketPrefix: "VC",
    });

    expect(detail.scope).toEqual({ kind: "unavailable" });
    expect(detail.recreate).toBeNull();
  });

  it("shows a clean exit as code 0 rather than as an absence", () => {
    const detail = buildTerminalSessionDetail({
      record: record({ id: "s1", exitCode: 0 }),
      ticket: null,
      ticketPrefix: "VC",
    });

    expect(detail.exit).toEqual({ kind: "code", code: 0 });
    expect(detail.exitLabel).toBe("Exit code 0");
  });

  it("shows a failure's exact code", () => {
    const detail = buildTerminalSessionDetail({
      record: record({ id: "s1", exitCode: 137 }),
      ticket: null,
      ticketPrefix: "VC",
    });

    expect(detail.exit).toEqual({ kind: "code", code: 137 });
    expect(detail.exitLabel).toBe("Exit code 137");
  });

  it("refuses to guess for a record whose exit was never observed", () => {
    // Old rows, and every close a startup sweep made rather than a PTY.
    const detail = buildTerminalSessionDetail({
      record: record({ id: "s1", exitCode: null }),
      ticket: null,
      ticketPrefix: "VC",
    });

    expect(detail.exit).toEqual({ kind: "unavailable" });
    expect(detail.exitLabel).toBe("Exit status unavailable");
  });

  it("does not call a live Session's missing code an unavailable exit", () => {
    const detail = buildTerminalSessionDetail({
      record: record({ id: "s1", endedAt: null, exitCode: null }),
      ticket: null,
      ticketPrefix: "VC",
    });

    expect(detail.closed).toBe(false);
    expect(detail.exit).toEqual({ kind: "running" });
    expect(detail.exitLabel).toBe("Still running");
  });

  it("carries identity, times and the working folder straight off the record", () => {
    const detail = buildTerminalSessionDetail({
      record: record({
        id: "s1",
        title: "Session 3",
        createdAt: 1_700,
        endedAt: 9_100,
        cwd: "/repo/worktrees/vc-290",
        launchKind: "shell",
      }),
      ticket: null,
      ticketPrefix: "VC",
    });

    expect(detail).toMatchObject({
      sessionId: "s1",
      projectId: "p1",
      title: "Session 3",
      startedAt: 1_700,
      endedAt: 9_100,
      cwd: "/repo/worktrees/vc-290",
      source: "Shell",
      closed: true,
    });
  });

  it("reports an empty working folder as unknown rather than as an empty path", () => {
    // A terminal attachment whose native detail no longer parses projects
    // `cwd: ""`. Printing that is a row that looks like a path and is not one.
    const detail = buildTerminalSessionDetail({
      record: record({ id: "s1", cwd: "" }),
      ticket: null,
      ticketPrefix: "VC",
    });

    expect(detail.cwd).toBeNull();
  });

  it("states what was not saved, in words nothing can mistake for missing data", () => {
    expect(TERMINAL_OUTPUT_NOT_SAVED).toBe("Terminal output was not saved.");
    expect(TERMINAL_LAST_COMMAND_NOT_RECORDED).toBe("Last command was not recorded.");
  });
});
