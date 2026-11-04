// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { resolveExperiments, type Project } from "@volli/shared";
import { SettingsPage } from "@renderer/components/pages/settings-page";
import { ConfigurePage } from "@renderer/components/pages/configure-page";
import { useProjectsStore } from "@renderer/stores/projects";
import { settingsGroups } from "./settings-groups";
import { configureGroups } from "./configure-groups";
import { settingsSearch } from "./kit/pref-shell";
import { SETTINGS_ROWS } from "./settings-inventory";
const project: Project = {
  id: "p1",
  name: "First project",
  path: "/repo/one",
  ticketPrefix: "ONE",
  baseBranch: "main",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
};
afterEach(() => {
  useProjectsStore.setState({ projects: [], selectedProjectId: null });
  vi.unstubAllGlobals();
});
it("switches App and project scopes and picks a project without retargeting the workspace", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollTo = vi.fn();
  useProjectsStore.setState({
    projects: [project, { ...project, id: "p2", name: "Second project" }],
    selectedProjectId: "p1",
  });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    act(() => root.render(<SettingsPage initialCategoryKey="general" />));
    expect(host.querySelector('[aria-current="page"]')!.textContent).toBe("General");
    act(() =>
      Array.from(host.querySelectorAll("button"))
        .find((b) => b.textContent?.includes("First project"))!
        .click(),
    );
    expect(host.querySelector('[aria-current="page"]')!.textContent).toBe("Overview");
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Switch project"]')!.click());
    act(() =>
      Array.from(document.querySelectorAll("button"))
        .find((b) => b.getAttribute("aria-label") === "Second project")!
        .click(),
    );
    expect(useProjectsStore.getState().selectedProjectId).toBe("p1");
    expect(host.textContent).toContain("Second project");
    expect(host.querySelector('[aria-current="page"]')!.textContent).toBe("Overview");
    expect(host.querySelector('button[aria-label="All projects"]')).not.toBeNull();
    act(() =>
      Array.from(host.querySelectorAll("button"))
        .find((b) => b.textContent === "All projects")!
        .click(),
    );
    expect(host.querySelector('[aria-current="page"]')!.textContent).toBe("General");
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
it("follows the sidebar's selected project in the Configure compatibility route", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollTo = vi.fn();
  useProjectsStore.setState({
    projects: [project, { ...project, id: "p2", name: "Second project" }],
    selectedProjectId: "p1",
  });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    act(() => root.render(<ConfigurePage />));
    expect(
      host.querySelector('[aria-label="Settings scope"] button[aria-pressed="true"]')?.textContent,
    ).toContain("First project");
    act(() => useProjectsStore.setState({ selectedProjectId: "p2" }));
    expect(
      host.querySelector('[aria-label="Settings scope"] button[aria-pressed="true"]')?.textContent,
    ).toContain("Second project");
    expect(host.querySelector('[aria-current="page"]')?.textContent).toBe("Overview");
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
it("reaches every inventoried row through search, across both scopes", () => {
  const groups = [
    ...settingsGroups(undefined, {
      hosts: true,
      logs: true,
      account: true,
      runners: true,
      moves: true,
      experiments: resolveExperiments({ cloud: true }, [], "dev"),
    }),
    ...configureGroups(project).map((g) =>
      Object.assign({}, g, {
        categories: g.categories.map((c) => Object.assign({}, c, { key: `project:${c.key}` })),
      }),
    ),
  ];
  for (const [key, rows] of Object.entries(SETTINGS_ROWS)) {
    for (const row of rows)
      expect(
        settingsSearch(groups, row).some((r) => r.category.key === key.replace(/^app:/, "")),
        `${key}: ${row}`,
      ).toBe(true);
  }
});
