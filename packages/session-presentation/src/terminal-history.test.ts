import { describe, expect, it } from "vite-plus/test";
import { getHarnessAdapter, type HarnessAdapter, type HarnessId } from "@volli/shared";
import type { SessionRecord } from "@volli/shared";

import {
  buildTerminalHistoryDetail,
  canResumeTerminalRecord,
  TERMINAL_LAST_COMMAND_NOT_RECORDED,
  TERMINAL_OUTPUT_NOT_SAVED,
  type TerminalHistoryTicket,
} from "./terminal-history";

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

function ticket(overrides: Partial<TerminalHistoryTicket> = {}): TerminalHistoryTicket {
  return {
    id: overrides.id ?? "t1",
    ticketNumber: overrides.ticketNumber ?? 290,
    title: overrides.title ?? "Closed terminal history",
  };
}

/** The built-ins, which is what these cases are about — the lookup is a parameter. */
const detail = (
  input: Partial<Parameters<typeof buildTerminalHistoryDetail>[0]> & { record: SessionRecord },
) =>
  buildTerminalHistoryDetail({
    ticket: null,
    ticketPrefix: "VC",
    harnesses: getHarnessAdapter,
    ...input,
  });

describe("buildTerminalHistoryDetail scope", () => {
  it("names the ticket a ticket Session belongs to", () => {
    const view = detail({ record: record({ id: "s1", ticketId: "t1" }), ticket: ticket() });

    expect(view.scope).toEqual({
      kind: "ticket",
      ticketId: "t1",
      displayId: "VC-290",
      title: "Closed terminal history",
    });
    expect(view.scopeLabel).toBe("VC-290 · Closed terminal history");
  });

  it("calls a Session born without a ticket a project session", () => {
    const view = detail({
      record: record({ id: "s1", ticketId: null, bornTicketless: true }),
      ticket: null,
    });

    expect(view.scope).toEqual({ kind: "project" });
    expect(view.scopeLabel).toBe("Project session");
  });

  // A record naming a ticket the board no longer holds.
  it("says the ticket is unavailable rather than borrowing the project's name", () => {
    const view = detail({ record: record({ id: "s1", ticketId: "gone" }), ticket: null });

    expect(view.scope).toEqual({ kind: "unavailable" });
    expect(view.scopeLabel).toBe("Ticket unavailable");
  });

  // `sessions.ticket_id` is ON DELETE SET NULL, so a deleted ticket orphans its
  // Sessions into `ticketId: null`. Only `bornTicketless` tells that orphan from
  // a Board Session, and reading it as a project session would quietly promote
  // a Ticket Session's history into the project's.
  it("does not mistake an orphaned ticket Session for a project one", () => {
    const view = detail({
      record: record({ id: "s1", ticketId: null, bornTicketless: false }),
      ticket: null,
    });

    expect(view.scope).toEqual({ kind: "unavailable" });
    expect(view.scopeLabel).toBe("Ticket unavailable");
  });
});

describe("buildTerminalHistoryDetail exit", () => {
  it("reports a clean exit as code 0, never as an absence", () => {
    const view = detail({ record: record({ id: "s1", endedAt: 2_000, exitCode: 0 }) });

    expect(view.exit).toEqual({ kind: "code", code: 0 });
    expect(view.exitLabel).toBe("Exit code 0");
  });

  it("reports a failing exit with its exact code", () => {
    const view = detail({ record: record({ id: "s1", endedAt: 2_000, exitCode: 137 }) });

    expect(view.exit).toEqual({ kind: "code", code: 137 });
    expect(view.exitLabel).toBe("Exit code 137");
  });

  // The relaunch sweep and every record written before the exit became a
  // durable Session fact land here. Reading either as success would report a
  // clean finish for a process nothing observed.
  it("says the exit status is unavailable when nothing observed one", () => {
    const view = detail({ record: record({ id: "s1", endedAt: 2_000, exitCode: null }) });

    expect(view.exit).toEqual({ kind: "unavailable" });
    expect(view.exitLabel).toBe("Exit status unavailable");
  });

  it("says a record whose attachment is still open is running", () => {
    const view = detail({ record: record({ id: "s1", endedAt: null }) });

    expect(view.exit).toEqual({ kind: "running" });
    expect(view.exitLabel).toBe("Still running");
    expect(view.closed).toBe(false);
  });
});

describe("buildTerminalHistoryDetail record", () => {
  it("says the identity, times and folder the record actually carries", () => {
    const view = detail({
      record: record({
        id: "s1",
        ticketId: "t1",
        title: "Session 4",
        launchKind: "shell",
        createdAt: 1_000,
        endedAt: 2_000,
        cwd: "/repo/worktrees/vc-290",
      }),
      ticket: ticket(),
    });

    expect(view).toMatchObject({
      sessionId: "s1",
      projectId: "p1",
      title: "Session 4",
      source: "Shell",
      startedAt: 1_000,
      endedAt: 2_000,
      closed: true,
      cwd: "/repo/worktrees/vc-290",
    });
  });

  // An unreadable native detail projects `cwd: ""`, and an empty string drawn
  // in a path row reads as the filesystem root.
  it("has no folder rather than an empty one", () => {
    expect(detail({ record: record({ id: "s1", cwd: "" }) }).cwd).toBeNull();
  });

  it("states both absences in full, as the record's own contents", () => {
    expect(TERMINAL_OUTPUT_NOT_SAVED).toBe("Terminal output was not saved.");
    expect(TERMINAL_LAST_COMMAND_NOT_RECORDED).toBe("Last command was not recorded.");
  });
});

