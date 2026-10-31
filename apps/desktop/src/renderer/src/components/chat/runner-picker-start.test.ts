import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import type { CloudSession } from "@renderer/lib/cloud-client";
import {
  startOnRunner,
  runnerStartIntent,
  submitRunnerDraft,
  type RunnerStartIntent,
} from "./runner-picker-start";
import * as cloudClient from "@renderer/lib/cloud-client";
import { CHAT_DRAFTS_APP_STATE_KEY, useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { adoptLaunch } from "@renderer/stores/launch";
import { LOCAL_LAUNCH } from "@volli/shared";
import { seedAppStateCache, appStateStorage } from "@renderer/lib/app-state-storage";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  adoptLaunch(LOCAL_LAUNCH);
});

const intent: RunnerStartIntent = {
  clientRequestId: "20000000-0000-4000-8000-000000000001",
  runnerId: "20000000-0000-4000-8000-000000000002",
  projectId: "20000000-0000-4000-8000-000000000003",
  ticketId: null,
  body: "first-message-body",
  model: null,
};
function session(mutation: ReturnType<typeof vi.fn>, connected = true): CloudSession {
  return {
    client: { mutation, connectionState: () => ({ isWebSocketConnected: connected }) },
  } as unknown as CloudSession;
}

describe("start on runner", () => {
  it("encodes the plain message, not an artifact tied to a not-yet-known Session id", () => {
    const result = runnerStartIntent(intent, { id: "message", text: "Hello" });
    expect(JSON.parse(result.body)).toEqual({
      id: "message",
      role: "user",
      parts: [{ type: "text", text: "Hello" }],
    });
    expect(() => runnerStartIntent(intent, { id: "message", text: "x".repeat(65536) })).toThrow(
      "limited",
    );
  });
  it("persists before mutation, then retries a lost reply with the frozen request", async () => {
    adoptLaunch({
      store: "cloud",
      userId: "user",
      backendUrl: "https://example.convex.cloud",
      siteUrl: "https://example.convex.site",
    });
    const writes: string[] = [];
    vi.stubGlobal("window", {
      api: {
        appState: {
          set: vi.fn(async (_key, value: string) => {
            writes.push(value);
            return { ok: true };
          }),
        },
      },
    });
    useChatDraftsStore.setState({ drafts: {} });
    useChatDraftsStore.getState().openProvisional("draft", {
      projectId: intent.projectId,
      ticketId: null,
      operationId: intent.clientRequestId,
      title: null,
    });
    const mutation = vi
      .fn()
      .mockImplementationOnce(async () => {
        expect(writes.some((value) => value.includes("runnerStart"))).toBe(true);
        throw new Error("Lost reply");
      })
      .mockResolvedValue({ sessionId: "backend-session" });
    vi.spyOn(cloudClient, "cloudSession").mockReturnValue(session(mutation));
    await expect(submitRunnerDraft("draft", intent)).rejects.toThrow("Lost reply");
    await expect(submitRunnerDraft("draft", { ...intent, runnerId: "other" })).resolves.toBe(true);
    expect(mutation.mock.calls.map((call) => call[1])).toEqual([intent, intent]);
    expect(useChatDraftsStore.getState().drafts.draft?.provisional?.runnerStart?.sessionId).toBe(
      "backend-session",
    );
    await expect(submitRunnerDraft("draft")).resolves.toBe(true);
    expect(mutation).toHaveBeenCalledTimes(2);
  });
  it("re-persists the same intent after failed storage and cold hydration before retrying", async () => {
    adoptLaunch({ store: "cloud", userId: "user", backendUrl: "https://example.convex.cloud" });
    const set = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "Disk unavailable" })
      .mockResolvedValue({ ok: true });
    vi.stubGlobal("window", { api: { appState: { set } } });
    useChatDraftsStore.setState({ drafts: {} });
    useChatDraftsStore.getState().openProvisional("draft", {
      projectId: intent.projectId,
      ticketId: null,
      operationId: intent.clientRequestId,
      title: null,
    });
    const mutation = vi
      .fn()
      .mockRejectedValueOnce(new Error("Lost reply"))
      .mockResolvedValue({ sessionId: "backend-session" });
    vi.spyOn(cloudClient, "cloudSession").mockReturnValue(session(mutation));
    await expect(submitRunnerDraft("draft", intent)).resolves.toBe(false);
    expect(mutation).not.toHaveBeenCalled();
    await expect(submitRunnerDraft("draft")).rejects.toThrow("Lost reply");
    // Seeding invalidates the write acknowledgement just as a new renderer's
    // boot does. A retry must schedule its own unchanged durable write.
    seedAppStateCache({
      [CHAT_DRAFTS_APP_STATE_KEY]: (await appStateStorage.getItem(CHAT_DRAFTS_APP_STATE_KEY))!,
    });
    const before = set.mock.calls.length;
    await expect(submitRunnerDraft("draft")).resolves.toBe(true);
    expect(set.mock.calls.length).toBeGreaterThan(before);
    expect(mutation.mock.calls.map((call) => call[1])).toEqual([intent, intent]);
  });
  it("addresses the person mutation and preserves the same intent for a lost-reply retry", async () => {
    const mutation = vi
      .fn()
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValue({ sessionId: "backend-session" });
    const current = () => session(mutation);
    await expect(startOnRunner(intent, current)).rejects.toThrow("Connection lost");
    await expect(startOnRunner(intent, current)).resolves.toBe("backend-session");
    expect(getFunctionName(mutation.mock.calls[0]![0])).toBe("sessionStarts:startOn");
    expect(mutation.mock.calls.map((call) => call[1])).toEqual([intent, intent]);
  });
  it("refuses a disconnected client before making a mutation", async () => {
    const mutation = vi.fn();
    await expect(startOnRunner(intent, () => null)).rejects.toThrow();
    await expect(startOnRunner(intent, () => session(mutation, false))).rejects.toThrow();
    expect(mutation).not.toHaveBeenCalled();
  });
});
