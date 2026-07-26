import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  beginScopeRepaint,
  SCOPE_REPAINT,
  SCOPE_REPAINT_HOLD_MS,
  SCOPE_TRANSITION_ATTRIBUTE,
  SCOPE_TRANSITION_VALUE,
  shouldEaseScopeRepaint,
} from "./scope-transition";

/**
 * The renderer test project runs under vitest's default `node` environment, so
 * there is no DOM. `beginScopeRepaint` only ever sets/removes one attribute and
 * reads `offsetWidth`, so a recording stand-in exercises the real contract —
 * the same technique apply.test.ts uses for the token writes.
 */
function fakeRoot() {
  const attributes = new Map<string, string>();
  let flushes = 0;
  const root = {
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
    get offsetWidth(): number {
      flushes += 1;
      return 0;
    },
  };
  return {
    root: root as unknown as HTMLElement,
    attributes,
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

  it("cuts straight to the new theme within one scope", () => {
    // Picking a theme, committing an edit, ending a preview: every one of
    // these is a direct answer to a click, where instant IS the feedback.
    expect(shouldEaseScopeRepaint({ hydrated: true, from: "p1", to: "p1" })).toBe(false);
    expect(shouldEaseScopeRepaint({ hydrated: true, from: null, to: null })).toBe(false);
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
