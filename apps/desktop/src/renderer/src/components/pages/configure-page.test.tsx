import type { Project } from "@volli/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { configureGroups } from "@renderer/components/settings/configure-groups";
import { PrefShell } from "@renderer/components/settings/kit";
import { ConfigurePage } from "./configure-page";

const project: Project = {
  id: "p1",
  name: "Volli Code",
  path: "/repo/volli",
  ticketPrefix: "VC",
  baseBranch: "trunk",
  setupCommand: "pnpm install",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
};

/** The surface as it draws for one project, without the store's selection. */
function renderConfigure(activeKey: string): string {
  return renderToStaticMarkup(
    <PrefShell
      surfaceLabel="Configure"
      groups={configureGroups(project)}
      activeKey={activeKey}
      onSelect={() => {}}
    />,
  );
}

describe("Configure rail", () => {
  it("groups agent configuration apart from project settings", () => {
    const html = renderConfigure("skills");

    expect(html).toContain("Agent");
    expect(html).toContain("Project");
    for (const category of [
      "Skills",
      "Commands",
      "MCP Servers",
      "Plugins",
      "Sessions",
      "Appearance",
      "Worktrees",
    ]) {
      expect(html).toContain(category);
    }
  });
});

describe("Configure → Worktrees", () => {
  it("carries the project's pinned base branch and setup command", () => {
    const html = renderConfigure("worktrees");

    expect(html).toContain("Branch from");
    expect(html).toContain('value="trunk"');
    expect(html).toContain("Then run");
    expect(html).toContain('value="pnpm install"');
  });

  it("keeps the app-wide orphan list off a single project's page", () => {
    const html = renderConfigure("worktrees");

    expect(html).toContain("Copied files");
    expect(html).toContain(".worktreeinclude");
    // `sweepOrphans` walks every project in the db and reports directories git
    // attributes to none of them, so its list — and its permanent deletes —
    // cannot be scoped here. Settings → Storage owns it.
    expect(html).not.toContain("Orphaned worktrees");
  });
});

describe("Configure → Sessions", () => {
  it("offers the harness choice without a scope switch", () => {
    const html = renderConfigure("sessions");

    expect(html).toContain("Harness");
    expect(html).toContain("New sessions");
    // Scope is the surface, not a mode: an Inherit/Custom pair per row is the
    // exact vocabulary this redesign removed (see kit/override.tsx).
    expect(html).not.toContain("Inherit");
  });

  it("keeps a disabled model picker visible while its catalogue loads", () => {
    const html = renderConfigure("sessions");
    const modelRow = html.slice(html.indexOf('data-testid="project-session-model"'));

    expect(modelRow).toContain('id="project-session-model"');
    expect(modelRow).toContain("Loading models");
    expect(modelRow).toContain("disabled");
    expect(modelRow).toContain('aria-label="Reasoning level"');
  });
});

describe("Configure → MCP", () => {
  it("shows the shape and says it does not work yet", () => {
    const html = renderConfigure("mcp");

    expect(html).toContain("aren&#x27;t wired up yet");
    // Rule 3 of kit/unavailable.tsx: the real empty state, never invented
    // servers that a reader could mistake for real ones gone wrong.
    expect(html).toContain("No MCP servers yet.");
    expect(html).toContain("inert");
  });
});

describe("ConfigurePage", () => {
  it("renders a graceful empty state when no project is selected", () => {
    // The projects-store singleton starts with no selection, so the page
    // resolves to null and shows the empty state instead of the shell.
    const html = renderToStaticMarkup(<ConfigurePage />);

    expect(html).toContain("Nothing to configure");
    expect(html).not.toContain("Branch from");
  });
});
