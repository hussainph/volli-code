// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { Project } from "@volli/shared";
import { OverviewPane, projectOverrides } from "./overview-pane";
import { SettingsNavigation } from "../settings-navigation";
import { useThemeStore } from "@renderer/stores/theme";
vi.mock("@renderer/lib/use-model-catalogue", () => ({ useModelCatalogue: () => null }));
const base: Project = {
  id: "p1",
  name: "One",
  path: "/tmp/one",
  ticketPrefix: "O",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
};
const project: Project = {
  ...base,
  themeAppearance: "light",
  themeCanvas: {
    stops: [{ hex: "#ff0000", x: 0.3, y: 0.5 }],
    primaryIndex: 0,
    vibrancy: 0.4,
    grain: 0.1,
  },
  sessionModel: { providerId: "a", modelId: "m", reasoningLevel: "high" },
  decisionModel: { kind: "none" },
};
let host: HTMLDivElement;
let root: Root;
const openProject = vi.fn();
const navigation = { openProject };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("lists only explicit overrides, including an explicit decision-model off", () => {
  expect(projectOverrides(base)).toEqual([]);
  expect(projectOverrides(project).map((row) => row.key)).toEqual([
    "sessionModel",
    "decisionModel",
    "themeAppearance",
    "themeCanvas",
  ]);
});
it("links an override to its project editor without changing workspace selection", async () => {
  await act(async () =>
    root.render(
      <SettingsNavigation.Provider value={navigation}>
        <OverviewPane project={project} />
      </SettingsNavigation.Provider>,
    ),
  );
  await act(async () =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Chat model")!.click(),
  );
  expect(openProject).toHaveBeenCalledExactlyOnceWith("p1", "sessions");
  expect(host.textContent).toContain("Off");
});
it("resets chat and decision overrides through the existing IPC contracts", async () => {
  const setSessionDefaults = vi.fn().mockResolvedValue({ ok: true, project: base });
  const set = vi.fn().mockResolvedValue({ ok: true, project: base });
  vi.stubGlobal("api", { projects: { setSessionDefaults }, decisionModel: { set } });
  await act(async () => root.render(<OverviewPane project={project} />));
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Reset Chat model"]')!.click(),
  );
  expect(setSessionDefaults).toHaveBeenCalledExactlyOnceWith({ id: "p1", model: null });
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Reset Decision model"]')!.click(),
  );
  expect(set).toHaveBeenCalledExactlyOnceWith({ scope: "project", projectId: "p1" }, null);
});
it("resets appearance overrides using theme-store mutations", async () => {
  const canvas = vi.spyOn(useThemeStore.getState(), "setProjectCanvas").mockResolvedValue(true);
  const appearance = vi
    .spyOn(useThemeStore.getState(), "setProjectAppearance")
    .mockResolvedValue(true);
  await act(async () => root.render(<OverviewPane project={project} />));
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Reset Canvas"]')!.click(),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Reset Mode"]')!.click(),
  );
  expect(canvas).toHaveBeenCalledExactlyOnceWith("p1", null);
  expect(appearance).toHaveBeenCalledExactlyOnceWith("p1", null);
});
