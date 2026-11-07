// @vitest-environment jsdom
/**
 * The island as a person meets it (VC-256): nothing when there is nothing to
 * model, clusters that come and go with their subjects, a card that pins and
 * releases, destructive actions that arm before they fire, and verbs that name
 * the right subject. Recurring updates are static; the real popover primitive
 * retains ownership of occasional pointer disclosure motion.
 *
 * jsdom rather than static markup: the cards are Radix popovers portalled to
 * the body, and every promise here is an interaction.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  type ActivityIslandActions,
  type ActivityIslandFeel,
  type ActivityIslandModel,
  EMPTY_ACTIVITY_ISLAND,
  type IslandAgent,
  ISLAND_HOVER_LEAVE_GRACE_MS,
  type IslandPlan,
  type IslandShell,
  type IslandTab,
} from "@volli/session-presentation";

import { ActivityIsland } from "./activity-island-ui";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import type { ModelCatalogue } from "@renderer/lib/use-model-catalogue";

const heldCatalogue = vi.hoisted(() => ({ value: null as ModelCatalogue | null }));
vi.mock("@renderer/lib/use-model-catalogue", () => ({
  useModelCatalogue: () => heldCatalogue.value,
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

function tab(over: Partial<IslandTab> = {}): IslandTab {
  return {
    id: "t1",
    host: "github.com",
    state: "ready",
    promoted: false,
    surface: null,
    owner: null,
    ...over,
  };
}

function agent(over: Partial<IslandAgent> = {}): IslandAgent {
  return {
    id: "a1",
    label: "Audit icon weights",
    progress: 0.5,
    state: "working",
    promoted: false,
    model: { providerId: "anthropic", modelId: "sonnet-4.5", reasoningLevel: "high" },
    ...over,
  };
}

function shell(over: Partial<IslandShell> = {}): IslandShell {
  return { id: "s1", command: "pnpm lab", state: "running", code: null, ...over };
}

const PLAN: IslandPlan = {
  id: "p1",
  steps: [
    { id: "step-1", title: "Read", state: "completed" },
    { id: "step-2", title: "Sketch", state: "in_progress" },
    { id: "step-3", title: "Wire", state: "pending" },
  ],
  done: 1,
};

function actionsSpy(): ActivityIslandActions {
  return {
    closeTab: vi.fn(),
    promoteTab: vi.fn(),
    replayTab: vi.fn(),
    peekAgent: vi.fn(),
    promoteAgent: vi.fn(),
    stopAgent: vi.fn(),
    openShell: vi.fn(),
    killShell: vi.fn(),
    jumpStep: vi.fn(),
  };
}

const FEEL: Partial<ActivityIslandFeel> = { forceReducedMotion: true };

async function render(
  model: ActivityIslandModel,
  actions: ActivityIslandActions = actionsSpy(),
  feel: Partial<ActivityIslandFeel> = FEEL,
) {
  await act(async () => {
    root?.render(
      <TooltipProvider delayDuration={0}>
        <ActivityIsland model={model} actions={actions} feel={feel} />
      </TooltipProvider>,
    );
  });
}

/** Let a skipped animation report completion and AnimatePresence unmount its exit. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

function island(): HTMLElement | null {
  return container?.querySelector<HTMLElement>("[data-activity-island]") ?? null;
}

function clusters(): string[] {
  return [...(container?.querySelectorAll<HTMLElement>("[data-island-cluster]") ?? [])].map(
    (node) => node.dataset["islandCluster"] ?? "",
  );
}

function cluster(kind: string): HTMLElement {
  const node = container?.querySelector<HTMLElement>(`[data-island-cluster="${kind}"]`);
  if (!node) throw new Error(`no ${kind} cluster in the pill`);
  return node;
}

function card(kind: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-island-card="${kind}"]`);
}

function rowIn(kind: string, id: string): HTMLElement {
  const node = card(kind)?.querySelector<HTMLElement>(`[data-island-row="${id}"]`);
  if (!node) throw new Error(`no row ${id} in the ${kind} card`);
  return node;
}

function actionIn(kind: string, label: string): HTMLElement {
  const node = card(kind)?.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
  if (!node) throw new Error(`no action "${label}" in the ${kind} card`);
  return node;
}

function click(target: Element): void {
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function press(target: Element, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

/**
 * React synthesises `onMouseEnter`/`onMouseLeave` from the delegated
 * `mouseover`/`mouseout` pair, so the hover channel can only be driven through
 * those two — dispatching `mouseenter` directly reaches nothing.
 */
