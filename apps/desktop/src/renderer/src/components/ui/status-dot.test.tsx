/**
 * The status→tone map, asserted as a table rather than site by site.
 *
 * This file exists because the bug it guards against was never a rendering bug.
 * Three surfaces each held their own copy of this map and each was individually
 * correct; what was wrong was that they disagreed — and no test of any one of
 * them could see that. So the assertions here are all RELATIONS between states,
 * not the hex a state resolves to: which states share a colour, which are louder
 * than which, and that none of them falls through to nothing.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";

const EVERY_STATE: StatusDotState[] = [
  "working",
  "setup",
  "ready",
  "starting",
  "waiting",
  "error",
  "idle",
  "parked",
  "exited",
];

/** The rendered class list for one state, as a set of utilities. */
function classesFor(state: StatusDotState): string[] {
  const markup = renderToStaticMarkup(<StatusDot state={state} />);
  return /class="([^"]*)"/.exec(markup)?.[1]?.split(" ") ?? [];
}

/** The one colour utility a state paints its fill with. */
function toneOf(state: StatusDotState): string | undefined {
  return classesFor(state).find((one) => one.startsWith("bg-"));
}

describe("StatusDot", () => {
  it("paints every state, with no state falling through to nothing", () => {
    // The whole point of the exhaustive `Record`. A state that resolved to
    // `undefined` would render a 6px transparent hole, which reads as "this
    // Session has no status" rather than as a bug.
    for (const state of EVERY_STATE) {
      expect(toneOf(state), state).toMatch(/^bg-/);
    }
  });

  it("puts every healthy state in one family, and separates the live turn by halo", () => {
    // `working`, `setup` and `ready` are one fact. The strip used to say the
    // live turn in the ACCENT — the same colour as the selected-tab indicator
    // two pixels away — while the rail said it in green.
    expect(toneOf("working")).toBe("bg-positive");
    expect(toneOf("setup")).toBe("bg-positive");
    expect(toneOf("ready")).toBe("bg-positive");

    const halo = (state: StatusDotState) =>
      classesFor(state).some((one) => one.startsWith("shadow-"));
    expect(halo("working")).toBe(true);
    expect(halo("ready")).toBe(false);
    expect(halo("setup")).toBe(false);
  });

  it("reserves the attention tone for the one state asking for a person", () => {
    // `waiting` is declared by a harness hook, never inferred — it is the only
    // state that means "an agent is blocked on you". Nothing else may borrow it,
    // or the rail stops being scannable for the thing that needs doing.
    expect(toneOf("waiting")).toBe("bg-attention");
    const alsoAmber = EVERY_STATE.filter(
      (state) => state !== "waiting" && toneOf(state) === "bg-attention",
    );
    expect(alsoAmber).toEqual([]);
  });

  it("keeps a failure destructive, and keeps it apart from waiting", () => {
    // The conflict this component was created to end: `error` was destructive
    // red in the tab strip while the rail and the sidebar painted a Session
    // needing you amber. Both readings are right — they are different states,
    // and now they are different states in one map instead of one state in two.
    expect(toneOf("error")).toBe("bg-destructive");
    expect(toneOf("error")).not.toBe(toneOf("waiting"));
  });

  it("says resting in two neutral weights, not four", () => {
    // The rail had `/50 · /35 · /25` and the strip had full-strength
    // `bg-muted-foreground` for the same states. Live-but-quiet reads at one
    // weight, not-running at a quieter one, and there is no third distinction a
    // resting Session earns.
    expect(toneOf("idle")).toBe(toneOf("starting"));
    expect(toneOf("parked")).toBe(toneOf("exited"));
    expect(toneOf("idle")).not.toBe(toneOf("parked"));

    const neutrals = new Set(
      (["idle", "starting", "parked", "exited"] as StatusDotState[]).map(toneOf),
    );
    expect(neutrals.size).toBe(2);
    for (const tone of neutrals) expect(tone).toMatch(/^bg-muted-foreground\//);
  });

  it("draws the two sizes the app has, and stays out of the a11y tree", () => {
    // The dot never says anything a surface has not already said in words — the
    // rail prints the label beside it, the strip names the Session — so a second
    // announcement would read the status twice.
    expect(renderToStaticMarkup(<StatusDot state="idle" />)).toContain("size-1.5");
    expect(renderToStaticMarkup(<StatusDot state="idle" size="md" />)).toContain("size-2");
    expect(renderToStaticMarkup(<StatusDot state="idle" />)).toContain("aria-hidden");
  });

  it("carries the state into the DOM so a surface can be tested on what it MEANT", () => {
    // `data-state` is why the panel's own test can assert "this row reports
    // waiting" without asserting a colour it does not own.
    expect(renderToStaticMarkup(<StatusDot state="waiting" />)).toContain('data-state="waiting"');
  });
});
