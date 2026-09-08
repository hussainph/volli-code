/**
 * "Open that Session AT that question" — the second half of a notification
 * click (VC-295 round 2).
 */
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  onSessionItemReveal,
  preferRevealedInteraction,
  requestSessionItemReveal,
  takeSessionItemReveal,
} from "./session-item-reveal";

afterEach(() => {
  // The slot is module state; a request nobody claimed must not leak into the
  // next test any more than it may leak into the next click.
  takeSessionItemReveal("s1");
  takeSessionItemReveal("s2");
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
