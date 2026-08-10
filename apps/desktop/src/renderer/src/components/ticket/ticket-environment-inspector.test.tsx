import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { ChangeSetSnapshot, Ticket } from "@volli/shared";

import {
  TicketEnvironmentInspector,
  TicketEnvironmentInspectorContent,
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
  it("pins existing Environment and Sources facts as deliberate rail navigation", () => {
    const html = renderToStaticMarkup(
      <TicketEnvironmentInspector
        ticket={ticket}
        changeSet={changeSet}
        onNavigate={() => undefined}
        onOpenSource={() => undefined}
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
  });

  it("gives each Sources row its own file, so a reference never resolves to the whole list", () => {
    const html = renderToStaticMarkup(
      <TicketEnvironmentInspectorContent
        ticket={ticket}
        changeSet={changeSet}
        onNavigate={() => undefined}
        onOpenSource={() => undefined}
        onRetry={() => undefined}
      />,
    );

    expect(html).toContain('data-rel-path="docs/plan.md"');
    expect(html).toContain('data-rel-path="src/inspector.tsx"');
    // "View all" is the only control that routes to the list, and only when
    // rows are actually hidden — two rows fit, so it must be absent here.
    expect(html).not.toContain("View all");
    expect(html).not.toContain('data-testid="ticket-environment-destination-files"');
  });

  it("keeps the last good counts on screen when a re-read fails, and offers one recovery", () => {
    const html = renderToStaticMarkup(
      <TicketEnvironmentInspectorContent
        ticket={ticket}
        changeSet={changeSet}
        changeSetError="offline"
        onNavigate={() => undefined}
        onOpenSource={() => undefined}
        onRetry={() => undefined}
      />,
    );

    expect(html).toContain("3 files · +8 −2");
    expect(html).toContain("Changes may be out of date: offline");
    expect(html).not.toContain("Couldn’t load changes");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Retry");
  });

  it("renders a first-read failure once, and keeps long Sources legible in every theme", () => {
    const html = renderToStaticMarkup(
      <TicketEnvironmentInspectorContent
        ticket={{
          ...ticket,
          body: "Read @docs/a-very-long-inspector-reference-that-must-truncate.md @src/a-second-long-source.ts @src/third.ts @src/fourth.ts.",
        }}
        changeSetError="offline"
        onNavigate={() => undefined}
        onOpenSource={() => undefined}
        onRetry={() => undefined}
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Couldn’t load changes: offline");
    // The failure is stated once: no counts row restating it in other words.
    expect(html).not.toContain("Changes unavailable");
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
        onOpenSource={() => undefined}
        onRetry={() => undefined}
      />,
    );

    expect(html).toBe("");
  });
});
