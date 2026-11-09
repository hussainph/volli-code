// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Project } from "@volli/shared";
import { useProjectsStore } from "@renderer/stores/projects";
import { ProjectRail } from "./project-rail";

vi.mock("./project-tile", () => ({
  ProjectTile: ({ project }: { project: Project }) => <button>{project.name}</button>,
}));
vi.mock("./add-project-tile", () => ({ AddProjectTile: () => <button>Add project</button> }));
vi.mock("@renderer/stores/launch", () => ({ launchStore: () => "local" }));

const project: Project = {
  id: "one",
  name: "One",
  path: "/one",
  ticketPrefix: "ONE",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
};
let root: Root;
let container: HTMLDivElement;
let resize: () => void;
let disconnected: ReturnType<typeof vi.fn>;
let original: ReturnType<typeof useProjectsStore.getState>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  disconnected = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnected;
    },
  );
  original = useProjectsStore.getState();
  useProjectsStore.setState({ projects: [project] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useProjectsStore.setState(original);
  vi.unstubAllGlobals();
});

function mount(presentation: "rail" | "menu" = "rail") {
  act(() => root.render(<ProjectRail presentation={presentation} />));
  const scroll = container.querySelector<HTMLElement>('[data-slot="project-rail-scroll"]')!;
  let height = 300;
  Object.defineProperties(scroll, {
    clientHeight: { configurable: true, get: () => height },
    scrollHeight: { configurable: true, value: 500 },
  });
  return {
    scroll,
    resizeTo: (value: number) => {
      height = value;
      act(() => resize());
    },
  };
}

describe("project rail scroll edge", () => {
  it.each(["rail", "menu"] as const)(
    "fades only cut edges and keeps the last project reachable: %s",
    (presentation) => {
      const { scroll, resizeTo } = mount(presentation);
      resizeTo(300);
      expect(scroll.style.maskImage.toLowerCase()).toContain("currentcolor 0");
      expect(scroll.style.maskImage).toContain("transparent 100%");
      scroll.scrollTop = 100;
      act(() => scroll.dispatchEvent(new Event("scroll")));
      expect(scroll.style.maskImage).toContain("transparent 0");
      expect(scroll.style.maskImage).toContain("transparent 100%");
      scroll.scrollTop = 200;
      act(() => scroll.dispatchEvent(new Event("scroll")));
      expect(scroll.style.maskImage.toLowerCase()).toContain("currentcolor 100%");
      expect(scroll.style.maskImage).not.toContain("transparent 100%");
      // The fixed footer is not faded or scrolled with the project tiles.
      expect(scroll.textContent).not.toContain("Add project");
      expect(scroll.className).toContain("overflow-y-auto");
      expect(container.textContent).toContain("Add project");
      scroll.scrollTop = 0;
      resizeTo(600);
      expect(scroll.style.maskImage).toBe("");
    },
  );
  it("remeasures a changed collection and disconnects the viewport observer", () => {
    const { scroll } = mount();
    act(() =>
      useProjectsStore.setState({ projects: [project, { ...project, id: "two", name: "Two" }] }),
    );
    expect(scroll.style.maskImage).toContain("transparent 100%");
    expect(scroll.textContent).toContain("Two");
    act(() => root.render(null));
    expect(disconnected).toHaveBeenCalled();
  });
});
