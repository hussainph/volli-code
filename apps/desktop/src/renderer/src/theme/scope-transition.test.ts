import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  beginScopeRepaint,
  CANVAS_FADE_ATTRIBUTE,
  CANVAS_FADE_VALUE,
  CANVAS_OUTGOING_VARIABLE,
  disarmScopeRepaint,
  SCOPE_REPAINT,
  SCOPE_REPAINT_HOLD_MS,
  SCOPE_TRANSITION_ATTRIBUTE,
  SCOPE_TRANSITION_VALUE,
  shouldEaseScopeRepaint,
} from "./scope-transition";

/** A gradient value, standing in for whatever `paintCanvas` last wrote. */
const OLD_CANVAS = "radial-gradient(ellipse at 20% 30%, #2ba39c, transparent 60%), #10201f";
const NEWER_CANVAS = "radial-gradient(ellipse at 70% 10%, #e8652a, transparent 60%), #201510";

/**
 * The renderer test project runs under vitest's default `node` environment, so
 * there is no DOM. `beginScopeRepaint` only ever moves two attributes, reads and
 * writes one custom property, and reads `offsetWidth`, so a recording stand-in
 * exercises the real contract — the same technique apply.test.ts uses for the
 * token writes.
 *
 * The stand-in records the ORDER of the operations that happen around the
 * forced style read, because the restart depends on it: the fade attribute has
 * to come off before the flush and go back on after it, or the layer resumes a
 * spent animation instead of playing a new one.
 */
function fakeRoot(canvas = "") {
  const attributes = new Map<string, string>();
  const properties = new Map<string, string>([["--canvas", canvas]]);
  const log: string[] = [];
  let flushes = 0;
  const root = {
    setAttribute: (name: string, value: string) => {
      log.push(`+${name}`);
      attributes.set(name, value);
    },
    removeAttribute: (name: string) => {
      log.push(`-${name}`);
      attributes.delete(name);
    },
    style: {
      getPropertyValue: (name: string) => properties.get(name) ?? "",
      setProperty: (name: string, value: string) => void properties.set(name, value),
      removeProperty: (name: string) => void properties.delete(name),
    },
    get offsetWidth(): number {
      flushes += 1;
      log.push("flush");
      return 0;
    },
  };
  return {
    root: root as unknown as HTMLElement,
    attributes,
    properties,
    log,
    flushCount: () => flushes,
  };
}

describe("shouldEaseScopeRepaint", () => {
  it("eases a switch from one project to another", () => {
    expect(shouldEaseScopeRepaint({ hydrated: true, from: "p1", to: "p2" })).toBe(true);
  });

  it("eases a switch from the global scope into a project", () => {
    expect(shouldEaseScopeRepaint({ hydrated: true, from: null, to: "p1" })).toBe(true);
  });

  it("eases a project's theme being dropped back to the global scope", () => {
    expect(shouldEaseScopeRepaint({ hydrated: true, from: "p1", to: null })).toBe(true);
  });

  it("cuts straight to the new canvas within one scope", () => {
    // Dragging a stop, committing an edit, ending a preview: every one of
    // these is a direct answer to a click, where instant IS the feedback.
    expect(shouldEaseScopeRepaint({ hydrated: true, from: "p1", to: "p1" })).toBe(false);
    expect(shouldEaseScopeRepaint({ hydrated: true, from: null, to: null })).toBe(false);
  });

  it("eases a light↔dark flip inside one scope", () => {
    // The case the projectId-only trigger missed entirely while dark was
    // pinned: same project, same canvas, every surface inverted. It reaches
    // here from a mode pick, from a workspace whose override differs coming
    // into scope, and from the system flipping under `auto`.
    expect(
      shouldEaseScopeRepaint({
        hydrated: true,
        from: "p1",
        to: "p1",
        fromAppearance: "dark",
        toAppearance: "light",
      }),
    ).toBe(true);
    expect(
      shouldEaseScopeRepaint({
        hydrated: true,
        from: null,
        to: null,
        fromAppearance: "light",
        toAppearance: "dark",
      }),
    ).toBe(true);
  });

  it("cuts when the mode is unchanged, however the canvas moved", () => {
    expect(
      shouldEaseScopeRepaint({
        hydrated: true,
        from: "p1",
        to: "p1",
        fromAppearance: "dark",
        toAppearance: "dark",
      }),
    ).toBe(false);
  });

  it("never eases the first paint, mode flip or not", () => {
    // A boot that resolves to light has no dark frame to come from — the mode
    // class was stamped by preload before the document painted at all.
    expect(
      shouldEaseScopeRepaint({
        hydrated: false,
        from: null,
        to: null,
        fromAppearance: "dark",
        toAppearance: "light",
      }),
    ).toBe(false);
  });

  it("never eases the first paint", () => {
    // There is no previous look to come from — easing here would make boot
    // look like a slow fade-in of an app that had already rendered.
    expect(shouldEaseScopeRepaint({ hydrated: false, from: null, to: "p1" })).toBe(false);
  });
});

