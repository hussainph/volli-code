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

  it("shows the global Done-TTL in the default General category, scoped to all projects", () => {
    const html = renderToStaticMarkup(<SettingsPage />);

    expect(html).toContain("Archive Done tickets after");
    expect(html).toContain('id="done-ttl-days"');
    expect(html).toContain("every project");
  });

  it("no longer hosts the project-scoped base branch field (moved to Configure)", () => {
    const html = renderToStaticMarkup(<SettingsPage />);

    expect(html).not.toContain("Default base branch");
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
