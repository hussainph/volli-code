import type { Project } from "@volli/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { configureGroups } from "@renderer/components/settings/configure-groups";
import { PrefShell, type PrefCategory } from "@renderer/components/settings/kit";
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

/** The section titles one category draws, off the marker the rail audit reads. */
function sectionTitles(activeKey: string): string[] {
  return (
    [...renderConfigure(activeKey).matchAll(/data-slot="pref-section-title"[^>]*>([^<]*)</g)]
      .map((match) => (match[1] ?? "").trim())
      // The audit's own window: shorter is noise, longer is data rather than
      // vocabulary someone would half-remember and search for.
      .filter((title) => title.length >= 4 && title.length <= 40)
  );
}

/** Every category the rail draws, in rail order, groups flattened away. */
function allCategories(): readonly PrefCategory[] {
  return configureGroups(project).flatMap((group) => group.categories);
}

/** One category by key, or `undefined` when the rail no longer declares it. */
function categoryFor(key: string): PrefCategory | undefined {
  return allCategories().find((category) => category.key === key);
}

/** Everything the rail's search index holds for one category. */
function searchTermsFor(category: PrefCategory): readonly string[] {
  return [category.label, ...(category.keywords ?? [])];
}

function keywordsFor(key: string): readonly string[] {
  const category = categoryFor(key);
  if (category === undefined) throw new Error(`no configure category ${key}`);
  return searchTermsFor(category);
}

/**
 * Which categories the rail would offer for a typed query.
 *
 * The shell's rule, re-stated: a lowercased SUBSTRING of a stored term, where
 * the stored terms are the label plus the keywords (`kit/pref-shell.tsx`,
 * the `matches` memo). Mirrored rather than imported because that predicate
 * lives inside a `useMemo` with no seam — and because `PrefShell` never
 * renders `keywords` into the DOM at all, so an assertion on rendered HTML is
 * blind to the half of the index a person actually types against.
 */
function railSearch(query: string): readonly string[] {
  const needle = query.trim().toLowerCase();
  return allCategories()
    .filter((category) =>
      searchTermsFor(category).some((term) => term.toLowerCase().includes(needle)),
    )
    .map((category) => category.key);
}

/**
 * The rail's search index against the panes it indexes.
 *
 * A section a person can SEE and cannot FIND is a section that may as well not
 * be there, and the e2e audit that catches it (`settings-search-smoke.mjs`,
 * "every visible label finds this page") is a sharded smoke that costs minutes
 * — and only noticed the MCP pane's "Add server" after it had already shipped
 * to CI. This is the same rule stated where it costs milliseconds.
 */
describe("the Configure rail's search index", () => {
  it.each(["skills", "commands", "mcp", "authority", "sessions", "worktrees"])(
    "finds the %s pane from every section title it draws",
    (key) => {
      // The rail matches a lowercased substring, so the stored terms are
      // compared the same way the shell compares them.
      const terms = keywordsFor(key).map((term) => term.toLowerCase());
      const titles = sectionTitles(key);

      expect(titles.length).toBeGreaterThan(0);
      for (const title of titles) {
        expect(
          terms.some((term) => term.includes(title.toLowerCase())),
          `"${title}" is drawn in Configure → ${key} but nothing in the rail finds it`,
        ).toBe(true);
      }
    },
  );
});

describe("Configure rail", () => {
  it("groups agent configuration apart from project settings", () => {
    const html = renderConfigure("skills");

    // The count is in the module header of `configure-groups.tsx` ("two
    // groups, seven categories"), and that line spent a ticket being wrong
    // while nothing failed. Pin it here: a category added or removed should
    // make someone reread the sentence that describes the rail.
    expect(allCategories()).toHaveLength(7);
    expect(html).toContain("Agent");
    expect(html).toContain("Project");
    for (const category of [
      "Skills",
      "Commands",
      "MCP Servers",
      "Sessions",
      "Appearance",
      "Worktrees",
    ]) {
      expect(html).toContain(category);
    }
  });

  /**
   * The entry, its keywords and its pane left together (VC-378) and only
   * VC-379 — real Agent Plugins support — brings them back.
   *
   * THE KEY CHECK IS THE NARROW ONE: it catches the category returning as it
   * was. The vocabulary check is the one that matters, because the rail's
   * search index is not drawn into the DOM — "plugin" restored as a keyword
   * on some neighbouring category is invisible to any assertion on rendered
   * HTML, and would put every retired search term back in a person's hands
   * with no pane behind it. Both halves of the index are checked the way the
   * shell reads them.
   */
  it("keeps the retired Plugins vocabulary out of the rail and its search index", () => {
    expect(categoryFor("plugins")).toBeUndefined();

    // The four terms VC-378 named, plus the label itself. Each must find
    // nothing: a search that lands on a pane which cannot be about plugins is
    // worse than a search that lands nowhere.
    for (const query of ["plugin", "plugins", "installed plugins", "bundle", "marketplace"]) {
      expect(railSearch(query), `rail search for "${query}" should find nothing`).toEqual([]);
    }

    // And the drawn rail, for the label a person can actually read.
    expect(renderConfigure("skills")).not.toContain("Plugins");
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
    // `scanOrphans` walks every project in the db and reports directories git
    // attributes to none of them, so its list — and its permanent deletes —
    // cannot be scoped here. Settings → Storage owns it.
    expect(html).not.toContain("Orphaned worktrees");
  });
});

describe("Configure → Sessions", () => {
  it("offers the Chat model default without an inert Harness setting or scope switch", () => {
    const html = renderConfigure("sessions");

    expect(html).toContain("Chat");
    expect(html).toContain("Model");
    expect(html).not.toContain("Harness");
    expect(html).not.toContain("Terminal companion");
    expect(html).not.toContain("New sessions");
    // Scope is the surface, not a mode: an Inherit/Custom pair per row is the
    // exact vocabulary this redesign removed (see kit/override.tsx).
    expect(html).not.toContain("Inherit");
  });

  it("indexes the visible Chat section and retires the removed Harness vocabulary", () => {
    const category = categoryFor("sessions");

    expect(category?.keywords).toContain("chat");
    expect(category?.keywords).not.toContain("harness");
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
  it("opens on the servers it has, with the editor summoned rather than standing open", () => {
    const html = renderConfigure("mcp");

    expect(html).not.toContain("aren&#x27;t available yet");
    expect(html).not.toContain("inert");
    expect(html).toContain("No MCP servers yet.");
    expect(html).toContain("Add server");
    expect(html).not.toContain("Shell command");
    // The one line the pane says without being asked: a trust boundary the
    // controls cannot show. Everything else about MCP is a summoned hint.
    expect(html).toContain("A local MCP command runs as you");
    // The form is a REQUEST now (VC-397): an always-open editor under a
    // catalog of 34 tools is what made this page unreadable. The transports it
    // offers are asserted where a click can open it — `mcp-pane.test.tsx`.
    expect(html).not.toContain("Arguments (one per line)");
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
