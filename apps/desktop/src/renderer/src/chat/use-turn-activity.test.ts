import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
// @ts-expect-error — jsdom's constructor is typed at runtime in the renderer test harness.
import { JSDOM } from "jsdom";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UIMessage } from "ai";
import { ACTIVITY_METADATA_KEY } from "@volli/shared";
import { useTurnActivity } from "./use-turn-activity";
import type { TurnActivity, TurnActivityInput } from "./turn-activity";

let root: Root;
let value: TurnActivity | null;
let sessionId: string;
let state: TurnActivityInput;
function Probe() {
  value = useTurnActivity(sessionId, state);
  return null;
}
async function render() {
  await act(async () => root.render(createElement(StrictMode, null, createElement(Probe))));
}
async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTime(ms));
}
function command(commandText = "long-command", done = false): UIMessage {
  const base = {
    type: "dynamic-tool" as const,
    toolName: "volli.activity",
    toolCallId: "call-1",
    input: { command: commandText },
    toolMetadata: {
      [ACTIVITY_METADATA_KEY]: {
        kind: "run-command",
        nativeToolName: "bash",
        subject: { label: commandText, path: null, lineRange: null },
        outcome: null,
        startedAt: 1,
        endedAt: done ? 2 : null,
      },
    },
  };
  return {
    id: "tool-message",
    role: "assistant",
    parts: [
      done
        ? { ...base, state: "output-available", output: {} }
        : { ...base, state: "input-available" },
    ],
  };
}
beforeEach(() => {
  const dom = new JSDOM("<div id=app></div>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("navigator", dom.window.navigator);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  root = createRoot(dom.window.document.querySelector("#app")!);
  sessionId = "session";
  state = { messages: [], working: true, turnActive: true, projection: null, liveCompaction: null };
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useTurnActivity", () => {
  it("opens with Mulling and escalates once after twenty seconds in StrictMode", async () => {
    await render();
    expect(value).toMatchObject({ word: "Mulling", payload: null, announcement: "Reasoning" });
    await advance(19_999);
    expect(value?.word).toBe("Mulling");
    await advance(1);
    expect(value?.word).toBe("Deep in thought");
    const key = value?.key;
    await render();
    await advance(20_000);
    expect(value).toMatchObject({ key, word: "Deep in thought", announcement: "Reasoning" });
  });
  it("does not cycle words or restart a command's clock on streaming input updates", async () => {
    state.messages = [command()];
    await render();
    const word = value?.word;
    await advance(10_000);
    state.messages = [command("long-command --more-args")];
    await render();
    expect(value?.word).toBe(word);
    await advance(10_000);
    expect(value).toMatchObject({
      word: "Still running",
      payload: "long-command --more-args",
      announcement: "Running long-command --more-args",
    });
  });
  it("starts a fresh dwell when tools settle, without inheriting the command's age", async () => {
    state.messages = [command()];
    await render();
    await advance(19_000);
    state.messages = [command("long-command", true)];
    await render();
    expect(value?.word).toBe("Mulling");
    await advance(1_000);
    expect(value?.word).toBe("Mulling");
    await advance(19_000);
    expect(value?.word).toBe("Deep in thought");
  });
  it("never escalates tests, builds, replies or user waits", async () => {
    for (const message of [
      command("pnpm test"),
      command("pnpm build"),
      {
        id: "reply",
        role: "assistant",
        parts: [{ type: "text", text: "reply", state: "streaming" }],
      } as UIMessage,
    ]) {
      state.messages = [message];
      await render();
      const word = value?.word;
      await advance(25_000);
      expect(value?.word).toBe(word);
    }
    state.projection = {
      turnActive: true,
      interactions: { active: [{ id: "q", kind: "question" }] },
    };
    await render();
    await advance(25_000);
    expect(value).toMatchObject({ activity: "askUser", word: "Asking", waiting: true });
  });
  it("cancels on idle/paused inputs and does not leak an expired timer into another Session", async () => {
    await render();
    await advance(19_000);
    state = { ...state, working: false, turnActive: false, projection: null };
    await render();
    expect(value).toBeNull();
    await advance(20_000);
    expect(value).toBeNull();
    sessionId = "another-session";
    state = { ...state, working: true };
    await render();
    expect(value?.word).toBe("Mulling");
    await advance(1_000);
    expect(value?.word).toBe("Mulling");
  });
  it("does not resurrect an old escalation after a wait interrupts reasoning", async () => {
    await render();
    await advance(20_000);
    state.projection = {
      turnActive: true,
      interactions: { active: [{ id: "q", kind: "question" }] },
    };
    await render();
    state.projection = null;
    await render();
    expect(value?.word).toBe("Mulling");
    await advance(20_000);
    expect(value?.word).toBe("Deep in thought");
  });
});
