// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  CollisionDetection,
  DndContextProps,
  DragEndEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SplitDnd } from "./split-dnd";
import { splitZoneId, type SplitDropOperation } from "./split-drop";
import { Tab, TabStrip, TabStripSurface } from "@renderer/components/ui/tab-strip";

const harness = vi.hoisted(() => ({ props: null as DndContextProps | null }));
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: DndContextProps) => {
      harness.props = props;
      return props.children;
    },
    DragOverlay: () => null,
  };
});
vi.mock("@dnd-kit/sortable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/sortable")>();
  return {
    ...actual,
    useSortable: () => ({
      attributes: {},
      listeners: {},
      setNodeRef: () => {},
      transform: { x: 100, y: 0, scaleX: 1, scaleY: 1 },
      transition: "transform 150ms",
      isDragging: false,
    }),
  };
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return DOMRect.fromRect({
      x: this.getAttribute("data-slot") === "tab-scroll" ? 80 : 100,
      y: 0,
      width: this.hasAttribute("data-clipped")
        ? 50
        : this.getAttribute("data-slot") === "tab-scroll"
          ? 160
          : 100,
      height: 30,
    });
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mountPairSurface() {
  const pair = vi.fn();
  const drop = vi.fn<(operation: SplitDropOperation) => void>();
  act(() =>
    root.render(
      <SplitDnd
        origin={{ scope: "project", projectId: "p", ticketId: null }}
        panes={[
          { paneId: "root", tabIds: ["source", "target"] },
          { paneId: "pane-2", tabIds: ["stacked"] },
        ]}
        onTabDrop={drop}
        onNativeDrop={() => {}}
        onGroupDrop={pair}
      >
        <div data-slot="tab-scroll">
          <div data-pair-target-id="target">Target</div>
        </div>
      </SplitDnd>,
    ),
  );
  const activatorEvent = new MouseEvent("pointerdown", { clientX: 10, clientY: 10 });
  const event = {
    active: { id: "source", data: { current: {} } },
    activatorEvent,
    delta: { x: 900, y: 300 },
    over: null,
  } as unknown as DragEndEvent;
  act(() => harness.props!.onDragStart?.(event as unknown as DragStartEvent));
  return { pair, drop, event };
}
function move(event: DragEndEvent, x: number, y = 15) {
  act(() => {
    harness.props!.collisionDetection!({
      pointerCoordinates: { x, y },
      droppableContainers: [],
    } as unknown as Parameters<CollisionDetection>[0]);
    harness.props!.onDragMove?.(event);
  });
}

describe("top-strip edge grouping", () => {
  it.each([
    [110, "left", ["target", "source", "left"]],
    [190, "right", ["target", "source", "right"]],
  ] as const)(
    "uses viewport pointer %s despite scroll-adjusted drag delta",
    (x, edge, expected) => {
      const { pair, event } = mountPairSurface();
      move(event, x);
      expect(host.querySelector("[data-pair-target-id]")?.getAttribute("data-pair-drop-edge")).toBe(
        edge,
      );
      act(() => harness.props!.onDragEnd?.(event));
      expect(pair).toHaveBeenCalledExactlyOnceWith(...expected);
    },
  );
  it("does not pair with an edge clipped outside its scrollport", () => {
    const { pair, event } = mountPairSurface();
    host.querySelector('[data-slot="tab-scroll"]')!.setAttribute("data-clipped", "");
    move(event, 190);
    expect(host.querySelector("[data-pair-drop-edge]")).toBeNull();
    act(() => harness.props!.onDragEnd?.(event));
    expect(pair).not.toHaveBeenCalled();
  });
  it("does not turn the centre of a tab into a group edge", () => {
    const { pair, event } = mountPairSurface();
    move(event, 150);
    expect(host.querySelector("[data-pair-drop-edge]")).toBeNull();
    act(() => harness.props!.onDragEnd?.(event));
    expect(pair).not.toHaveBeenCalled();
  });

  it("hands a pane's centre zone to the ordinary drop: the tab joins that stack", () => {
    const { pair, drop, event } = mountPairSurface();
    move(event, 400, 300);
    act(() =>
      harness.props!.onDragEnd?.({
        ...event,
        over: { id: splitZoneId("pane-2", "center") },
      } as unknown as DragEndEvent),
    );
    expect(pair).not.toHaveBeenCalled();
    expect(drop).toHaveBeenCalledExactlyOnceWith({
      kind: "move",
      tabId: "source",
      paneId: "pane-2",
    });
  });
});

it("keeps surface siblings stationary while standalone sortable strips retain their transform", () => {
  const tab = <Tab label="Target" dragId="target" active tabStop onActivate={() => {}} />;
  const reorder = { ids: ["target"], onReorder: () => {} };
  act(() =>
    root.render(
      <TabStripSurface>
        <TabStrip label="Surface" reorder={reorder}>
          {tab}
        </TabStrip>
      </TabStripSurface>,
    ),
  );
  expect((host.querySelector('[role="tab"]') as HTMLElement).style.transform).toBe("");
  act(() =>
    root.render(
      <TabStrip label="Standalone" reorder={reorder}>
        {tab}
      </TabStrip>,
    ),
  );
  expect((host.querySelector('[role="tab"]') as HTMLElement).style.transform).toContain("100px");
});