function hover(target: Element): void {
  act(() => {
    target.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, cancelable: true, relatedTarget: null }),
    );
  });
}

function unhover(target: Element, to: Element | null = null): void {
  act(() => {
    target.dispatchEvent(
      new MouseEvent("mouseout", { bubbles: true, cancelable: true, relatedTarget: to }),
    );
  });
}

beforeEach(() => {
  heldCatalogue.value = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom ships no `matchMedia`; the island reads it through use-reduced-motion.
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
  vi.useRealTimers();
});

it("gives a long plan one bounded row scrollport, not a second scrolling popover", async () => {
  const steps = Array.from({ length: 60 }, (_, i) => ({
    id: `step-${i}`,
    title: `${i}: ${"Long plan title / 日本語 / مرحبا ".repeat(4)}`,
    state: "pending" as const,
  }));
  await render({ ...EMPTY_ACTIVITY_ISLAND, plan: { id: "long-plan", steps, done: 0 } });
  click(cluster("plan"));
  const panel = card("plan")!;
  const body = panel.querySelector<HTMLElement>('[data-slot="popover-body"]')!;
  expect(panel.classList.contains("flex-col")).toBe(true);
  expect(body.classList.contains("overflow-hidden")).toBe(true);
  expect(body.classList.contains("overflow-y-auto")).toBe(false);
  expect(body.className).toContain("available-height)-0.5rem");
  const rows = panel.querySelector<HTMLElement>("[data-island-rows]")!;
  expect(rows.classList.contains("overflow-y-auto")).toBe(true);
  expect(rows.classList.contains("min-h-0")).toBe(true);
  expect(panel.querySelectorAll("[data-island-row]")).toHaveLength(60);
  expect(rowIn("plan", "step-59").textContent).toContain("59:");
  expect(panel.querySelector("h3")?.parentElement?.classList.contains("shrink-0")).toBe(true);
});

describe("the empty rule", () => {
  it("renders no island when there is nothing to model", async () => {
    await render(EMPTY_ACTIVITY_ISLAND);
    expect(island()).toBeNull();
  });

  it("renders no island for a flash with no subject", async () => {
    await render({
      ...EMPTY_ACTIVITY_ISLAND,
      flash: { id: "f1", event: "Closed", payload: "github.com" },
    });
    expect(island()).toBeNull();
  });

  it("holds no spacing open when it draws nothing", async () => {
    // The mount's spacing rides the pill, not a permanent wrapper: on the
    // wrapper it kept a band of dead air over the composer for as long as the
    // chat had nothing to model, which is the empty rule broken in the one way
    // that leaves the island itself looking correct.
    await act(async () => {
      root?.render(
        <TooltipProvider delayDuration={0}>
          <ActivityIsland
            model={EMPTY_ACTIVITY_ISLAND}
            actions={actionsSpy()}
            feel={FEEL}
            className="mb-2"
          />
        </TooltipProvider>,
      );
    });
    expect(island()).toBeNull();
    expect(container?.querySelector(".mb-2")).toBeNull();

    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()] });
    expect(island()).not.toBeNull();
  });
});

describe("clusters", () => {
  it("enter and leave by membership, in reading order", async () => {
    await render({ ...EMPTY_ACTIVITY_ISLAND, shells: [shell()] });
    expect(island()).not.toBeNull();
    expect(clusters()).toEqual(["shells"]);

    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()], shells: [shell()] });
    expect(clusters()).toEqual(["tabs", "shells"]);

    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()] });
    await settle();
    expect(clusters()).toEqual(["tabs"]);
  });

  it("takes the island away with the last subject", async () => {
    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()] });
    expect(island()).not.toBeNull();

    await render(EMPTY_ACTIVITY_ISLAND);
    await settle();
    expect(island()).toBeNull();
  });

  it("caps the subagent chips and counts the rest", async () => {
    const five = ["a1", "a2", "a3", "a4", "a5"].map((id) => agent({ id }));
    await render({ ...EMPTY_ACTIVITY_ISLAND, agents: five });
    const chips = cluster("agents").querySelectorAll("[data-agent-state]");
    expect(chips).toHaveLength(4);
    expect(cluster("agents").textContent).toContain("+1");
  });
});

