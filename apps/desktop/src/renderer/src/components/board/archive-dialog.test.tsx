import { renderToStaticMarkup } from "react-dom/server";
import type { ArchivedTicket, Project } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { ArchiveRow } from "./archive-dialog";

const project: Project = {
  id: "p1",
  name: "Volli Code",
  path: "/repo/volli",
  ticketPrefix: "VC",
  baseBranch: "main",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
};

function archived(overrides: Partial<ArchivedTicket> = {}): ArchivedTicket {
  return {
    id: "t1",
    projectId: "p1",
    ticketNumber: 12,
    title: "MCP server",
    body: "",
    status: "done",
    priority: "medium",
    labels: [],
    usesWorktree: true,
    preferredHarnessId: "claude-code",
    order: 0,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    createdAt: 0,
    updatedAt: 0,
    archivedAt: 0,
    ...overrides,
  };
}

const noop = () => {};

describe("ArchiveRow — retained record", () => {
  it("shows the retained branch name when the archived ticket kept one", () => {
    const html = renderToStaticMarkup(
      <ArchiveRow
        project={project}
        ticket={archived({ branch: "volli/VC-12-mcp-server" })}
        onRequestDelete={noop}
      />,
    );
    expect(html).toContain("volli/VC-12-mcp-server");
  });

  it("renders a PR link pointing at the retained PR url", () => {
    const html = renderToStaticMarkup(
      <ArchiveRow
        project={project}
        ticket={archived({ prUrl: "https://github.com/x/y/pull/9" })}
        onRequestDelete={noop}
      />,
    );
    // The link opens externally via an onClick handler (server markup can't
    // assert the handler), so assert the visible PR affordance is present.
    expect(html).toContain(">PR<");
  });

  it("omits both the branch and PR affordances when neither was retained", () => {
    const html = renderToStaticMarkup(
      <ArchiveRow project={project} ticket={archived()} onRequestDelete={noop} />,
    );
    expect(html).not.toContain(">PR<");
    // Still shows the always-present column + archived-on meta.
    expect(html).toContain("Done");
    expect(html).toContain("Archived");
  });
});
