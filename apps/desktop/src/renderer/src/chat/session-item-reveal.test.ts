/**
 * "Open that Session AT that question" — the second half of a notification
 * click (VC-295 round 2).
 */
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  claimedSessionItem,
  onSessionItemReveal,
  preferRevealedInteraction,
  releaseSessionItemReveal,
  requestSessionItemReveal,
  subscribeClaimedSessionItems,
  takeSessionItemReveal,
} from "./session-item-reveal";

afterEach(() => {
  // The slot is module state; a request nobody claimed must not leak into the
  // next test any more than it may leak into the next click.
  takeSessionItemReveal("s1");
  takeSessionItemReveal("s2");
  releaseSessionItemReveal("s1");
  releaseSessionItemReveal("s2");
});

describe("the reveal slot", () => {
  it("hands a request to the Session it names, once", () => {
    requestSessionItemReveal("s1", { interactionId: "i1", attentionId: null });

    expect(takeSessionItemReveal("s1")).toEqual({ interactionId: "i1", attentionId: null });
    expect(takeSessionItemReveal("s1")).toBeNull();
  });

  it("refuses to hand one Session's request to another", () => {
    requestSessionItemReveal("s1", { interactionId: "i1", attentionId: null });

    expect(takeSessionItemReveal("s2")).toBeNull();
    expect(takeSessionItemReveal("s1")).not.toBeNull();
  });

  it("keeps only the newest request", () => {
    // Two alerts clicked in a row: the person means the second one, and an
    // unclaimed first must never surface later as a card that jumps.
    requestSessionItemReveal("s1", { interactionId: "i1", attentionId: null });
    requestSessionItemReveal("s1", { interactionId: "i2", attentionId: null });

    expect(takeSessionItemReveal("s1")).toEqual({ interactionId: "i2", attentionId: null });
  });

  it("tells a mounted plane a request has arrived for it", () => {
    // The already-open case: no mount happens, so the live plane is told
    // instead and claims the same slot.
    const seen: string[] = [];
    const off = onSessionItemReveal("s1", () => seen.push("s1"));
    const offOther = onSessionItemReveal("s2", () => seen.push("s2"));

    requestSessionItemReveal("s1", { interactionId: "i1", attentionId: null });

    expect(seen).toEqual(["s1"]);
    off();
    offOther();
    requestSessionItemReveal("s1", { interactionId: "i1", attentionId: null });
    expect(seen).toEqual(["s1"]);
  });
});

describe("two planes on one Session", () => {
  it("tells both, and unsubscribing one leaves the other listening", () => {
    // A Session can be on screen twice — a split view, or a ticket tab beside
    // Home's. Both are told; only one claim succeeds, which is the slot's job.
    const seen: string[] = [];
    const offA = onSessionItemReveal("s1", () => seen.push("a"));
    const offB = onSessionItemReveal("s1", () => seen.push("b"));

    requestSessionItemReveal("s1", { interactionId: "i1", attentionId: null });
    expect(seen).toEqual(["a", "b"]);

    offA();
    requestSessionItemReveal("s1", { interactionId: "i1", attentionId: null });
    expect(seen).toEqual(["a", "b", "b"]);
    offB();
  });
});

describe("what a plane is currently showing (round 4)", () => {
  /**
   * The claim's second reader is the window's own report to main. Without it,
   * the row drew the revealed Attention while the report named the primary —
   * and the alert for the primary, which is NOT on screen, was suppressed.
   */
  it("remembers what a plane claimed, until it releases it", () => {
    requestSessionItemReveal("s1", { interactionId: null, attentionId: "a1" });
    expect(claimedSessionItem("s1")).toBeNull();

    takeSessionItemReveal("s1");
    expect(claimedSessionItem("s1")).toEqual({ interactionId: null, attentionId: "a1" });

    releaseSessionItemReveal("s1");
    expect(claimedSessionItem("s1")).toBeNull();
  });

  it("keeps each Session's claim to itself", () => {
    requestSessionItemReveal("s1", { interactionId: null, attentionId: "a1" });
    takeSessionItemReveal("s1");

    expect(claimedSessionItem("s2")).toBeNull();
  });

  it("announces a claim and its release to whoever is reporting", () => {
    const beats: string[] = [];
    const off = subscribeClaimedSessionItems(() => beats.push("changed"));

    requestSessionItemReveal("s1", { interactionId: null, attentionId: "a1" });
    expect(beats).toEqual([]);
    takeSessionItemReveal("s1");
    expect(beats).toEqual(["changed"]);
    releaseSessionItemReveal("s1");
    expect(beats).toEqual(["changed", "changed"]);

    off();
    requestSessionItemReveal("s1", { interactionId: null, attentionId: "a2" });
    takeSessionItemReveal("s1");
    expect(beats).toEqual(["changed", "changed"]);
  });

  it("says nothing when a release had nothing to release", () => {
    const beats: string[] = [];
    const off = subscribeClaimedSessionItems(() => beats.push("changed"));

    releaseSessionItemReveal("s1");

    expect(beats).toEqual([]);
    off();
  });
});

describe("preferRevealedInteraction", () => {
  const cards = [{ id: "i1" }, { id: "i2" }, { id: "i3" }];

  it("puts the named question first so the card slot shows it", () => {
    expect(preferRevealedInteraction(cards, "i3").map(({ id }) => id)).toEqual(["i3", "i1", "i2"]);
  });

  it("leaves the order alone when nothing was named", () => {
    expect(preferRevealedInteraction(cards, null)).toBe(cards);
  });

  it("leaves the order alone when the named question is no longer open", () => {
    // The stale case reaches here too: the Session opens, the card slot shows
    // whatever IS open, and the toast explains the rest.
    expect(preferRevealedInteraction(cards, "gone")).toBe(cards);
  });

  it("leaves the order alone when the named question is already first", () => {
    expect(preferRevealedInteraction(cards, "i1")).toBe(cards);
  });
});