describe("the card", () => {
  it("pins on click and releases on a re-click of the same cluster", async () => {
    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()] });
    expect(card("tabs")).toBeNull();

    click(cluster("tabs"));
    expect(card("tabs")).not.toBeNull();
    expect(cluster("tabs").getAttribute("aria-expanded")).toBe("true");
    // Radix arms its outside-pointerdown listener a tick after the card mounts.
    await settle();

    // The anchor is not a Radix trigger, so Radix would count this click as
    // OUTSIDE and dismiss on pointerdown before the click re-pinned — the
    // flicker that could never unpin. The anchor is exempted.
    act(() => {
      cluster("tabs").dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true }),
      );
    });
    click(cluster("tabs"));
    await settle();
    expect(card("tabs")).toBeNull();
    expect(cluster("tabs").getAttribute("aria-expanded")).toBe("false");
  });

  it("releases on Escape and on its own header pin", async () => {
    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()] });

    click(cluster("tabs"));
    expect(card("tabs")).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(card("tabs")).toBeNull();

    click(cluster("tabs"));
    const pin = card("tabs")?.querySelector<HTMLElement>("[data-island-pin]");
    expect(pin?.getAttribute("aria-pressed")).toBe("true");
    if (pin) click(pin);
    await settle();
    expect(card("tabs")).toBeNull();
  });

  it("shows one card at a time — pinning another cluster hands the card over", async () => {
    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()], shells: [shell()] });

    click(cluster("tabs"));
    expect(card("tabs")).not.toBeNull();
    click(cluster("shells"));
    await settle();
    expect(card("tabs")).toBeNull();
    expect(card("shells")).not.toBeNull();
  });

  it("moves focus into the first row on a keyboard pin, and never on a pointer pin", async () => {
    await render({
      ...EMPTY_ACTIVITY_ISLAND,
      tabs: [tab(), tab({ id: "t2", host: "motion.dev" })],
    });

    click(cluster("tabs"));
    expect(card("tabs")).not.toBeNull();
    expect(document.activeElement).not.toBe(rowIn("tabs", "t1"));

    // Re-pin from the keyboard: release with the pointer first.
    await settle();
    act(() => {
      cluster("tabs").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    click(cluster("tabs"));
    await settle();
    expect(card("tabs")).toBeNull();

    press(cluster("tabs"), "Enter");
    await settle();
    expect(card("tabs")).not.toBeNull();
    expect(document.activeElement).toBe(rowIn("tabs", "t1"));
  });

  it("hands focus back to the cluster when Escape closes a keyboard-pinned card (VC-268)", async () => {
    // The card is anchored, not triggered, so Radix has no trigger to return
    // focus to: its default close handler focuses nothing and then suppresses
    // FocusScope's own fallback. Left alone, Escape from a row dropped focus to
    // the document body — a keyboard user pinned a card, pressed Escape, and
    // was nowhere.
    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()] });
    act(() => cluster("tabs").focus());
    press(cluster("tabs"), "Enter");
    await settle();
    expect(document.activeElement).toBe(rowIn("tabs", "t1"));

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(card("tabs")).toBeNull();
    expect(document.activeElement).toBe(cluster("tabs"));
  });

  it("does not refocus the still-visible owning pane after Show tab selects another pane", async () => {
    const actions = actionsSpy();
    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()] }, actions);
    const anchor = cluster("tabs");
    act(() => anchor.focus());
    press(anchor, "Enter");
    await settle();
    click(rowIn("tabs", "t1"));
    expect(actions.promoteTab).toHaveBeenCalledWith("t1");
    act(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    await settle();
    expect(card("tabs")).toBeNull();
    expect(document.activeElement).not.toBe(anchor);
  });

  it("does not focus a hidden owning pane after a card action reveals another tab", async () => {
    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()] });
    const anchor = cluster("tabs");
    act(() => anchor.focus());
    press(anchor, "Enter");
    await settle();
    expect(document.activeElement).toBe(rowIn("tabs", "t1"));
    // The resident chat becomes hidden as the revealed tab takes the surface.
    anchor.checkVisibility = () => false;
    act(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    await settle();
    expect(card("tabs")).toBeNull();
    expect(document.activeElement).not.toBe(anchor);
  });

  it("leaves focus where a pointer put it when an outside click closes the card", async () => {
    // The person clicked something else; the card must not pull focus back to
    // the pill on its way out.
    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()] });
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    act(() => cluster("tabs").focus());
    press(cluster("tabs"), "Enter");
    await settle();
    expect(document.activeElement).toBe(rowIn("tabs", "t1"));

    act(() => {
      elsewhere.focus();
      elsewhere.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    await settle();
    expect(card("tabs")).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("goes with its cluster when the last subject leaves", async () => {
    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()], shells: [shell()] });
    click(cluster("tabs"));
    expect(card("tabs")).not.toBeNull();

    await render({ ...EMPTY_ACTIVITY_ISLAND, shells: [shell()] });
    await settle();
    expect(card("tabs")).toBeNull();
    // And the pin did not migrate to the survivor.
    expect(card("shells")).toBeNull();
  });
});

