import { describe, expect, it } from "vite-plus/test";
import { createChatDraftsStore, isEmptyChatDraft } from "@renderer/stores/chat-drafts";
import { runnerStartIntent } from "./runner-picker-start";

const input = {
  projectId: "project",
  ticketId: null,
  operationId: "10000000-0000-4000-8000-000000000001",
  title: null,
};
const intent = runnerStartIntent(
  {
    clientRequestId: input.operationId,
    runnerId: "box",
    projectId: "project",
    ticketId: null,
    model: null,
  },
  { id: "message", text: "Build it" },
);
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("runner start Draft durability", () => {
  it("retains the immutable request and accepted backend id through restart, even with an empty composer", () => {
    const disk = storage();
    const store = createChatDraftsStore(disk);
    store.getState().openProvisional("draft", input);
    store.getState().setProvisionalRunner("draft", { id: "box", name: "Box" });
    store.getState().freezeRunnerStart("draft", { intent, accountScope: "account" });
    store.getState().acceptRunnerStart("draft", "remote-session");
    const restored = createChatDraftsStore(disk).getState().drafts.draft!;
    expect(restored.provisional?.runnerStart).toEqual({
      intent,
      accountScope: "account",
      sessionId: "remote-session",
    });
    expect(restored.provisional?.runnerChoice).toEqual({ id: "box", name: "Box" });
    expect(isEmptyChatDraft(restored)).toBe(false);
  });
  it("cannot redirect a held message or rewrite a submitted request", () => {
    const store = createChatDraftsStore(storage());
    const draft = store.getState;
    draft().openProvisional("draft", input);
    draft().setProvisionalRunner("draft", { id: "box", name: "Box" });
    draft().holdMessage("draft", { id: "message", text: "Build it" });
    draft().setProvisionalRunner("draft", { id: "other", name: "Other" });
    draft().freezeRunnerStart("draft", { intent, accountScope: "account" });
    draft().freezeRunnerStart("draft", {
      intent: { ...intent, runnerId: "other" },
      accountScope: "account",
    });
    draft().setProvisionalModel("draft", {
      providerId: "other",
      modelId: "other",
      reasoningLevel: "low",
    });
    expect(draft().drafts.draft?.provisional).toMatchObject({
      runnerChoice: { id: "box" },
      runnerStart: { intent },
    });
    expect(draft().drafts.draft?.provisional?.model).toBeUndefined();
  });
  it("a confirmed failure can restore the message under a fresh request id", () => {
    const store = createChatDraftsStore(storage());
    store.getState().openProvisional("draft", input);
    store.getState().freezeRunnerStart("draft", { intent, accountScope: "account" });
    store.getState().resetRunnerStart("draft", "Build it", "new-request");
    expect(store.getState().drafts.draft).toMatchObject({
      text: "Build it",
      held: [],
      provisional: { operationId: "new-request" },
    });
    expect(store.getState().drafts.draft?.provisional?.runnerStart).toBeUndefined();
  });
  it.each([null, "high"])(
    "round-trips a ticket start with model reasoning %s",
    (reasoningLevel) => {
      const disk = storage();
      const store = createChatDraftsStore(disk);
      store.getState().openProvisional("draft", input);
      const request = {
        ...intent,
        ticketId: "ticket",
        model: { providerId: "openai", modelId: "model", reasoningLevel },
      };
      store.getState().freezeRunnerStart("draft", { intent: request, accountScope: "account" });
      expect(createChatDraftsStore(disk).getState().drafts.draft?.provisional?.runnerStart).toEqual(
        { intent: request, accountScope: "account" },
      );
    },
  );
  it.each([
    { intent: null, accountScope: "account" },
    { intent, accountScope: 1 },
    ...["clientRequestId", "runnerId", "projectId", "ticketId", "body"].map((key) => ({
      intent: { ...intent, [key]: 1 },
      accountScope: "account",
    })),
    ...[
      undefined,
      1,
      { providerId: 1 },
      { providerId: "p", modelId: 1 },
      { providerId: "p", modelId: "m", reasoningLevel: 1 },
    ].map((model) => ({ intent: { ...intent, model }, accountScope: "account" })),
  ])("ignores an unreadable persisted request without losing the words: %j", (runnerStart) => {
    const disk = storage();
    disk.setItem(
      "volli:chat-drafts",
      JSON.stringify({
        version: 1,
        state: {
          drafts: {
            draft: {
              text: "Keep my words",
              attachments: [],
              held: [],
              touchedAt: 1,
              provisional: { ...input, phase: "draft", runnerStart },
            },
          },
        },
      }),
    );
    const restored = createChatDraftsStore(disk).getState().drafts.draft!;
    expect(restored.text).toBe("Keep my words");
    expect(restored.provisional?.runnerStart).toBeUndefined();
  });
  it.each([
    { id: 1, name: "Box" },
    { id: "box", name: 1 },
  ])("ignores an unreadable runner label: %j", (runnerChoice) => {
    const disk = storage();
    disk.setItem(
      "volli:chat-drafts",
      JSON.stringify({
        version: 1,
        state: {
          drafts: {
            draft: {
              text: "Keep my words",
              attachments: [],
              held: [],
              touchedAt: 1,
              provisional: { ...input, phase: "draft", runnerChoice },
            },
          },
        },
      }),
    );
    expect(
      createChatDraftsStore(disk).getState().drafts.draft?.provisional?.runnerChoice,
    ).toBeUndefined();
  });
  it("refuses runner mutations outside an editable Draft and cannot redirect a frozen empty start", () => {
    const store = createChatDraftsStore(storage());
    const draft = store.getState;
    draft().setDraft("ordinary", "text");
    draft().openProvisional("created", input);
    draft().markProvisionalSessionCreated("created");
    draft().markProvisionalSessionCreated("created");
    draft().markProvisionalSessionCreated("absent");
    draft().openProvisional("empty", input);
    for (const id of ["absent", "ordinary", "created"]) {
      draft().setProvisionalRunner(id, { id: "box", name: "Box" });
      draft().freezeRunnerStart(id, { intent, accountScope: "account" });
      draft().acceptRunnerStart(id, "remote");
      draft().resetRunnerStart(id, "changed", "new");
      expect(draft().drafts[id]?.provisional?.runnerStart).toBeUndefined();
    }
    draft().acceptRunnerStart("empty", "remote");
    draft().resetRunnerStart("empty", "changed", "new");
    draft().freezeRunnerStart("empty", { intent, accountScope: "account" });
    draft().setProvisionalRunner("empty", { id: "other", name: "Other" });
    expect(draft().drafts.empty?.provisional?.runnerChoice).toBeUndefined();
  });
  it("does not resurrect a closed Draft when a remote response arrives late", () => {
    const store = createChatDraftsStore(storage());
    store.getState().openProvisional("draft", input);
    store.getState().freezeRunnerStart("draft", { intent, accountScope: "account" });
    store.getState().discardProvisional("draft");
    store.getState().acceptRunnerStart("draft", "late-session");
    expect(store.getState().drafts).toEqual({});
  });
});
