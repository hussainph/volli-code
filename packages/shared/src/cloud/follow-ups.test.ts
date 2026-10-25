import { describe, expect, test } from "vite-plus/test";
import {
  decodeCloudSessionIntent,
  isFollowUpIntent,
  followUpQueueView,
  type FollowUpIntent,
  type FollowUpMirrorItem,
  type FollowUpQueueJob,
} from "./follow-ups";

const reference = { id: "artifact", mediaType: null, digest: null };
const submit: FollowUpIntent = {
  kind: "message.submit",
  delivery: "queue",
  messageId: "m",
  reference,
};
const mirror: FollowUpMirrorItem = {
  messageId: "m",
  commandId: "c",
  state: "queued",
  message: "{}",
  messageDigest: "digest",
};
const job = (intent: FollowUpIntent, extra: Partial<FollowUpQueueJob> = {}): FollowUpQueueJob => ({
  intent,
  commandId: "c",
  status: "queued",
  neverLeased: true,
  ...extra,
});

describe("follow-up intent codec", () => {
  test("keeps runtime delivery separate from the durable event vocabulary", () => {
    expect(decodeCloudSessionIntent(submit)).toEqual(submit);
    expect(decodeCloudSessionIntent({ ...submit, delivery: "steer" })).toEqual({
      ...submit,
      delivery: "steer",
    });
    expect(
      decodeCloudSessionIntent({ kind: "message.submit", delivery: "steer", messageId: "m" }),
    ).toEqual({ kind: "message.submit", delivery: "steer", messageId: "m" });
    expect(decodeCloudSessionIntent({ kind: "message.submit", reference })).toEqual({
      kind: "message.submit",
      reference,
    });
    for (const kind of ["message.cancel", "message.edit"] as const) {
      const intent = { kind, messageId: "m", ...(kind === "message.edit" ? { reference } : {}) };
      expect(decodeCloudSessionIntent(intent)).toEqual(intent);
      expect(decodeCloudSessionIntent({ ...intent, expectedRevision: 1 })).toEqual({
        ...intent,
        expectedRevision: 1,
      });
      expect(isFollowUpIntent(decodeCloudSessionIntent(intent))).toBe(true);
    }
    expect(isFollowUpIntent(submit)).toBe(true);
    expect(isFollowUpIntent({ kind: "message.submit", reference })).toBe(false);
    expect(isFollowUpIntent({ kind: "session.retitle", title: "x" })).toBe(false);
  });
  test("rejects malformed controls and delegates regular intents to the real codec", () => {
    for (const bad of [
      null,
      false,
      "",
      [],
      {},
      { ...submit, messageId: "" },
      { ...submit, messageId: 3 },
      { ...submit, messageId: "x".repeat(513) },
      { ...submit, expectedRevision: -1 },
      { ...submit, expectedRevision: 1.5 },
      { ...submit, expectedRevision: "1" },
      { ...submit, delivery: "later" },
      { ...submit, reference: null },
    ])
      expect(() => decodeCloudSessionIntent(bad)).toThrow();
  });
});

describe("followUpQueueView", () => {
  test("preserves mirror order, dedupes open intake and never revives terminal work", () => {
    expect(followUpQueueView([], [], null)).toEqual([]);
    const items = followUpQueueView(
      [mirror],
      [
        job(submit),
        job({ ...submit, messageId: "n" }),
        job({ ...submit, messageId: "done" }, { status: "done" }),
      ],
      "online",
    );
    expect(items.map((i) => i.messageId)).toEqual(["m", "n"]);
    expect(items[1]).toMatchObject({
      message: null,
      messageDigest: "artifact",
      waitingForRunner: false,
    });
    expect(
      followUpQueueView(
        [],
        [job({ ...submit, reference: { ...reference, digest: "sha" } })],
        "asleep",
      )[0],
    ).toMatchObject({ messageDigest: "sha", waitingForRunner: true });
    expect(
      followUpQueueView([], [job(submit, { status: "leased", neverLeased: false })], "offline")[0]!
        .waitingForRunner,
    ).toBe(false);
    expect(
      followUpQueueView([], [job(submit, { neverLeased: false })], "offline")[0]!.waitingForRunner,
    ).toBe(false);
  });
  test("overlays edits/cancels only on extant items; a steer does not enqueue", () => {
    const edit: FollowUpIntent = { kind: "message.edit", messageId: "m", reference };
    const cancel: FollowUpIntent = { kind: "message.cancel", messageId: "m" };
    expect(followUpQueueView([mirror], [job(edit)], null)[0]!.pending).toBe("edit");
    expect(followUpQueueView([mirror], [job(cancel)], null)[0]!.pending).toBe("cancel");
    expect(
      followUpQueueView([mirror], [job({ ...submit, delivery: "steer" })], null)[0]!.pending,
    ).toBeNull();
    expect(
      followUpQueueView([], [job(edit), job(cancel), job({ ...submit, delivery: "steer" })], null),
    ).toEqual([]);
  });
});
