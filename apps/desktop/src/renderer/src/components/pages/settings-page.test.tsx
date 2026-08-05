import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { parseTtlDaysInput, SettingsPage } from "./settings-page";

describe("SettingsPage (app-wide)", () => {
  it("lists the app-wide categories in the shell rail", () => {
    const html = renderToStaticMarkup(<SettingsPage />);

    expect(html).toContain("General");
    expect(html).toContain("Appearance");
    expect(html).toContain("Harness Runtimes");
    // Orphan cleanup is app-wide (the sweep walks every project), so it lives
    // here rather than on the per-project Configure page.
    expect(html).toContain("Worktrees");
  });

  // Its app-wide scope is structural (it lives here, not on Configure) rather
  // than something the copy has to state — see the base-branch test below.
  it("shows the global Done-TTL in the default General category", () => {
    const html = renderToStaticMarkup(<SettingsPage />);

    expect(html).toContain("Archive Done tickets after");
    expect(html).toContain('id="done-ttl-days"');
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