describe("beginScopeRepaint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("arms the transition, then takes it off once the swap has settled", () => {
    const { root, attributes } = fakeRoot();

    beginScopeRepaint(root);
    expect(attributes.get(SCOPE_TRANSITION_ATTRIBUTE)).toBe(SCOPE_TRANSITION_VALUE);

    // Still armed while the crossfade is mid-flight.
    vi.advanceTimersByTime(SCOPE_REPAINT.crossfade);
    expect(attributes.has(SCOPE_TRANSITION_ATTRIBUTE)).toBe(true);

    vi.advanceTimersByTime(SCOPE_REPAINT.tail);
    expect(attributes.has(SCOPE_TRANSITION_ATTRIBUTE)).toBe(false);
  });

  it("flushes the pending style recalc so the transition is live before the tokens move", () => {
    const { root, flushCount } = fakeRoot();

    beginScopeRepaint(root);

    expect(flushCount()).toBe(1);
  });

  it("extends one window across overlapping scope changes rather than cutting the first short", () => {
    // Two rail clicks in quick succession: the colors must re-target from
    // wherever they are, not snap when the first timer fires.
    const { root, attributes } = fakeRoot();

    beginScopeRepaint(root);
    vi.advanceTimersByTime(SCOPE_REPAINT_HOLD_MS - 1);
    beginScopeRepaint(root);
    vi.advanceTimersByTime(SCOPE_REPAINT_HOLD_MS - 1);

    expect(attributes.has(SCOPE_TRANSITION_ATTRIBUTE)).toBe(true);

    vi.advanceTimersByTime(1);
    expect(attributes.has(SCOPE_TRANSITION_ATTRIBUTE)).toBe(false);
  });

  it("disarms the previous root when re-armed on a different one", () => {
    // One timer serves every caller, so re-arming elsewhere cancels the first
    // root's removal — take the attribute off there and then, or it would stay
    // armed for the life of the window.
    const first = fakeRoot();
    const second = fakeRoot();

    beginScopeRepaint(first.root);
    beginScopeRepaint(second.root);

    expect(first.attributes.has(SCOPE_TRANSITION_ATTRIBUTE)).toBe(false);
    expect(second.attributes.get(SCOPE_TRANSITION_ATTRIBUTE)).toBe(SCOPE_TRANSITION_VALUE);

    vi.advanceTimersByTime(SCOPE_REPAINT_HOLD_MS);
    expect(second.attributes.has(SCOPE_TRANSITION_ATTRIBUTE)).toBe(false);
  });

  it("defaults to the document element", () => {
    const { root, attributes } = fakeRoot();
    vi.stubGlobal("document", { documentElement: root });

    beginScopeRepaint();

    expect(attributes.get(SCOPE_TRANSITION_ATTRIBUTE)).toBe(SCOPE_TRANSITION_VALUE);
    vi.advanceTimersByTime(SCOPE_REPAINT_HOLD_MS);
    expect(attributes.has(SCOPE_TRANSITION_ATTRIBUTE)).toBe(false);
  });
});

describe("disarmScopeRepaint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does nothing when no repaint is armed", () => {
    expect(() => disarmScopeRepaint()).not.toThrow();
  });

  it("reverses an armed repaint immediately, without waiting for its timer", () => {
    // The HMR teardown this exists for: a module edit landing between an arm
    // and the timer's expiry, which the timer alone can never cover.
    const { root, attributes, properties } = fakeRoot(OLD_CANVAS);

    beginScopeRepaint(root);
    disarmScopeRepaint();

    expect(attributes.has(SCOPE_TRANSITION_ATTRIBUTE)).toBe(false);
    expect(attributes.has(CANVAS_FADE_ATTRIBUTE)).toBe(false);
    expect(properties.has(CANVAS_OUTGOING_VARIABLE)).toBe(false);
  });

  it("leaves the now-cleared timer harmless if it still fires", () => {
    const { root, attributes } = fakeRoot(OLD_CANVAS);

    beginScopeRepaint(root);
    disarmScopeRepaint();
    vi.advanceTimersByTime(SCOPE_REPAINT_HOLD_MS);

    expect(attributes.has(SCOPE_TRANSITION_ATTRIBUTE)).toBe(false);
  });
});

