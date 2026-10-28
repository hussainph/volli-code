// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useCloudMovesStore } from "@renderer/stores/cloud-moves";
import { move, snapshot } from "../cloud-moves/test-support";
import { ProjectTile } from "./project-tile";
const mocks = vi.hoisted(() => ({ cloud: true, launch: "local", remote: false, select: vi.fn() }));
vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: undefined,
  }),
}));
vi.mock("@renderer/components/hosts/use-hosts", () => ({
  useCloudEnabled: () => mocks.cloud,
  useRemoteProjectHost: () => (mocks.remote ? { name: "Other Mac" } : null),
  notAvailableOn: () => "On Other Mac",
}));
vi.mock("@renderer/stores/launch", () => ({ launchStore: () => mocks.launch }));
vi.mock("@renderer/stores/projects", () => ({
  useProjectsStore: (
    select: (state: { select: typeof mocks.select; selectedProjectId: string }) => unknown,
  ) => select({ select: mocks.select, selectedProjectId: "project" }),
}));
vi.mock("./relink-project-dialog", () => ({ RelinkProjectDialog: () => null }));
vi.mock("./remove-project-dialog", () => ({ RemoveProjectDialog: () => null }));
let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.cloud = true;
  mocks.launch = "local";
  mocks.remote = false;
  useCloudMovesStore.setState({ sheet: null, snapshot: null });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function menu() {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <ProjectTile
          project={{
            id: "project",
            name: "Atlas",
            ticketPrefix: "ATL",
            path: "/repo",
            colorIndex: 0,
            sortOrder: 0,
            createdAt: 0,
            updatedAt: 0,
          }}
          index={0}
          dimmed={false}
        />
      </TooltipProvider>,
    ),
  );
  await act(async () =>
    container
      .querySelector("button")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 })),
  );
}

describe("project menu Move to Volli Cloud", () => {
  it("opens only that project's pre-flight, immediately above Remove from Volli", async () => {
    await menu();
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    const index = items.findIndex((item) => item.textContent === "Move to Volli Cloud…");
    expect(index).toBeGreaterThan(-1);
    expect(items[index + 1]?.textContent).toBe("Remove from Volli…");
    await act(async () => (items[index] as HTMLElement).click());
    expect(useCloudMovesStore.getState().sheet).toEqual(
      expect.objectContaining({ kind: "prepare", projectIds: ["project"] }),
    );
  });
  it.each(["off", "cloud-launch", "remote"])("offers no move for %s", async (kind) => {
    if (kind === "off") mocks.cloud = false;
    if (kind === "cloud-launch") mocks.launch = "cloud";
    if (kind === "remote") mocks.remote = true;
    await menu();
    expect(document.body.textContent).not.toContain("Move to Volli Cloud…");
  });
  it("reopens an existing frozen move instead of preparing a second one", async () => {
    useCloudMovesStore.setState({ snapshot: { ...snapshot, moves: [move] } });
    await menu();
    await act(async () =>
      (
        [...document.querySelectorAll('[role="menuitem"]')].find(
          (item) => item.textContent === "Move to Volli Cloud…",
        ) as HTMLElement
      ).click(),
    );
    expect(useCloudMovesStore.getState().sheet).toEqual(
      expect.objectContaining({ kind: "progress", queueId: "queue" }),
    );
  });
});