describe("the hover channel", () => {
  it("opens a card on hover and holds it across the leave grace", async () => {
    vi.useFakeTimers();
    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()] });
    expect(card("tabs")).toBeNull();

    hover(cluster("tabs"));
    expect(card("tabs")).not.toBeNull();

    // The grace exists so the pointer can cross the gap between a cluster and
    // its card without the card flickering out from under it.
    unhover(cluster("tabs"));
    await act(async () => {
      vi.advanceTimersByTime(ISLAND_HOVER_LEAVE_GRACE_MS - 20);
    });
    expect(card("tabs")).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(40);
    });
    expect(card("tabs")).toBeNull();
  });

  it("hands the card straight over when the pointer crosses to another cluster", async () => {
    vi.useFakeTimers();
    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()], shells: [shell()] });

    hover(cluster("tabs"));
    expect(card("tabs")).not.toBeNull();

    // No grace on a hand-off: entering the next cluster closes the old card in
    // the same frame, so two cards never overlap above a 32px pill.
    unhover(cluster("tabs"), cluster("shells"));
    hover(cluster("shells"));
    expect(card("tabs")).toBeNull();
    expect(card("shells")).not.toBeNull();
  });

  it("lets a pinned card outrank a glance at another cluster", async () => {
    // The bug this pins down: `pinned || hovered === id` held one id per
    // channel but two across them, so pinning one cluster and sweeping the
    // pointer over another opened BOTH cards at once. A pin is the work
    // channel; while it holds, a glance elsewhere may not open a second card.
    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()], shells: [shell()] });

    click(cluster("tabs"));
    expect(card("tabs")).not.toBeNull();

    hover(cluster("shells"));
    await settle();
    expect(card("shells")).toBeNull();
    expect(card("tabs")).not.toBeNull();
  });

  it("keeps a pinned card open when the pointer leaves it entirely", async () => {
    vi.useFakeTimers();
    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()] });

    hover(cluster("tabs"));
    click(cluster("tabs"));
    expect(card("tabs")).not.toBeNull();

    unhover(cluster("tabs"));
    await act(async () => {
      vi.advanceTimersByTime(ISLAND_HOVER_LEAVE_GRACE_MS + 100);
    });
    expect(card("tabs")).not.toBeNull();
  });
});

