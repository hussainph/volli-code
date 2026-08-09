import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { ChangeSetSnapshot, Ticket } from "@volli/shared";

import {
  TicketEnvironmentInspector,
  TicketEnvironmentInspectorContent,
  readTicketEnvironmentChangeSet,
  shouldRevalidateTicketEnvironment,
} from "./ticket-environment-inspector";

const ticket: Ticket = {
  id: "ticket-6",
  projectId: "project-1",
  ticketNumber: 6,
  title: "Inspector",
  body: "Read @docs/plan.md and @src/inspector.tsx.",
  status: "doing",
  priority: "medium",
  labels: [],
  usesWorktree: true,
  preferredHarnessId: "claude-code",
  order: 0,
  worktreePath: "/worktrees/VC-6-inspector",
  branch: "volli/VC-6-inspector",
  baseBranch: "main",
  prUrl: null,
  createdAt: 0,
  updatedAt: 0,
};

const changeSet: ChangeSetSnapshot = {
  baseRevision: "base",
  headRevision: "head",
  files: [],
  insertions: 8,
  deletions: 2,
  revision: "revision",
  truncated: false,
  totalCount: 3,
};

describe("TicketEnvironmentInspector", () => {
  it("revalidates a consulted inspector without turning it into a live dashboard", () => {
    expect(
      shouldRevalidateTicketEnvironment({ lastReadAt: null, now: 10_000, loading: false }),
    ).toBe(true);
    expect(
      shouldRevalidateTicketEnvironment({ lastReadAt: 8_000, now: 10_000, loading: false }),
    ).toBe(false);
    expect(shouldRevalidateTicketEnvironment({ lastReadAt: 0, now: 10_000, loading: true })).toBe(
      false,
    );
    expect(shouldRevalidateTicketEnvironment({ lastReadAt: 0, now: 10_000, loading: false })).toBe(
      true,
    );
  });

  it("turns a failed Change Set read into a retryable success without retaining the failure", async () => {
    const reads = [
      async () => ({ ok: false as const, error: "offline" }),
      async () => ({ ok: true as const, changeSet }),
    ];
    const first = await readTicketEnvironmentChangeSet(reads.shift()!);
    const second = await readTicketEnvironmentChangeSet(reads.shift()!);

    expect(first).toEqual({ error: "offline" });
    expect(second).toEqual({ changeSet });
  });

  it("pins existing Environment and Sources facts as deliberate rail navigation", () => {
    const html = renderToStaticMarkup(
      <TicketEnvironmentInspector
        ticket={ticket}
        changeSet={changeSet}
        onNavigate={() => undefined}
      />,
    );

    expect(html).toContain("Environment");
    expect(html).toContain("Sources");
    expect(html).toContain("3 files · +8 −2");
    expect(html).toContain("volli/VC-6-inspector · main");
    expect(html).toContain("plan.md");
    expect(html).toContain("inspector.tsx");
    expect(html).toContain('data-testid="ticket-environment-destination-changes"');
    expect(html).toContain('data-testid="ticket-environment-destination-properties"');
    expect(html).toContain('data-testid="ticket-environment-destination-files"');
  });

  it("renders a recoverable Change Set failure and keeps long Sources legible in every theme", () => {
    const html = renderToStaticMarkup(
      <TicketEnvironmentInspectorContent
        ticket={{
          ...ticket,
          body: "Read @docs/a-very-long-inspector-reference-that-must-truncate.md @src/a-second-long-source.ts @src/third.ts @src/fourth.ts.",
        }}
        changeSetError="offline"
        onNavigate={() => undefined}
        onRetry={() => undefined}
      />,
    );

    expect(html).toContain("Changes unavailable");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Couldn’t load changes: offline");
    expect(html).toContain('title="offline"');
    expect(html).toContain("Retry");
    expect(html).toContain("View all");
    expect(html).toContain("min-w-0 flex-1 truncate");
    expect(html).toContain("motion-reduce:transition-none");
    expect(html).toContain("border-sidebar-border");
    expect(html).toContain("text-foreground");
    expect(html).not.toContain("bg-[#");
  });

  it("omits the inspector instead of inventing empty Environment or Sources state", () => {
    const html = renderToStaticMarkup(
      <TicketEnvironmentInspectorContent
        ticket={{ ...ticket, body: "", worktreePath: null, branch: null, baseBranch: null }}
        onNavigate={() => undefined}
        onRetry={() => undefined}
      />,
    );

    expect(html).toBe("");
  });
});
