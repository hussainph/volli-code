// @vitest-environment jsdom
/**
 * What may set the island's clusters moving (VC-1215). Each cluster is a Motion
 * `layout` element, and its `layoutDependency` decides which renders it
 * measures on. A pane drag re-renders the plane once per frame with nothing in
 * the island changed; were the clusters to measure on those renders, each one
 * would see the pane's step as its own move and spring after the pane outside
 * the drawn outline. So the dependency holds across a render that brings the
 * same content, and changes with the content that places the clusters.
 *
 * jsdom lays nothing out, so Motion's own measurement cannot be observed here;
 * the live behaviour is proven in the lab against a real split divider. This
 * pins the contract the fix rests on: what each cluster is handed.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  type ActivityIslandActions,
  type ActivityIslandFeel,
  type ActivityIslandModel,
  EMPTY_ACTIVITY_ISLAND,
  type IslandShell,
  type IslandTab,
} from "@volli/session-presentation";

import { ActivityIsland } from "./activity-island-ui";
import { TooltipProvider } from "@renderer/components/ui/tooltip";

/** The `layoutDependency` each `layout` span was rendered with, in order. */
const handed = vi.hoisted(() => ({ dependencies: [] as unknown[] }));

vi.mock("motion/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("motion/react")>();
  const Span = original.motion.span;
  const RecordingSpan = React.forwardRef<HTMLSpanElement, React.ComponentProps<typeof Span>>(
    function RecordingSpan(props, ref) {
      if (props.layout) handed.dependencies.push(props.layoutDependency);
      return <Span ref={ref} {...props} />;
    },
  );
  return {
    ...original,
    motion: new Proxy(original.motion, {
      get: (target, key, receiver) =>
        key === "span" ? RecordingSpan : Reflect.get(target, key, receiver),
    }),
  };
});

vi.mock("@renderer/lib/use-model-catalogue", () => ({ useModelCatalogue: () => null }));

let root: Root | null = null;
let container: HTMLElement | null = null;

const TAB: IslandTab = {
  id: "t1",
  host: "github.com",
  state: "ready",
  promoted: false,
  surface: null,
  owner: null,
};
const SHELL: IslandShell = { id: "s1", command: "pnpm lab", state: "running", code: null };

const ACTIONS: ActivityIslandActions = {
  closeTab: () => {},
  promoteTab: () => {},
  replayTab: () => {},
  peekAgent: () => {},
  promoteAgent: () => {},
  stopAgent: () => {},
  openShell: () => {},
  killShell: () => {},
  jumpStep: () => {},
};

async function render(
  model: ActivityIslandModel,
  feel?: Partial<ActivityIslandFeel>,
  className?: string,
) {
  await act(async () => {
    root?.render(
      <TooltipProvider delayDuration={0}>
        <ActivityIsland model={model} actions={ACTIONS} feel={feel} className={className} />
      </TooltipProvider>,
    );
  });
}

/** The dependencies handed on the latest render, one per cluster. */
async function renderAndRead(
  model: ActivityIslandModel,
  feel?: Partial<ActivityIslandFeel>,
  className?: string,
): Promise<unknown[]> {
  handed.dependencies.length = 0;
  await render(model, feel, className);
  return [...handed.dependencies];
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

it("hands every cluster the same dependency across a render that changed nothing in the island", async () => {
  const model = { ...EMPTY_ACTIVITY_ISLAND, tabs: [TAB], shells: [SHELL] };
  const feel: Partial<ActivityIslandFeel> = { forceReducedMotion: false };
  const before = await renderAndRead(model, feel, "mb-2");
  // A pane step: the plane re-renders the island with the same content.
  const during = await renderAndRead(model, feel, "mb-2 pointer-events-auto");

  // Both clusters, on every render, hold one and the same value.
  expect(before.length).toBeGreaterThanOrEqual(2);
  expect(before[0]).toBeDefined();
  expect(during.length).toBeGreaterThanOrEqual(2);
  for (const dependency of [...before, ...during]) expect(dependency).toBe(before[0]);
});

it("does not take a fresh dependency from the default feel on every render", async () => {
  const model = { ...EMPTY_ACTIVITY_ISLAND, tabs: [TAB] };
  const [before] = await renderAndRead(model);
  const [during] = await renderAndRead(model);
  expect(during).toBe(before);
});

it("changes the dependency when the island's own content changes", async () => {
  const feel: Partial<ActivityIslandFeel> = {};
  const [before] = await renderAndRead({ ...EMPTY_ACTIVITY_ISLAND, tabs: [TAB] }, feel);
  const [grown] = await renderAndRead(
    { ...EMPTY_ACTIVITY_ISLAND, tabs: [TAB, { ...TAB, id: "t2" }] },
    feel,
  );
  expect(grown).not.toBe(before);
});

it("changes the dependency when the feel or reduced motion changes", async () => {
  const model = { ...EMPTY_ACTIVITY_ISLAND, tabs: [TAB] };
  const [lively] = await renderAndRead(model, { forceReducedMotion: false });
  const [reduced] = await renderAndRead(model, { forceReducedMotion: true });
  expect(reduced).not.toBe(lively);
});
