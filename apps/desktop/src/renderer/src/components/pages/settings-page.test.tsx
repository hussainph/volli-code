import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { parseTtlDaysInput, ProjectAutomationSettings } from "./settings-page";

describe("SettingsPage", () => {
  it("shows the selected project's pinned base branch in one editable field", () => {
    const html = renderToStaticMarkup(
      <ProjectAutomationSettings
        project={{
          id: "p1",
          name: "Volli Code",
          path: "/repo/volli",
          ticketPrefix: "VC",
          baseBranch: "trunk",
          colorIndex: 0,
          sortOrder: 0,
          createdAt: 0,
          updatedAt: 0,
        }}
        onSave={async () => true}
      />,
    );

    expect(html).toContain("Default base branch");
    expect(html).toContain('value="trunk"');
    expect(html).toContain("Save");
  });

  it("renders the global Done-TTL field in the Worktrees section", () => {
    const html = renderToStaticMarkup(
      <ProjectAutomationSettings project={null} onSave={async () => true} />,
    );
    expect(html).toContain("Archive Done tickets after");
    expect(html).toContain('id="done-ttl-days"');
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
