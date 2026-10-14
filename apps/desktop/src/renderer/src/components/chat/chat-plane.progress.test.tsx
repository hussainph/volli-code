// @vitest-environment jsdom
/** Visible progress is exclusive; the accessible turn never blinks. */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MotionGlobalConfig } from "motion/react";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ChatTurn, PendingMessage, TurnRunningMark, type TurnContext } from "./chat-plane";
import { liveTurnHasProgress } from "./chat-plane-model";

const context: TurnContext = { onOpenFile: () => {}, interactions: new Map() };
const user: UIMessage = {
  id: "user",
  role: "user",
  parts: [{ type: "text", text: "Keep these words" }],
};
const assistant = (parts: UIMessage["parts"]): UIMessage[] => [
  { id: "assistant", role: "assistant", parts },
];
const thought: UIMessage["parts"][number] = {
  type: "reasoning",
  text: "Considering the change",
  state: "streaming",
};
const runningTool: UIMessage["parts"][number] = {
  type: "dynamic-tool",
  toolName: "bash",
  toolCallId: "shell",
  state: "input-available",
  input: { command: "long-running check" },
};
const finishedTool: UIMessage["parts"][number] = {
  ...runningTool,
  state: "output-available",
  output: "done",
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  MotionGlobalConfig.skipAnimations = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  MotionGlobalConfig.skipAnimations = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const render = async (node: ReactNode) => {
  await act(async () => root.render(node));
};
const advance = async (ms: number) => {
  await act(async () => vi.advanceTimersByTime(ms));
};
const footer = () => container.querySelector('[data-slot="message-delivery"]');
const visualMark = () => container.querySelector('[role="status"] > [aria-hidden]');

describe("the live turn's actual visible progress", () => {
  it.each([
    ["no live turn", null, false],
    ["empty turn", [], false],
    ["user message", [user], false],
    ["streaming thought", assistant([thought]), true],
    ["running shell", assistant([runningTool]), true],
    ["preliminary long-running output", assistant([{ ...finishedTool, preliminary: true }]), true],
    [
      "completed background receipt",
      assistant([{ ...finishedTool, output: "Moved command to background shell shell-1." }]),
      false,
    ],
    ["tool input streaming", assistant([{ ...runningTool, state: "input-streaming" }]), true],
    ["settled tool", assistant([finishedTool]), false],
    ["stale streaming thought before settled tool", assistant([thought, finishedTool]), false],
    [
      "stale streaming thought before settled reply",
      assistant([thought, { type: "text", text: "Done", state: "done" }]),
      false,
    ],
    ["streaming reply", assistant([{ type: "text", text: "Answer", state: "streaming" }]), true],
    ["empty streaming text", assistant([{ type: "text", text: "", state: "streaming" }]), false],
    [
      "whitespace-only streaming text",
      assistant([{ type: "text", text: " \n", state: "streaming" }]),
      false,
    ],
    ["settled reply", assistant([{ type: "text", text: "Answer", state: "done" }]), false],
  ] as const)("%s", (_name, messages, expected) => {
    expect(liveTurnHasProgress(messages)).toBe(expected);
  });
});

describe("Working visual and screen-reader lifetimes", () => {
  it("shows immediately before progress and keeps the same accessible status during every visual transition", async () => {
    await render(<TurnRunningMark />);
    const status = container.querySelector('[role="status"]');
    const visual = visualMark();
    expect(status?.querySelector(".sr-only")?.textContent).toBe("Working");
    expect(visual?.classList.contains("invisible")).toBe(false);

    await render(<TurnRunningMark progressVisible />);
    expect(visualMark()).toBe(visual);
    expect(visual?.classList.contains("invisible")).toBe(true);
    await advance(1_000);
    expect(container.querySelector('[role="status"]')).toBe(status);
    expect(status?.querySelector(".sr-only")?.textContent).toBe("Working");

    await render(<TurnRunningMark progressVisible={false} />);
    await advance(299);
    expect(visual?.classList.contains("invisible")).toBe(true);
    await advance(1);
    expect(visual?.classList.contains("invisible")).toBe(false);
    expect(container.querySelector('[role="status"]')).toBe(status);
    expect(status?.querySelector(".sr-only")?.textContent).toBe("Working");
  });

  it("requires one continuous 300ms gap, not the sum of several short gaps", async () => {
    await render(<TurnRunningMark progressVisible />);
    expect(visualMark()?.classList.contains("invisible")).toBe(true);
    await render(<TurnRunningMark progressVisible={false} />);
    await advance(250);
    await render(<TurnRunningMark progressVisible />);
    await advance(100);
    expect(visualMark()?.classList.contains("invisible")).toBe(true);
    await render(<TurnRunningMark progressVisible={false} />);
    await advance(299);
    expect(visualMark()?.classList.contains("invisible")).toBe(true);
    await advance(1);
    expect(visualMark()?.classList.contains("invisible")).toBe(false);
    await render(<TurnRunningMark progressVisible />);
    expect(visualMark()?.classList.contains("invisible")).toBe(true);
  });

  it("does not revive Working after the turn unmounts during a gap", async () => {
    await render(<TurnRunningMark progressVisible />);
    await render(<TurnRunningMark progressVisible={false} />);
    await advance(100);
    await render(null);
    await advance(1_000);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

describe("calm message delivery timing", () => {
  it.each([
    ["send", "Sending…"],
    ["steer", "Sends after this step"],
    ["queue", "Queuing…"],
  ] as const)("delays %s state 600ms but never delays the words", async (delivery, copy) => {
    await render(
      <PendingMessage
        message={{ id: "pending", text: "Keep these words", state: "sending", delivery }}
        context={context}
      />,
    );
    expect(container.textContent).toContain("Keep these words");
    expect(footer()).toBeNull();
    await advance(599);
    expect(footer()).toBeNull();
    await advance(1);
    expect(footer()?.textContent).toBe(copy);
    expect(footer()?.closest(".is-user")).not.toBeNull();
    expect(container.textContent).not.toContain("Pending");
  });

  it("delays durable pending steering too, not only held messages", async () => {
    await render(
      <ChatTurn
        messages={[user]}
        context={{
          ...context,
          deliveryLabels: new Map([[user.id, "Pending"]]),
          steeringMessages: new Set([user.id]),
        }}
        live={false}
      />,
    );
    expect(footer()).toBeNull();
    await advance(599);
    expect(footer()).toBeNull();
    await advance(1);
    expect(footer()?.textContent).toBe("Sends after this step");
  });

  it("never flashes state for a send accepted before 600ms, including after its old deadline", async () => {
    const message = {
      id: "pending",
      text: "Keep these words",
      state: "sending" as const,
      delivery: "send" as const,
    };
    await render(<PendingMessage message={message} context={context} />);
    const bubble = container.querySelector(".is-user")?.firstElementChild;
    await advance(599);
    await render(
      <PendingMessage message={{ ...message, deliveryAccepted: true }} context={context} />,
    );
    expect(footer()).toBeNull();
    await advance(1_000);
    expect(footer()).toBeNull();
    expect(container.querySelector(".is-user")?.firstElementChild).toBe(bubble);
  });

  it("keeps an accepted queue distinguishable from steering after the delay", async () => {
    await render(
      <PendingMessage
        message={{
          id: "queue",
          text: "Later",
          state: "sending",
          delivery: "queue",
          deliveryAccepted: true,
        }}
        context={context}
      />,
    );
    expect(footer()).toBeNull();
    await advance(600);
    expect(footer()?.textContent).toBe("Queued");
  });

  it.each(["Not delivered", "Delivery unconfirmed"] as const)(
    "shows %s immediately even if pending has not reached its delay",
    async (label) => {
      await render(
        <ChatTurn messages={[user]} context={context} live={false} deliveryLabel="Sending…" />,
      );
      await advance(100);
      expect(footer()).toBeNull();
      await render(
        <ChatTurn messages={[user]} context={context} live={false} deliveryLabel={label} />,
      );
      expect(footer()?.textContent).toBe(label);
    },
  );

  it("starts a fresh delay when the same component receives a different message", async () => {
    await render(
      <PendingMessage
        message={{ id: "first", text: "First", state: "sending", delivery: "send" }}
        context={context}
      />,
    );
    await advance(600);
    expect(footer()?.textContent).toBe("Sending…");
    await render(
      <PendingMessage
        message={{ id: "second", text: "Second", state: "sending", delivery: "send" }}
        context={context}
      />,
    );
    expect(footer()).toBeNull();
    await advance(599);
    expect(footer()).toBeNull();
    await advance(1);
    expect(footer()?.textContent).toBe("Sending…");
  });
});