describe("row verbs", () => {
  it("promote on the row and on the first action, naming the subject", async () => {
    const actions = actionsSpy();
    await render(
      { ...EMPTY_ACTIVITY_ISLAND, tabs: [tab(), tab({ id: "t2", host: "motion.dev" })] },
      actions,
    );
    click(cluster("tabs"));

    click(rowIn("tabs", "t2"));
    expect(actions.promoteTab).toHaveBeenCalledWith("t2");
    click(actionIn("tabs", "Open beside chat"));
    expect(actions.promoteTab).toHaveBeenCalledTimes(2);
    expect(actions.closeTab).not.toHaveBeenCalled();
  });

  it("shows every tab, including legacy previews, with title and full address", async () => {
    const actions = actionsSpy();
    await render(
      {
        ...EMPTY_ACTIVITY_ISLAND,
        tabs: [
          tab({
            id: "t1",
            title: "Settings",
            detail: "localhost:5173/settings",
            surface: "preview",
          }),
          tab({ id: "t2", title: "Board", detail: "localhost:5174/board", surface: "tab" }),
        ],
      },
      actions,
    );
    click(cluster("tabs"));
    expect(rowIn("tabs", "t1").tagName).toBe("BUTTON");
    expect(rowIn("tabs", "t1").textContent).toContain("Settings");
    expect(rowIn("tabs", "t1").textContent).toContain("localhost:5173/settings");
    expect(card("tabs")?.textContent).not.toContain("pinned here");
    click(rowIn("tabs", "t1"));
    click(actionIn("tabs", "Show tab"));
    expect(actions.promoteTab).toHaveBeenNthCalledWith(1, "t1");
    expect(actions.promoteTab).toHaveBeenNthCalledWith(2, "t2");
    expect(card("tabs")?.querySelector('[aria-label="Replay"]')).toBeNull();
  });

  it("keeps fifteen localhost pages distinguishable without thumbnail previews", async () => {
    const tabs = Array.from({ length: 15 }, (_, index) =>
      tab({
        id: `local-${index}`,
        host: "localhost",
        title: `Page ${index + 1}`,
        detail: `localhost:${5173 + index}/work/page-${index + 1}`,
      }),
    );
    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs });
    click(cluster("tabs"));
    expect(card("tabs")?.querySelectorAll("[data-island-row]")).toHaveLength(15);
    for (const page of tabs) {
      const row = rowIn("tabs", page.id);
      expect(row.textContent).toContain(page.title);
      expect(row.textContent).toContain(page.detail);
    }
    expect(card("tabs")?.querySelector("img")).toBeNull();
  });

  it("raises attention-needing tabs above ready tabs", async () => {
    await render({
      ...EMPTY_ACTIVITY_ISLAND,
      tabs: [tab(), tab({ id: "need", needsAttention: true })],
    });
    click(cluster("tabs"));
    const rows = card("tabs")?.querySelectorAll("[data-island-row]");
    expect(rows?.[0]?.getAttribute("data-island-row")).toBe("need");
    expect(rows?.[0]?.textContent).toContain("needs you");
  });

  it("names a child Session's tab by its owner, and says nothing for this Session's own", async () => {
    await render({
      ...EMPTY_ACTIVITY_ISLAND,
      tabs: [tab(), tab({ id: "t2", host: "motion.dev", owner: "Read the docs" })],
    });
    click(cluster("tabs"));

    expect(rowIn("tabs", "t2").textContent).toContain("Read the docs");
    expect(rowIn("tabs", "t1").textContent).not.toContain("·");
  });

  it("counts its tabs in an attribute the smoke can read", async () => {
    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab(), tab({ id: "t2" })] });
    expect(
      cluster("tabs").querySelector("[data-island-count]")?.getAttribute("data-island-count"),
    ).toBe("2");
  });

  it("route each cluster's row to its own verb", async () => {
    const actions = actionsSpy();
    await render(
      {
        ...EMPTY_ACTIVITY_ISLAND,
        agents: [agent()],
        plan: PLAN,
        shells: [shell()],
      },
      actions,
    );

    click(cluster("agents"));
    click(rowIn("agents", "a1"));
    expect(actions.peekAgent).toHaveBeenCalledWith("a1");
    click(actionIn("agents", "Open as tab"));
    expect(actions.promoteAgent).toHaveBeenCalledWith("a1");

    click(cluster("shells"));
    await settle();
    click(rowIn("shells", "s1"));
    expect(actions.openShell).toHaveBeenCalledWith("s1");
  });

  // VC-416. The card row is one of the two surfaces that could not say which
  // model and effort the parent picked for its helper.
  it("says what each subagent is running, under its name", async () => {
    await render({
      ...EMPTY_ACTIVITY_ISLAND,
      agents: [
        agent(),
        agent({
          id: "a2",
          label: "Grep the tests",
          model: { providerId: "openai", modelId: "o5-mini", reasoningLevel: "xhigh" },
        }),
      ],
    });
    click(cluster("agents"));

    // The model id and the composer's own word for the level — never `xhigh`,
    // which is Pi's wire spelling and nobody's label.
    expect(rowIn("agents", "a1").textContent).toContain("sonnet-4.5");
    expect(rowIn("agents", "a1").textContent).toContain("High");
    expect(rowIn("agents", "a2").textContent).toContain("o5-mini");
    expect(rowIn("agents", "a2").textContent).toContain("Extra high");
    expect(rowIn("agents", "a2").textContent).not.toContain("xhigh");
  });

  // Nothing at all, rather than a placeholder: the gap is the one beat between
  // a delegated row appearing and its Session's start settling, and `— · —`
  // would report an absence as a reading.
  it("draws no policy line for a subagent that has not recorded one", async () => {
    await render({ ...EMPTY_ACTIVITY_ISLAND, agents: [agent({ model: null })] });
    click(cluster("agents"));

    expect(rowIn("agents", "a1").querySelector("[data-agent-model]")).toBeNull();
    // The row still says what it is doing; only the policy is missing.
    expect(rowIn("agents", "a1").textContent).toContain("Audit icon weights");
  });

  it("wraps long plan titles and breaks long words instead of truncating", async () => {
    const title =
      "Review every checklist item before implementation supercalifragilisticexpialidocious";
    const plan: IslandPlan = {
      id: "long-title-plan",
      steps: [{ id: "long-step", title, state: "in_progress" }],
      done: 0,
    };
    await render({ ...EMPTY_ACTIVITY_ISLAND, plan });
    click(cluster("plan"));

    const row = rowIn("plan", "long-step");
    const titleNode = [...row.querySelectorAll<HTMLSpanElement>("span")].find(
      (span) => span.textContent === title,
    );
    expect(titleNode?.textContent).toBe(title);
    expect(titleNode?.classList.contains("truncate")).toBe(false);
    expect(titleNode?.classList.contains("whitespace-normal")).toBe(true);
    expect(titleNode?.classList.contains("break-words")).toBe(true);
    expect(row.textContent).toContain("now");
  });

  it("draws a step per id, so two steps may share a title", async () => {
    const repeated: IslandPlan = {
      id: "p2",
      steps: [
        { id: "step-a", title: "Review", state: "pending" },
        { id: "step-b", title: "Review", state: "pending" },
      ],
      done: 0,
    };
    await render({ ...EMPTY_ACTIVITY_ISLAND, plan: repeated });
    click(cluster("plan"));

    expect(card("plan")?.querySelectorAll("[data-island-row]")).toHaveLength(2);
    expect(rowIn("plan", "step-b")).not.toBe(rowIn("plan", "step-a"));
  });

  it("draws plan steps inert — a step has nowhere to jump to yet (VC-268)", async () => {
    // One `todo_write` writes the whole list and no step has a message of its
    // own, so a row that took a click and did nothing would be the lie the
    // "inert row cannot lie" rule forbids. The rows are `<div>`s: no hover
    // fill, no focus ring, no verb.
    const actions = actionsSpy();
    await render({ ...EMPTY_ACTIVITY_ISLAND, plan: PLAN }, actions);
    click(cluster("plan"));

    const row = rowIn("plan", "step-3");
    expect(row.tagName).toBe("DIV");
    click(row);
    expect(actions.jumpStep).not.toHaveBeenCalled();
  });

  it("draws a dropped step dimmed and says so, rather than as one still waiting (VC-6)", async () => {
    // `cancelled` has no glyph of its own on purpose — a cancelled row that
    // drew like a pending one would read as work still to come, and one that
    // drew like a done one would read as work that happened.
    const dropped: IslandPlan = {
      id: "p3",
      steps: [
        { id: "step-a", title: "Read", state: "completed" },
        { id: "step-b", title: "Revive the dock", state: "cancelled" },
      ],
      done: 1,
    };
    await render({ ...EMPTY_ACTIVITY_ISLAND, plan: dropped }, actionsSpy());
    click(cluster("plan"));
    await settle();

    const row = card("plan")?.querySelector("[data-island-row='step-b']");
    expect(row?.textContent).toContain("Revive the dock");
    expect(row?.textContent).toContain("dropped");
    // Not the "now" a current step takes, and not the tick a done step takes.
    expect(row?.textContent).not.toContain("now");
  });
});

