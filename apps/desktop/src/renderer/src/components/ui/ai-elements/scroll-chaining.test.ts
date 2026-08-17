import { describe, expect, it } from "vite-plus/test";

import { wheelDetachesFollowing, type ScrollExtent } from "./scroll-chaining";

/**
 * The DOM stood up as plain objects — the walk only reads `parentElement`,
 * and asks the test for `overflow-y`, so no document is needed (the renderer
 * test project runs in a node environment).
 */
interface FakeNode {
  parentElement: FakeNode | null;
  overflowY: string;
}

function node(overflowY: string, parentElement: FakeNode | null = null): FakeNode {
  return { parentElement, overflowY };
}

const overflowYOf = (target: FakeNode): string => target.overflowY;

/** A transcript scroller with content behind the fold unless said otherwise. */
function scrollerNode(extent: Partial<ScrollExtent> = {}): FakeNode & ScrollExtent {
  return {
    parentElement: null,
    overflowY: "auto",
    scrollHeight: extent.scrollHeight ?? 2000,
    clientHeight: extent.clientHeight ?? 600,
  };
}

describe("wheelDetachesFollowing", () => {
  it("detaches on a wheel-up inside a nested scroller in the transcript", () => {
    // scroller > message > open bundle (overflow-auto) > row content
    const scroller = scrollerNode();
    const bundle = node("auto", node("visible", scroller));
    const target = node("visible", bundle);

    expect(wheelDetachesFollowing({ deltaY: -40, target, scroller, overflowYOf })).toBe(true);
  });

  it("counts overflow-y `scroll` as a nested scroller too", () => {
    const scroller = scrollerNode();
    const target = node("visible", node("scroll", scroller));

    expect(wheelDetachesFollowing({ deltaY: -1, target, scroller, overflowYOf })).toBe(true);
  });

  it("never detaches on a wheel-down: re-attachment is the library's scroll handler", () => {
    const scroller = scrollerNode();
    const target = node("visible", node("auto", scroller));

    expect(wheelDetachesFollowing({ deltaY: 40, target, scroller, overflowYOf })).toBe(false);
    expect(wheelDetachesFollowing({ deltaY: 0, target, scroller, overflowYOf })).toBe(false);
  });

  it("leaves a wheel-up over plain transcript to the library's own handler", () => {
    const scroller = scrollerNode();
    const target = node("visible", node("visible", scroller));

    expect(wheelDetachesFollowing({ deltaY: -40, target, scroller, overflowYOf })).toBe(false);
  });

  it("leaves a wheel-up on the scroller itself to the library", () => {
    const scroller = scrollerNode();

    expect(wheelDetachesFollowing({ deltaY: -40, target: scroller, scroller, overflowYOf })).toBe(
      false,
    );
  });

  it("stays quiet when the transcript has nothing behind the fold", () => {
    // Mirrors the library's guard: detaching here would flip `isAtBottom` off
    // and summon "Scroll to latest" over a transcript that fits on screen.
    const scroller = scrollerNode({ scrollHeight: 500, clientHeight: 600 });
    const target = node("visible", node("auto", scroller));

    expect(wheelDetachesFollowing({ deltaY: -40, target, scroller, overflowYOf })).toBe(false);
  });

  it("ignores portaled targets whose DOM chain never meets the scroller", () => {
    // A dropdown floating over the feed bubbles through React's tree but its
    // DOM parents are the portal root — even its own scrollable listbox must
    // not detach the reader from the transcript.
    const listbox = node("auto", node("visible", null));
    const target = node("visible", listbox);
    const scroller = scrollerNode();

    expect(wheelDetachesFollowing({ deltaY: -40, target, scroller, overflowYOf })).toBe(false);
  });

  it("is inert before the library mounts the scroller or without an element target", () => {
    const scroller = scrollerNode();

    expect(
      wheelDetachesFollowing<FakeNode>({
        deltaY: -40,
        target: node("auto"),
        scroller: null,
        overflowYOf,
      }),
    ).toBe(false);
    expect(wheelDetachesFollowing({ deltaY: -40, target: null, scroller, overflowYOf })).toBe(
      false,
    );
  });
});
