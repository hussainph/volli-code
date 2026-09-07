import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { SessionRecord, Ticket } from "@volli/shared";

import { buildTerminalSessionDetail } from "./session-detail-model";
import {
  SessionDetailLoadFailed,
  SessionDetailPanel,
  SessionDetailPending,
  SessionDetailUnknown,
} from "./session-detail-panel";

const noop = (): void => {};

function record(overrides: Partial<SessionRecord> & { id: string }): SessionRecord {
  return {
    id: overrides.id,
    projectId: "p1",
    ticketId: overrides.ticketId ?? null,
    harnessId: "claude-code",
    activeHarnessId: null,
    harnessSessionId: null,
    launchKind: overrides.launchKind ?? "agent",
    placement: "tab",
    title: overrides.title ?? "Session 2",
    cwd: overrides.cwd ?? "/repo/worktrees/vc-290",
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
    endedAt: overrides.endedAt === undefined ? 1_700_000_600_000 : overrides.endedAt,
    exitCode: overrides.exitCode ?? null,
    lastActivityAt: 1_700_000_600_000,
    bornTicketless: overrides.bornTicketless ?? (overrides.ticketId ?? null) === null,
  };
}

function ticket(overrides: Partial<Ticket> & { id: string }): Ticket {
  return {
    id: overrides.id,
    projectId: "p1",
    ticketNumber: 290,
    title: "Closed terminal history",
    body: "",
    status: "doing",
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

function panel(
  input: Parameters<typeof buildTerminalSessionDetail>[0],
  options: { resumable?: boolean; busy?: boolean } = {},
): string {
  return renderToStaticMarkup(
    <SessionDetailPanel
      detail={buildTerminalSessionDetail(input)}
      resumable={options.resumable ?? false}
      busy={options.busy ?? false}
      onNewTerminal={noop}
      onResume={noop}
    />,
  );
}

describe("SessionDetailPanel", () => {
  it("names the Session and the ticket it ran on", () => {
    const html = panel({
      record: record({ id: "s1", ticketId: "t1", title: "Session 2" }),
      ticket: ticket({ id: "t1" }),
      ticketPrefix: "VC",
    });

    expect(html).toContain("Session 2");
    expect(html).toContain("VC-290 · Closed terminal history");
  });

  it("says what was not saved, rather than showing an empty terminal", () => {
    const html = panel({ record: record({ id: "s1" }), ticket: null, ticketPrefix: "VC" });

    expect(html).toContain("Terminal output was not saved.");
    expect(html).toContain("Last command was not recorded.");
  });

  it("prints exit code 0 for a clean exit and the exact code for a failure", () => {
    expect(
      panel({ record: record({ id: "s1", exitCode: 0 }), ticket: null, ticketPrefix: "VC" }),
    ).toContain("Exit code 0");
    expect(
      panel({ record: record({ id: "s1", exitCode: 137 }), ticket: null, ticketPrefix: "VC" }),
    ).toContain("Exit code 137");
  });

  it("says the exit status is unavailable rather than implying success", () => {
    const html = panel({
      record: record({ id: "s1", exitCode: null }),
      ticket: null,
      ticketPrefix: "VC",
    });

    expect(html).toContain("Exit status unavailable");
    expect(html).not.toContain("Exit code");
  });

  it("shows the working folder when the record carries one, and no row when it does not", () => {
    expect(
      panel({
        record: record({ id: "s1", cwd: "/repo/worktrees/vc-290" }),
        ticket: null,
        ticketPrefix: "VC",
      }),
    ).toContain("/repo/worktrees/vc-290");
    expect(
      panel({ record: record({ id: "s1", cwd: "" }), ticket: null, ticketPrefix: "VC" }),
    ).not.toContain("Folder");
  });

  it("offers a new terminal in the same scope, named as a new one", () => {
    const html = panel({
      record: record({ id: "s1", ticketId: "t1" }),
      ticket: ticket({ id: "t1" }),
      ticketPrefix: "VC",
    });

    expect(html).toContain("New terminal here");
    // Nothing on this panel may suggest the closed process comes back.
    expect(html).not.toContain("Reopen");
  });

  it("offers nothing to create when the scope it ran in is gone", () => {
    const html = panel({
      record: record({ id: "s1", ticketId: "t1" }),
      ticket: null,
      ticketPrefix: "VC",
    });

    expect(html).toContain("Ticket unavailable");
    expect(html).not.toContain("New terminal here");
  });

  // Resume is a different act with a different promise: it hands an agent its
  // own history back. It is shown only where the harness check allows it, and
  // it never stands in for creating a new terminal.
  it("keeps Resume session beside New terminal here, never instead of it", () => {
    const resumable = panel(
      {
        record: record({ id: "s1", ticketId: "t1" }),
        ticket: ticket({ id: "t1" }),
        ticketPrefix: "VC",
      },
      { resumable: true },
    );

    expect(resumable).toContain("Resume session");
    expect(resumable).toContain("New terminal here");

    const plain = panel({
      record: record({ id: "s1", ticketId: "t1" }),
      ticket: ticket({ id: "t1" }),
      ticketPrefix: "VC",
    });
    expect(plain).not.toContain("Resume session");
  });

  it("goes quiet while a Session it started is coming up", () => {
    const html = panel(
      {
        record: record({ id: "s1", ticketId: "t1" }),
        ticket: ticket({ id: "t1" }),
        ticketPrefix: "VC",
      },
      { resumable: true, busy: true },
    );

    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });

  it("says a project session is one, with no ticket invented for it", () => {
    const html = panel({
      record: record({ id: "s1", ticketId: null, bornTicketless: true }),
      ticket: null,
      ticketPrefix: "VC",
    });

    expect(html).toContain("Project session");
    expect(html).toContain("New terminal here");
  });
});

describe("Session detail resolution states", () => {
  // The one thing the old behaviour could never say. A record this window
  // cannot find is named as missing — not answered with a different tab.
  it("says the record could not be found instead of opening something else", () => {
    const html = renderToStaticMarkup(<SessionDetailUnknown />);

    expect(html).toContain("This session’s record could not be found.");
  });

  // "Not read yet" is not "gone" — the same distinction Home's tab restore
  // draws about a persisted Session id.
  it("does not call a listing that has not answered yet a missing record", () => {
    const html = renderToStaticMarkup(<SessionDetailPending />);

    expect(html).toContain("Loading this session’s record…");
    expect(html).not.toContain("could not be found");
  });

  it("does not leave a settled read failure looking like an in-flight request", () => {
    const html = renderToStaticMarkup(<SessionDetailLoadFailed onRetry={noop} />);

    expect(html).toContain("This session’s record could not be loaded.");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Loading");
    expect(html).not.toContain("could not be found");
  });
});
