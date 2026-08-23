import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { parseTtlDaysInput, SettingsPage } from "./settings-page";

describe("SettingsPage (app-wide)", () => {
  it("lists the app-wide categories in the shell rail", () => {
    const html = renderToStaticMarkup(<SettingsPage />);

    expect(html).toContain("General");
    expect(html).toContain("Appearance");
    expect(html).toContain("Harness Runtimes");
    // The CLI install is silent and background (VC-52), so its host-level
    // detection lives app-wide; the pane may also read the selected project's
    // Git configuration without becoming a project setting.
    expect(html).toContain("CLI");
    // Orphan cleanup is app-wide (the sweep walks every project), so it lives
    // here rather than on the per-project Configure page.
    expect(html).toContain("Worktrees");
    // Bring-your-own web search (VC-31), beside Model Access rather than under
    // Harness Runtimes: it is an outside account, not a runtime.
    expect(html).toContain("Web");
  });

  it("opens the web pane on its one control, with nothing configured", () => {
    const html = renderToStaticMarkup(<SettingsPage initialCategoryKey="web" />);

    // The resting shape before the bridge answers — effects never run under
    // renderToStaticMarkup, so this is the pane's honest loading state rather
    // than a claim about a setting it has not read yet.
    expect(html).toContain("Web search");
    expect(html).toContain("Loading…");
    // And no key field, because a pane that has read nothing knows of no
    // provider that needs one.
    expect(html).not.toContain("API key");
  });

  // The pane's data arrives over the preload bridge in an effect, which never
  // runs under renderToStaticMarkup — so what this asserts is the resting
  // shape: both sections exist, detection opens in its checking state, and
  // doctor has honestly not run rather than pretending a result.
  it("can open directly on the CLI detection pane", () => {
    const html = renderToStaticMarkup(<SettingsPage initialCategoryKey="cli" />);

    expect(html).toContain("Command-line tool");
    expect(html).toContain("Checking…");
    expect(html).toContain("Doctor");
    expect(html).toContain("Run Doctor");
    expect(html).toContain("Not run yet.");
  });

  // Its app-wide scope is structural (it lives here, not on Configure) rather
  // than something the copy has to state — see the base-branch test below.
  it("shows the global retention window in the default General category", () => {
    const html = renderToStaticMarkup(<SettingsPage />);

    expect(html).toContain("Done worktree retention");
    expect(html).toContain('id="done-ttl-days"');
    // VC-113: the number now governs a deletion, so the row states what the
    // deletion takes and what it leaves — the question a retention setting has
    // to answer before anyone will trust it.
    expect(html).toContain("keeps the branch, its commits, and the ticket");
  });

  it("no longer hosts the project-scoped base branch field (moved to Configure)", () => {
    const html = renderToStaticMarkup(<SettingsPage />);

    expect(html).not.toContain("Default base branch");
  });

  it("can open directly on Harness Runtimes for a blocked chat", () => {
    const html = renderToStaticMarkup(<SettingsPage initialCategoryKey="harness" />);

    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Harness Runtimes");
    expect(html).not.toContain("Archive Done tickets after");
  });

  // The built-in half of the harness list is compiled in, so the category has
  // something to show before any preload call — which is also the only thing
  // keeping this suite renderable, since it runs with no `window` at all.
  it("selects a harness and details it without a preload bridge", () => {
    const html = renderToStaticMarkup(<SettingsPage initialCategoryKey="harness" />);

    expect(html).toContain("Claude Code");
    expect(html).toContain("OpenCode");
    // The first harness is detailed by default: its identity card, not a blank.
    expect(html).toContain("Command");
    expect(html).toContain("Built-in");
  });
});

describe("parseTtlDaysInput", () => {
  it("accepts a whole number of days at or above the 1-day minimum", () => {
    expect(parseTtlDaysInput("14")).toBe(14);
    expect(parseTtlDaysInput("1")).toBe(1);
    expect(parseTtlDaysInput("  30 ")).toBe(30);
  });

  it("floors a fractional entry to whole days via parseInt", () => {
    expect(parseTtlDaysInput("7.9")).toBe(7);
  });

  it("rejects zero, negatives, blanks, and non-numeric input", () => {
    expect(parseTtlDaysInput("0")).toBeNull();
    expect(parseTtlDaysInput("-3")).toBeNull();
    expect(parseTtlDaysInput("")).toBeNull();
    expect(parseTtlDaysInput("abc")).toBeNull();
  });
});
