// @vitest-environment jsdom
/**
 * The island as a person meets it (VC-256): nothing when there is nothing to
 * model, clusters that come and go with their subjects, a card that pins and
 * releases, destructive actions that arm before they fire, and verbs that name
 * the right subject. Feel is not judged here — that is the lab harness's job —
 * so animations are skipped wholesale and reduced motion is forced, which
 * leaves AnimatePresence's mount/unmount as the only motion fact under test.
 *
 * jsdom rather than static markup: the cards are Radix popovers portalled to
 * the body, and every promise here is an interaction.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MotionGlobalConfig } from "motion/react";
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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom ships no `matchMedia`; the island reads it through use-reduced-motion.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  MotionGlobalConfig.skipAnimations = true;
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
  MotionGlobalConfig.skipAnimations = false;
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
    click(actionIn("tabs", "Show here"));
    expect(actions.promoteTab).toHaveBeenCalledTimes(2);
    expect(actions.closeTab).not.toHaveBeenCalled();
  });

  it("draws a tab already pinned here inert, and a strip tab as one that can be shown here (VC-268)", async () => {
    // The verb pins a tab as this chat's preview. A tab that IS the preview has
    // nowhere to go, so its row is inert rather than activatable-and-idle;
    // a strip tab can come back here, so its row keeps the verb.
    const actions = actionsSpy();
    await render(
      {
        ...EMPTY_ACTIVITY_ISLAND,
        tabs: [
          tab({ id: "t1", host: "github.com", promoted: true, surface: "preview" }),
          tab({ id: "t2", host: "motion.dev", promoted: true, surface: "tab" }),
        ],
      },
      actions,
    );
    click(cluster("tabs"));

    const pinned = rowIn("tabs", "t1");
    expect(pinned.tagName).toBe("DIV");
    expect(pinned.textContent).toContain("pinned here");
    click(pinned);
    expect(actions.promoteTab).not.toHaveBeenCalled();
    expect(pinned.parentElement?.querySelector('[aria-label="Show here"]')).toBeNull();
    expect(pinned.parentElement?.querySelector('[aria-label="Close tab"]')).not.toBeNull();

    const strip = rowIn("tabs", "t2");
    expect(strip.tagName).toBe("BUTTON");
    expect(strip.textContent).toContain("as a tab");
    click(strip);
    expect(actions.promoteTab).toHaveBeenCalledWith("t2");
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
  it("arm on the first press and fire on the second", async () => {
    const actions = actionsSpy();
    await render({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()] }, actions);
    click(cluster("tabs"));

    const close = actionIn("tabs", "Close tab");
    click(close);
    expect(actions.closeTab).not.toHaveBeenCalled();
    expect(close.getAttribute("aria-label")).toBe("Click again to close");
    expect(close.hasAttribute("data-armed")).toBe(true);

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
