// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_CANVAS, canvasBackground, projectColor, type Project } from "@volli/shared";
import { useProjectsStore } from "@renderer/stores/projects";
import { useThemeStore } from "@renderer/stores/theme";
import { ProjectTile } from "./project-tile";
import { TooltipProvider } from "@renderer/components/ui/tooltip";

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: { "data-sortable": "true" },
    listeners: { onPointerDown: pointerDown },
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
  }),
}));
vi.mock("./relink-project-dialog", () => ({ RelinkProjectDialog: () => null }));
vi.mock("./remove-project-dialog", () => ({ RemoveProjectDialog: () => null }));
const pointerDown = vi.fn();
const initialProjects = useProjectsStore.getState();
const initialTheme = useThemeStore.getState();
const project: Project = {
  id: "project",
  name: "Moonshot",
  path: "/work/moonshot",
  ticketPrefix: "MO",
  colorIndex: 2,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
};
let host: HTMLDivElement;
let root: Root;
const select = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
  );
  useProjectsStore.setState({ ...initialProjects, select, selectedProjectId: project.id });
  useThemeStore.setState({
    ...initialTheme,
    globalCanvas: DEFAULT_CANVAS,
    globalAppearance: "dark",
    systemPrefersDark: true,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useProjectsStore.setState(initialProjects);
  useThemeStore.setState(initialTheme);
  vi.unstubAllGlobals();
});
async function render(value: Project, dimmed = false) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <ProjectTile project={value} index={0} dimmed={dimmed} />
      </TooltipProvider>,
    ),
  );
  return host.querySelector("button")!;
}
describe("saved workspace rail identity", () => {
  it("keeps legacy palette, monogram, selected accessibility and sortable click behavior", async () => {
    const button = await render(project, true);
    expect(button.textContent).toBe("MO");
    const expected = document.createElement("div");
    expected.style.backgroundColor = projectColor(project.colorIndex);
    expect(button.style.backgroundColor).toBe(expected.style.backgroundColor);
    expect(button.getAttribute("aria-label")).toBe(project.name);
    expect(button.getAttribute("aria-current")).toBe("true");
    expect(host.querySelector('[data-sortable="true"]')?.className).toContain("opacity");
    await act(async () => button.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(pointerDown).toHaveBeenCalledOnce();
    await act(async () => button.click());
    expect(select).toHaveBeenCalledWith(project.id);
  });
  it("renders a saved glyph on its destination canvas and keeps selection outside the mark", async () => {
    const button = await render({
      ...project,
      themeCanvas: DEFAULT_CANVAS,
      themeAppearance: "light",
      workspaceIdentity: {
        choice: { kind: "glyph", name: "rocket" },
        surface: "orbit",
        monogramStyle: "editorial",
      },
    });
    expect(button.style.backgroundColor).toBe("");
    const mark = host.querySelector<HTMLElement>(".studio-mark")!;
    expect(mark.getAttribute("data-surface")).toBe("orbit");
    expect(mark.style.getPropertyValue("--mark-canvas")).toBe(
      canvasBackground(DEFAULT_CANVAS, "light"),
    );
    expect(mark.querySelector("svg")).not.toBeNull();
    expect(button.className).toContain("ring-2");
    expect(mark.className).not.toContain("ring-2");
  });
  it("inherits live window material and falls back from an unreadable saved image to initials", async () => {
    await render({
      ...project,
      workspaceIdentity: {
        choice: { kind: "custom", dataUrl: "data:image/png;base64,AAAA" },
        surface: "etched",
        monogramStyle: "architect",
      },
    });
    const mark = host.querySelector<HTMLElement>(".studio-mark")!;
    expect(mark.style.getPropertyValue("--mark-canvas")).toBe(
      canvasBackground(DEFAULT_CANVAS, "dark"),
    );
    await act(async () => host.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(mark.textContent).toContain("MO");
    await act(async () => useThemeStore.setState({ globalAppearance: "light" }));
    expect(mark.style.getPropertyValue("--mark-canvas")).toBe(
      canvasBackground(DEFAULT_CANVAS, "light"),
    );
    await act(async () => useProjectsStore.setState({ selectedProjectId: null }));
    expect(host.querySelector("button")!.hasAttribute("aria-current")).toBe(false);
  });
});