describe("destructive actions", () => {
  it("closes browser tabs on the first press; the feed provides Undo", async () => {
    const actions = actionsSpy();
    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()] }, actions);
    click(cluster("tabs"));
    const close = actionIn("tabs", "Close tab");
    click(close);
    expect(actions.closeTab).toHaveBeenCalledWith("t1");
    expect(close.hasAttribute("data-armed")).toBe(false);
  });

  it("disarm on their own when the second press never comes", async () => {
    vi.useFakeTimers();
    const actions = actionsSpy();
    await render({ ...EMPTY_ACTIVITY_ISLAND, shells: [shell()] }, actions);
    click(cluster("shells"));

    const kill = actionIn("shells", "Kill shell");
    click(kill);
    expect(kill.hasAttribute("data-armed")).toBe(true);

    // Still armed a breath before the window closes — without this the test
    // passes against any window at all, including one that disarms instantly.
    await act(async () => {
      vi.advanceTimersByTime(1700);
    });
    expect(kill.hasAttribute("data-armed")).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(kill.hasAttribute("data-armed")).toBe(false);
    click(kill);
    expect(actions.killShell).not.toHaveBeenCalled();
  });

  it("fires the kill verb with its own shell id once armed", async () => {
    const actions = actionsSpy();
    await render(
      {
        ...EMPTY_ACTIVITY_ISLAND,
        shells: [shell(), shell({ id: "s2", command: "vp check" })],
      },
      actions,
    );
    click(cluster("shells"));

    const kill = card("shells")
      ?.querySelector<HTMLElement>('[data-island-row="s2"]')
      ?.parentElement?.querySelector<HTMLElement>('button[aria-label="Kill shell"]');
    const target =
      kill ??
      card("shells")?.querySelectorAll<HTMLElement>('button[aria-label="Kill shell"]')[1] ??
      null;
    if (!target) throw new Error("no kill action on the second shell row");
    click(target);
    click(target);
    expect(actions.killShell).toHaveBeenCalledWith("s2");
  });

  it("fire at once with arming off", async () => {
    const actions = actionsSpy();
    await render({ ...EMPTY_ACTIVITY_ISLAND, agents: [agent()] }, actions, {
      ...FEEL,
      armDestructive: false,
    });
    click(cluster("agents"));

    click(actionIn("agents", "Stop subagent"));
    expect(actions.stopAgent).toHaveBeenCalledWith("a1");
  });

  it("offer stop and kill only while the subject is live", async () => {
    await render({
      ...EMPTY_ACTIVITY_ISLAND,
      agents: [agent({ state: "done" })],
      shells: [shell({ state: "exited", code: 0 })],
    });
    click(cluster("agents"));
    expect(card("agents")?.querySelector('[aria-label="Stop subagent"]')).toBeNull();
    click(cluster("shells"));
    await settle();
    expect(card("shells")?.querySelector('[aria-label="Kill shell"]')).toBeNull();
  });
});

