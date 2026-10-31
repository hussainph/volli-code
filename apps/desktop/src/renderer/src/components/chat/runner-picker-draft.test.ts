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
  it("does not resurrect a closed Draft when a remote response arrives late", () => {
    const store = createChatDraftsStore(storage());
    store.getState().openProvisional("draft", input);
    store.getState().freezeRunnerStart("draft", { intent, accountScope: "account" });
    store.getState().discardProvisional("draft");
    store.getState().acceptRunnerStart("draft", "late-session");
    expect(store.getState().drafts).toEqual({});
  });
});
