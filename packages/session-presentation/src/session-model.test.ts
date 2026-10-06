import { describe, expect, it } from "vite-plus/test";

import {
  composerIntent,
  enqueueMessage,
  isUntitledChatSession,
  removeQueued,
  takeQueued,
  unqueueLast,
  queuedMessageFromHost,
} from "./session-model";

import { queuedWireMessage } from "./client";

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

  it("keeps a composed start's auto-title baseline on its opening message", () => {
    expect(
      enqueueMessage([], {
        id: "a",
        text: " begin ",
        autoTitleBaseline: "Work on VC-42",
      }),
    ).toEqual([
      {
        id: "a",
        text: "begin",
        autoTitleBaseline: "Work on VC-42",
      },
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

  // Unqueue and edit are the same gesture, and neither may lose the file the
  // row carried: the files come back WITH the words, for the strip to hold
  // again (VC-137).
  it("gives an unqueued message's attachments back with its words", () => {
    const attachments = [
      {
        linkId: "link-1",
        blobHash: "ab".repeat(32),
        label: "shot.png",
        originalName: "shot.png",
        mime: "image/png",
        sizeBytes: 2048,
      },
    ];
    const queue = [
      { id: "a", text: "first" },
      { id: "b", text: "second", attachments },
    ];

    expect(unqueueLast(queue)).toEqual({
      queue: [{ id: "a", text: "first" }],
      text: "second",
      attachments,
    });
    expect(takeQueued(queue, "b")).toEqual({
      queue: [{ id: "a", text: "first" }],
      text: "second",
      attachments,
    });
  });
});

describe("isUntitledChatSession", () => {
  it("makes only a missing title eligible for auto-naming", () => {
    expect(isUntitledChatSession(null)).toBe(true);
    expect(isUntitledChatSession("Chat 1")).toBe(false);
    expect(isUntitledChatSession("Migration plan")).toBe(false);
  });
});

describe("host queued message projection", () => {
  const attachment = {
    linkId: "link",
    blobHash: "ab".repeat(32),
    label: "shot",
    originalName: "shot.png",
    mime: "image/png",
    sizeBytes: 12,
  };
  it("round trips skills, files, and the guarded launch title for every Client", () => {
    const message = {
      id: "q1",
      text: "look /skill",
      resources: [{ name: "skill", text: "body" }],
      attachments: [attachment],
      autoTitleBaseline: "Launch",
    };
    expect(
      queuedMessageFromHost({
        id: "q1",
        commandId: "c1",
        message: queuedWireMessage(message),
        state: "releasing",
      }),
    ).toEqual({ ...message, commandId: "c1", queueState: "releasing" });
  });
  it("reads files from another Client without desktop metadata", () => {
    const message = {
      id: "q1",
      role: "user" as const,
      parts: [
        {
          type: "file" as const,
          url: `volli-blob:${attachment.blobHash}`,
          mediaType: "image/png",
          filename: "shot.png",
        },
        { type: "file" as const, url: `volli-blob:${"cd".repeat(32)}`, mediaType: "image/png" },
        { type: "file" as const, url: "https://example.com/shot.png", mediaType: "image/png" },
      ],
    };
    const row = queuedMessageFromHost({ id: "q1", commandId: "c1", message, state: "queued" });
    expect(row.attachments).toMatchObject([
      { linkId: null, originalName: "shot.png" },
      { linkId: null, originalName: "cd".repeat(32) },
    ]);
    expect(
      queuedMessageFromHost({
        id: "q1",
        commandId: "c1",
        message: { ...message, metadata: null },
        state: "queued",
      }),
    ).toEqual(row);
    expect(
      queuedMessageFromHost({
        id: "q1",
        commandId: "c1",
        message: { ...message, metadata: { attachments: [null] } },
        state: "queued",
      }),
    ).toEqual(row);
  });
});