describe("the now channel", () => {
  it("replaces frequent announcements immediately without retaining an exiting copy", async () => {
    await render({
      ...EMPTY_ACTIVITY_ISLAND,
      tabs: [tab()],
      flash: { id: "old", event: "Opened", payload: "github.com" },
    });
    await render({
      ...EMPTY_ACTIVITY_ISLAND,
      tabs: [tab()],
      flash: { id: "new", event: "Opened", payload: "example.com" },
    });
    expect(container?.querySelectorAll("[data-island-flash]")).toHaveLength(1);
    expect(container?.querySelector("[data-island-flash]")?.textContent).toBe(
      "Opened · example.com",
    );
    expect(container?.querySelector("[data-activity-island]")?.getAttribute("style")).toBeNull();
    expect(container?.querySelector("[data-activity-island]")?.classList.contains("isolate")).toBe(
      true,
    );
    expect(container?.querySelector('[role="status"]')).not.toBeNull();
  });

  it("shows a flash for the hold and reabsorbs it", async () => {
    vi.useFakeTimers();
    await render({
      ...EMPTY_ACTIVITY_ISLAND,
      tabs: [tab()],
      flash: { id: "f1", event: "Opened", payload: "github.com" },
    });
    const drop = container?.querySelector("[data-island-flash]");
    expect(drop?.textContent).toBe("Opened · github.com");

    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(container?.querySelector("[data-island-flash]")).toBeNull();
  });

  it("keeps the channel inline in the now-only grammar and falls back to the summary", async () => {
    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()] }, actionsSpy(), {
      ...FEEL,
      grammar: "now-only",
    });
    expect(clusters()).toEqual([]);
    expect(container?.querySelector("[data-island-ticker]")?.textContent).toBe("1 tab");
  });
});