/**
 * The affordance half of the surface model: which controls are meaningful for
 * this record. Decided here so desktop, mobile and a future web client cannot
 * disagree about whether a closed terminal can be recreated or resumed.
 */
describe("buildTerminalHistoryDetail actions", () => {
  it("offers a fresh terminal in the ticket a ticket Session belongs to", () => {
    const view = detail({ record: record({ id: "s1", ticketId: "t1" }), ticket: ticket() });

    expect(view.actions.recreate).toEqual({ kind: "ticket", ticketId: "t1" });
  });

  it("offers a fresh terminal in the project for a Board Session", () => {
    const view = detail({ record: record({ id: "s1", ticketId: null, bornTicketless: true }) });

    expect(view.actions.recreate).toEqual({ kind: "project" });
  });

  // There is no "here" left. Starting a project terminal instead would be a
  // different scope wearing the closed Session's name — the substitution this
  // whole ticket is about.
  it("offers no recreation when the scope the Session ran in is gone", () => {
    expect(detail({ record: record({ id: "s1", ticketId: "gone" }) }).actions.recreate).toBeNull();
    expect(
      detail({ record: record({ id: "s1", ticketId: null, bornTicketless: false }) }).actions
        .recreate,
    ).toBeNull();
  });

  it("offers resume for an ended ticket agent session its harness can resume", () => {
    const view = detail({
      record: record({ id: "s1", ticketId: "t1", launchKind: "agent", harnessId: "claude-code" }),
      ticket: ticket(),
    });

    expect(view.actions.resume).toEqual({ ticketId: "t1" });
    // Never instead of the other verb: recreation is a new execution and resume
    // hands an agent its own history back.
    expect(view.actions.recreate).toEqual({ kind: "ticket", ticketId: "t1" });
  });

  it("offers no resume for a bare shell, a live session, or an unknown harness", () => {
    const base = { id: "s1", ticketId: "t1" } as const;
    const withTicket = (overrides: Partial<SessionRecord>) =>
      detail({ record: record({ ...base, ...overrides }), ticket: ticket() }).actions.resume;

    expect(withTicket({ launchKind: "shell" })).toBeNull();
    expect(withTicket({ endedAt: null })).toBeNull();
    expect(withTicket({ harnessId: "my-custom-harness" as HarnessId })).toBeNull();
  });

  // Resume runs inside the ticket's worktree, so a Session with no ticket scope
  // has nowhere to resume into even when its harness could.
  it("offers no resume to a project session or one whose ticket is gone", () => {
    expect(
      detail({ record: record({ id: "s1", ticketId: null, bornTicketless: true }) }).actions.resume,
    ).toBeNull();
    expect(detail({ record: record({ id: "s1", ticketId: "gone" }) }).actions.resume).toBeNull();
  });

  // The whole reason the lookup is a parameter: a registered manifest that
  // declares a resume line can genuinely be resumed, and a built-ins-only
  // answer would deny the affordance while claiming the harness has none.
  it("offers resume for a BYO harness the caller's catalogue can describe", () => {
    const byo = "my-custom-harness" as HarnessId;
    const knows = (id: HarnessId): HarnessAdapter | undefined =>
      id === byo
        ? {
            ...getHarnessAdapter("claude-code")!,
            id: byo,
            resume: { byId: null, latest: ["--continue"], userResumeTokens: [] },
          }
        : getHarnessAdapter(id);

    const ended = record({ id: "s1", ticketId: "t1", launchKind: "agent", harnessId: byo });
    expect(
      buildTerminalHistoryDetail({
        record: ended,
        ticket: ticket(),
        ticketPrefix: "VC",
        harnesses: knows,
      }).actions.resume,
    ).toEqual({ ticketId: "t1" });
    expect(detail({ record: ended, ticket: ticket() }).actions.resume).toBeNull();
  });
});

/**
 * The resume rule itself, named once here so the sidebar, the ticket rail and
 * this detail cannot drift into three answers about the same record.
 */
describe("canResumeTerminalRecord", () => {
  const resumable = (overrides: Partial<SessionRecord>) =>
    canResumeTerminalRecord(record({ id: "s1", ...overrides }), getHarnessAdapter);

  it("is false for a still-live agent session — nothing has ended to resume into", () => {
    expect(resumable({ launchKind: "agent", endedAt: null })).toBe(false);
  });

  it("is false for a bare shell, whether live or ended", () => {
    expect(resumable({ launchKind: "shell", endedAt: null })).toBe(false);
    expect(resumable({ launchKind: "shell", endedAt: 10 })).toBe(false);
  });

  it("is true for an ended Claude Code agent session", () => {
    expect(
      resumable({
        launchKind: "agent",
        endedAt: 10,
        harnessId: "claude-code",
        harnessSessionId: null,
      }),
    ).toBe(true);
  });

  // Main builds the resume line off the running harness, so the affordance has
  // to be decided about that one or a surface offers a Resume that cannot
  // happen — and hides one that can.
  it("judges resumability by the harness that was running when it ended", () => {
    expect(
      resumable({
        launchKind: "agent",
        endedAt: 10,
        harnessId: "my-custom-harness" as HarnessId,
        activeHarnessId: "claude-code",
      }),
    ).toBe(true);
    expect(
      resumable({
        launchKind: "agent",
        endedAt: 10,
        harnessId: "claude-code",
        activeHarnessId: "my-custom-harness" as HarnessId,
      }),
    ).toBe(false);
  });
});
