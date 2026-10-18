// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BookOpenIcon } from "@phosphor-icons/react/dist/csr/BookOpen";
import type { Project } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";
import { ConfigurePage } from "./configure-page";

// The real panes read the host on mount; which pane is in FRONT is the page's
// own decision, so two inert categories are all this needs.
vi.mock("@renderer/components/settings/configure-groups", () => ({
  configureGroups: () => [
    {
      key: "agent",
      label: "Agent",
      categories: [
        { key: "skills", label: "Skills", icon: BookOpenIcon, content: <p>skills pane</p> },
        { key: "secrets", label: "Secrets", icon: BookOpenIcon, content: <p>secrets pane</p> },
      ],
    },
  ],
}));

const project: Project = {
  id: "p1",
  name: "Volli Code",
  path: "/repo/volli",
  ticketPrefix: "VC",
  baseBranch: null,
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
};

let root: Root;
let host: HTMLElement;
const previous = useProjectsStore.getState();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // The shell scrolls its content column back to the top on a pane change.
  window.HTMLElement.prototype.scrollTo = () => {};
  useProjectsStore.setState({ projects: [project], selectedProjectId: project.id });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useUiStore.getState().consumeConfigureCategory();
  useProjectsStore.setState({
    projects: previous.projects,
    selectedProjectId: previous.selectedProjectId,
  });
  vi.unstubAllGlobals();
});

/** The rail row the shell marks as the page in front. */
function current(): string | undefined {
  return host.querySelector('[aria-current="page"]')?.textContent?.trim();
}

describe("ConfigurePage pane requests (VC-303)", () => {
  it("opens on Skills when nobody asked for a pane", async () => {
    await act(async () => root.render(<ConfigurePage />));
    expect(current()).toBe("Skills");
  });

  it("opens on the pane ⌘K asked for, and spends the request", async () => {
    useUiStore.getState().requestConfigureCategory("secrets");
    await act(async () => root.render(<ConfigurePage />));

    expect(current()).toBe("Secrets");
    expect(host.textContent).toContain("secrets pane");
    expect(useUiStore.getState().configureCategory).toBeNull();
  });

  it("switches panes when asked while already on screen", async () => {
    await act(async () => root.render(<ConfigurePage />));
    expect(current()).toBe("Skills");

    await act(async () => useUiStore.getState().requestConfigureCategory("secrets"));

    expect(current()).toBe("Secrets");
    expect(useUiStore.getState().configureCategory).toBeNull();
  });
});