describe("responsive card width", () => {
  // jsdom has no layout and no ResizeObserver; both are stubbed so the
  // measurement path runs exactly as it does in the app — the island reads
  // its own centering wrapper (full column width) less the column gutter
  // (zero in jsdom, where nothing is styled), and the card takes 75% of that.
  let clientWidthSpy: ReturnType<typeof vi.spyOn> | null = null;

  function stubMeasurement(columnWidth: number): void {
    // `observe` stays silent on purpose: the hook measures once on mount
    // itself, and a stub that fired every observer would also fire
    // floating-ui's own ResizeObserver (Radix popper positioning), whose
    // callback destructures entries the stub cannot invent.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(columnWidth);
  }

  // The file's own afterEach unstubs the ResizeObserver; the prototype spy is
  // restored here so no other suite inherits a measured column.
  afterEach(() => {
    clientWidthSpy?.mockRestore();
    clientWidthSpy = null;
  });

  it("sizes a pinned card to 75% of the measured column", async () => {
    stubMeasurement(800);
    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()] });
    click(cluster("tabs"));

    expect(card("tabs")?.style.width).toBe("600px");
    // jsdom serializes the rem against its 16px root; the authored value is
    // `calc(100vw - 2rem)`.
    expect(card("tabs")?.style.maxWidth).toBe("calc(100vw - 32px)");
  });

  it("floors a narrow column at the proven row width instead of crushing it", async () => {
    // 75% of 300 would be 225 — narrower than the rows the old fixed width
    // already proved usable — so the card holds 288 and truncates instead.
    stubMeasurement(300);
    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()] });
    click(cluster("tabs"));

    expect(card("tabs")?.style.width).toBe("288px");
  });

  it("gives the agents card the higher floor its three row actions need", async () => {
    stubMeasurement(300);
    await render({ ...EMPTY_ACTIVITY_ISLAND, agents: [agent()] });
    click(cluster("agents"));

    expect(card("agents")?.style.width).toBe("320px");
  });

  it("keeps long provider names out of the narrow subagents panel, but disambiguates its marks on long hover and row focus", async () => {
    vi.useFakeTimers();
    stubMeasurement(300);
    const providers = [
      { id: "cloudflare-workers-ai", label: "Cloudflare Workers AI" },
      { id: "cloudflare-ai-gateway", label: "Cloudflare AI Gateway" },
      { id: "qwen-token-plan-individual", label: "Qwen Token Plan Individual" },
    ];
    heldCatalogue.value = {
      providers: providers.map((provider) => ({
        ...provider,
        state: "available",
        accountLabel: null,
        billingSource: "unknown",
        recovery: null,
        signIn: [],
        hasStoredCredential: true,
      })),
      models: providers.map((provider) => ({
        providerId: provider.id,
        modelId: "qwen3-coder",
        label: "Qwen3 Coder",
        state: "available",
        reasoningLevels: ["high"],
        acceptsImageInput: false,
      })),
    };
    await render({
      ...EMPTY_ACTIVITY_ISLAND,
      agents: providers.map((provider, index) =>
        agent({
          id: `long-provider-${index}`,
          label: `Review ${index}`,
          model: { providerId: provider.id, modelId: "qwen3-coder", reasoningLevel: "high" },
        }),
      ),
    });
    click(cluster("agents"));
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    // Width is a production measurement-path assertion, not jsdom pixel proof.
    // Live light/dark checks still have to prove the actual 320px panel layout.
    expect(card("agents")?.style.width).toBe("320px");
    for (const [index, provider] of providers.entries()) {
      const policy = rowIn("agents", `long-provider-${index}`).querySelector("[data-agent-model]")!;
      expect(policy.textContent).toContain("Qwen3 Coder");
      expect(policy.textContent).toContain("High");
      expect(policy.textContent).not.toContain(provider.label);
      expect(policy.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(provider.label);
      expect(policy.querySelector("[tabindex]")).toBeNull();
    }
    // These first two providers deliberately share the exact Cloudflare mark
    // and model name. Their help tags, not persistent provider text, differ.
    const first = rowIn("agents", "long-provider-0");
    const mark = first.querySelector<HTMLElement>('[data-slot="help-tag"]')!;
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    act(() =>
      mark.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" })),
    );
    await act(async () => {
      vi.advanceTimersByTime(1499);
    });
    expect(
      document.body.querySelector('[data-slot="tooltip-content"]')?.textContent ?? "",
    ).not.toContain(providers[0]!.label);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(document.body.querySelector('[data-slot="tooltip-content"]')?.textContent).toBe(
      "Qwen3 Coder · Cloudflare Workers AI",
    );
    act(() =>
      mark.dispatchEvent(
        new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
      ),
    );
    expect(document.body.querySelector('[data-slot="tooltip-content"]')).toBeNull();
    const second = rowIn("agents", "long-provider-1");
    act(() => second.focus());
    expect(document.body.querySelector('[data-slot="tooltip-content"]')?.textContent).toBe(
      "Qwen3 Coder · Cloudflare AI Gateway",
    );
    expect(card("agents")?.textContent).not.toContain("Cloudflare AI Gateway");
  });

  it("keeps the fallback widths where there is nothing to measure with", async () => {
    // No ResizeObserver stub: jsdom proper. The card still opens at its
    // fixed fallback width rather than collapsing to nothing.
    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()] });
    click(cluster("tabs"));

    expect(card("tabs")).not.toBeNull();
    expect(card("tabs")?.style.width).toBe("");
  });
});
