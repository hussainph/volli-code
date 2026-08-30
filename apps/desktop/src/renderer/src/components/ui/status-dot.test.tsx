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
import { SESSION_PERSON_NEEDS, type SessionPersonNeed } from "@volli/shared";

import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";

/**
 * VC-112's "this needs no new concept", pinned as a type rather than trusted as
 * a comment.
 *
 * The notification rule (VC-133) fires on a Session entering `waiting` or
 * `error`, and its whole justification for minting nothing is that both are
 * already {@link StatusDotState} members — the states a person can already SEE
 * on every surface that draws a dot. `SessionPersonNeed` lives in
 * `@volli/shared`, which cannot import this renderer component, so the two
 * unions would otherwise be free to drift: rename a dot state and the rule
 * would keep firing on a word nothing draws.
 *
 * The widening below is the join: it costs nothing at runtime and fails the
 * build the moment either side moves. The test at the bottom of this file then
 * asserts the same thing about the VALUES, so a dot state that is deleted
 * rather than renamed is caught too.
 */
const NOTIFYING_STATES: readonly StatusDotState[] = SESSION_PERSON_NEEDS.map(
  (need: SessionPersonNeed): StatusDotState => need,
);

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

  it("lets the live turn breathe, and nothing else", () => {
    // Motion is the channel a glance reads. A haloed dot is the same amount of
    // ink as a resting one, which is why a running Session was hard to find in
    // a strip of tabs — and why `setup`, which is busy too, deliberately stays
    // still: a band where several kinds of busy all move has no signal left.
    const breathes = (state: StatusDotState) => classesFor(state).includes("status-dot-live");
    expect(breathes("working")).toBe(true);
    expect(EVERY_STATE.filter(breathes)).toEqual(["working"]);
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

  it("draws every state an unattended Run notifies on (VC-112, VC-133)", () => {
    // The value half of the pin at the top of this file. VC-112 justifies
    // minting no concept for the notification rule on the claim that both of
    // its trigger states are already drawn; this asserts the claim rather than
    // repeating it.
    expect([...NOTIFYING_STATES].toSorted()).toEqual(["error", "waiting"]);
    for (const state of NOTIFYING_STATES) {
      expect(EVERY_STATE).toContain(state);
      // And each is one of the two LOUD tones — never a neutral. A state a
      // person is notified about cannot be one the app draws as resting.
      expect(toneOf(state)).not.toMatch(/^bg-muted-foreground/);
    }
  });
});