/**
 * The gradient's half of the same swap.
 *
 * What is testable headlessly is the HAND-OFF — which value is captured, when
 * the layer is mounted relative to the forced flush, and that nothing is left
 * behind — and that is exactly the part with decisions in it. What the layer
 * then LOOKS like is a `@keyframes` in globals.css and belongs to the smoke:
 * that it paints beneath the app, that opacity actually animates, and that
 * `prefers-reduced-motion` shortens it are properties of a real compositor.
 */
describe("beginScopeRepaint's canvas crossfade", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("captures the gradient still on the element and mounts a layer painting it", () => {
    // Read before anything is written: `paintCanvas` overwrites `--canvas`
    // immediately after this call, so this is the only moment the outgoing
    // gradient exists anywhere.
    const { root, attributes, properties } = fakeRoot(OLD_CANVAS);

    beginScopeRepaint(root);

    expect(properties.get(CANVAS_OUTGOING_VARIABLE)).toBe(OLD_CANVAS);
    expect(attributes.get(CANVAS_FADE_ATTRIBUTE)).toBe(CANVAS_FADE_VALUE);
  });

  it("mounts the layer AFTER the flush, so its animation starts from the top", () => {
    // The whole restart mechanism, and the one thing a DOM-free test can still
    // prove: off, flush, on. A layer re-armed without the flush in between is
    // the same element carrying the same animation, which does not replay — an
    // overlapping switch would then show no gradient fade at all.
    const { root, log } = fakeRoot(OLD_CANVAS);

    beginScopeRepaint(root);

    expect(log).toEqual([
      `+${SCOPE_TRANSITION_ATTRIBUTE}`,
      `-${CANVAS_FADE_ATTRIBUTE}`,
      "flush",
      `+${CANVAS_FADE_ATTRIBUTE}`,
    ]);
  });

  it("re-captures on an overlapping change and leaves nothing behind at the end", () => {
    // Two rail clicks in quick succession. The second fade starts from the
    // canvas that was in force when it began — the first switch's INCOMING one —
    // which is the same hand-off the mounted-copy implementation made.
    const { root, attributes, properties } = fakeRoot(OLD_CANVAS);

    beginScopeRepaint(root);
    properties.set("--canvas", NEWER_CANVAS);
    vi.advanceTimersByTime(SCOPE_REPAINT.crossfade);
    beginScopeRepaint(root);

    expect(properties.get(CANVAS_OUTGOING_VARIABLE)).toBe(NEWER_CANVAS);
    expect(attributes.get(CANVAS_FADE_ATTRIBUTE)).toBe(CANVAS_FADE_VALUE);

    // One hold, extended — and when it ends the layer is unmounted and the spent
    // gradient dropped, so a stuck full-window overlay is not reachable.
    vi.advanceTimersByTime(SCOPE_REPAINT_HOLD_MS);
    expect(attributes.has(CANVAS_FADE_ATTRIBUTE)).toBe(false);
    expect(properties.has(CANVAS_OUTGOING_VARIABLE)).toBe(false);
  });

  it("disarms the previous root's layer when re-armed on a different one", () => {
    // Same argument as the transition attribute, with more at stake: one timer
    // serves every caller, so without this the first root keeps a full-window
    // gradient frozen at whatever opacity its animation reached.
    const first = fakeRoot(OLD_CANVAS);
    const second = fakeRoot(NEWER_CANVAS);

    beginScopeRepaint(first.root);
    beginScopeRepaint(second.root);

    expect(first.attributes.has(CANVAS_FADE_ATTRIBUTE)).toBe(false);
    expect(first.properties.has(CANVAS_OUTGOING_VARIABLE)).toBe(false);
    expect(second.attributes.get(CANVAS_FADE_ATTRIBUTE)).toBe(CANVAS_FADE_VALUE);
  });

  it("cuts the gradient rather than fading from nothing when none has been painted", () => {
    // Only reachable before the first `paintCanvas` — which is also the repaint
    // that never eases. Mounting a layer painting an empty `background` would
    // fade the window through a transparent frame; cutting is what the app did
    // before the layer existed.
    const { root, attributes, properties } = fakeRoot();

    beginScopeRepaint(root);

    expect(attributes.get(SCOPE_TRANSITION_ATTRIBUTE)).toBe(SCOPE_TRANSITION_VALUE);
    expect(attributes.has(CANVAS_FADE_ATTRIBUTE)).toBe(false);
    expect(properties.has(CANVAS_OUTGOING_VARIABLE)).toBe(false);
  });
});
