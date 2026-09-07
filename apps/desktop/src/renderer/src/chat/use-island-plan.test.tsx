/**
 * The plan feed, bound for React (VC-6).
 *
 * Tested through the hook rather than through a component, because the hook IS
 * the seam VC-268 spreads into `useActivityIsland`: what it owes is a plan that
 * tracks the Session's newest `todo_write` call and an identity that does not
 * move when nothing about the plan did.
 */
import { ACTIVITY_METADATA_KEY } from "@volli/shared";
import type { UIMessage } from "ai";
// The desktop owns jsdom for renderer tests, but does not ship its ambient types.
// @ts-expect-error — this test only uses the typed-at-runtime JSDOM constructor.
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { EMPTY_TRANSCRIPT, type ChatSessionTransport } from "@volli/session-presentation";
import type { IslandPlan } from "@volli/session-presentation";
import { createChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useIslandPlan } from "./use-island-plan";

const SESSION_ID = "durable-1";

const noTransport = (): ChatSessionTransport => ({}) as ChatSessionTransport;

let nextId = 0;

function todoCall(todos: readonly { content: string; status: string }[]): UIMessage {
  nextId += 1;
  return {
    id: `m-${nextId}`,
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "volli.activity",
        toolCallId: `call-${nextId}`,
        state: "output-available",
        input: { todos },
        output: { ok: true },
        toolMetadata: {
          [ACTIVITY_METADATA_KEY]: {
            kind: "plan",
            nativeToolName: "todo_write",
            subject: { label: null, path: null, lineRange: null },
            outcome: null,
            startedAt: null,
            endedAt: null,
          },
        },
      },
    ],
  } as UIMessage;
}

let root: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  const dom = new JSDOM("<div id=app></div>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("navigator", dom.window.navigator);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = dom.window.document.querySelector("#app") as HTMLElement;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  vi.unstubAllGlobals();
});

/** Mounts the hook against one store and reports every plan it produced. */
async function mount(store: ReturnType<typeof createChatSessionsStore>) {
  const seen: (IslandPlan | null)[] = [];
  function Probe() {
    seen.push(useIslandPlan(SESSION_ID, store));
    return null;
  }
  await act(async () => {
    root = createRoot(container);
    root.render(<Probe />);
  });
  return seen;
}

function seed(store: ReturnType<typeof createChatSessionsStore>, messages: readonly UIMessage[]) {
  store.setState({
    sessions: {
      [SESSION_ID]: {
        projection: null,
        transcript: { ...EMPTY_TRANSCRIPT, durableMessages: messages },
        lifecycle: "ready",
        sessionError: null,
        queue: [],
      },
    },
  });
}

describe("useIslandPlan", () => {
  it("has no plan for a Session that never wrote one", async () => {
    const store = createChatSessionsStore(noTransport);
    const seen = await mount(store);

    expect(seen.at(-1)).toBeNull();
  });

  it("draws the Session's newest list, and follows it when the model rewrites it", async () => {
    const store = createChatSessionsStore(noTransport);
    seed(store, [todoCall([{ content: "Read the ticket", status: "in_progress" }])]);
    const seen = await mount(store);

    expect(seen.at(-1)).toMatchObject({
      steps: [{ title: "Read the ticket", state: "in_progress" }],
      done: 0,
    });

    await act(async () => {
      seed(store, [
        todoCall([{ content: "Read the ticket", status: "in_progress" }]),
        todoCall([
          { content: "Read the ticket", status: "completed" },
          { content: "Write the tool", status: "in_progress" },
        ]),
      ]);
    });

    expect(seen.at(-1)).toMatchObject({
      steps: [
        { title: "Read the ticket", state: "completed" },
        { title: "Write the tool", state: "in_progress" },
      ],
      done: 1,
    });
  });

  it("keeps one plan object while the plan is unchanged, so the island does not re-render on it", async () => {
    // The island memoizes on this value: a fresh object per frame would put the
    // plan card into the streamed-frame budget for a plan nobody touched.
    const store = createChatSessionsStore(noTransport);
    const messages = [todoCall([{ content: "Read the ticket", status: "pending" }])];
    seed(store, messages);
    const seen = await mount(store);
    const first = seen.at(-1);

    await act(async () => {
      store.setState({ sessions: { ...store.getState().sessions } });
    });

    expect(seen.at(-1)).toBe(first);
  });
});
