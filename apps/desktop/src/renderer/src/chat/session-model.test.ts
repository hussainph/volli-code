import { describe, expect, it } from "vite-plus/test";

import {
  composerIntent,
  enqueueMessage,
  nextRelease,
  removeQueued,
  takeQueued,
  unqueueLast,
} from "./session-model";

describe("composer delivery", () => {
  it("reads ⏎ against session state, not a delivery control", () => {
    expect(composerIntent({ working: false, steer: false })).toBe("send");
    // ⌘ is meaningless while nothing is running: there is no turn to steer.
    expect(composerIntent({ working: false, steer: true })).toBe("send");
    expect(composerIntent({ working: true, steer: false })).toBe("queue");
    expect(composerIntent({ working: true, steer: true })).toBe("steer");
  });

  it("trims on the way in and refuses blank", () => {
    expect(enqueueMessage([], { id: "a", text: "  ship it  " })).toEqual([
      { id: "a", text: "ship it" },
    ]);
    expect(enqueueMessage([], { id: "a", text: "   " })).toEqual([]);
  });

  it("keeps attachments riding a queued message, and lets them carry it alone (VC-50)", () => {
    const attachments = [
      {
        linkId: "l1",
        blobHash: "a".repeat(64),
        label: "shot.png",
        originalName: "shot.png",
        mime: "image/png",
        sizeBytes: 12,
      },
    ];
    expect(enqueueMessage([], { id: "a", text: " look ", attachments })).toEqual([
      { id: "a", text: "look", attachments },
    ]);
    // A dropped screenshot with no words is a question, so an attachment makes
    // an otherwise-blank message real.
    expect(enqueueMessage([], { id: "b", text: "   ", attachments })).toEqual([
      { id: "b", text: "", attachments },
    ]);
    // ...but an empty attachment list does not.
    expect(enqueueMessage([], { id: "c", text: "  ", attachments: [] })).toEqual([]);
  });

  it("keeps the skill resources riding a queued message (VC-49)", () => {
    const resources = [{ name: "logos", text: "# Logos" }];
    expect(enqueueMessage([], { id: "a", text: " /logos go ", resources })).toEqual([
      { id: "a", text: "/logos go", resources },
    ]);
  });

  it("gives an unqueued message back rather than dropping it", () => {
    const queue = [
      { id: "a", text: "first" },
      { id: "b", text: "second" },
    ];
    expect(unqueueLast(queue)).toEqual({ queue: [{ id: "a", text: "first" }], text: "second" });
    expect(unqueueLast([])).toBeNull();
    expect(takeQueued(queue, "a")).toEqual({ queue: [{ id: "b", text: "second" }], text: "first" });
    expect(takeQueued(queue, "missing")).toBeNull();
    expect(removeQueued(queue, "a")).toEqual([{ id: "b", text: "second" }]);
  });

  it("drains one message, and only into an idle attached Session", () => {
    const queue = [
      { id: "a", text: "first" },
      { id: "b", text: "second" },
    ];
    expect(nextRelease(queue, { working: false, ready: true })).toEqual({ id: "a", text: "first" });
    expect(nextRelease(queue, { working: true, ready: true })).toBeNull();
    expect(nextRelease(queue, { working: false, ready: false })).toBeNull();
    expect(nextRelease([], { working: false, ready: true })).toBeNull();
  });
});
