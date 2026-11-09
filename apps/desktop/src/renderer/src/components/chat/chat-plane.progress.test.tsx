// @vitest-environment jsdom
/** The island owns progress; its former transcript row reserves bead clearance. */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MotionGlobalConfig } from "motion/react";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ChatTurn, PendingMessage, TurnRunningMark, type TurnContext } from "./chat-plane";

const context: TurnContext = { onOpenFile: () => {}, interactions: new Map() };
const user: UIMessage = {
  id: "user",
  role: "user",
  parts: [{ type: "text", text: "Keep these words" }],
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

describe("the turn's reserved transcript row", () => {
  it("reserves bead clearance without another Working line or live region", async () => {
    await render(<TurnRunningMark />);
    const row = container.querySelector("[data-turn-bead-clearance]");
    expect(row?.classList.contains("h-10")).toBe(true);
    expect(row?.getAttribute("aria-hidden")).toBe("true");
    expect(container.textContent).toBe("");
    expect(container.querySelector('[role="status"]')).toBeNull();
    await render(null);
    expect(container.querySelector("[data-turn-bead-clearance]")).toBeNull();
  });
});

describe("calm message delivery timing", () => {
  it.each([
    ["send", "Sending"],
    ["queue", "Queuing"],
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
    // In flight wears the shared spinner, in the in-flow footer beside Copy —
    // never an ellipsis, never a tab hung off the bubble.
    expect(footer()?.querySelector("svg.animate-spin")).not.toBeNull();
    const row = footer()?.closest('[data-slot="message-footer"]');
    expect(row?.querySelector('[aria-label="Copy message"]')).not.toBeNull();
    expect(row?.className).not.toContain("absolute");
    expect(footer()?.className).not.toContain("absolute");
    expect(container.textContent).not.toContain("Pending");
  });

  it("never adds a tab to held steering", async () => {
    await render(
      <PendingMessage
        message={{ id: "steer", text: "Keep these words", state: "sending", delivery: "steer" }}
        context={context}
      />,
    );
    await advance(5000);
    expect(container.textContent).toContain("Keep these words");
    expect(footer()).toBeNull();
  });

  it.each(["Pending", "Delivered", "Delivery unconfirmed"] as const)(
    "never shows durable %s plumbing, even after the local wait delay",
    async (label) => {
      await render(
        <ChatTurn
          messages={[user]}
          context={{
            ...context,
            deliveryLabels: new Map([[user.id, label]]),
          }}
          live={false}
        />,
      );
      expect(footer()).toBeNull();
      await advance(599);
      expect(footer()).toBeNull();
      await advance(1);
      expect(footer()).toBeNull();
    },
  );

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
    // A settled state is a chip, not a spinner.
    expect(footer()?.querySelector('[data-slot="badge"]')?.textContent).toBe("Queued");
    expect(footer()?.querySelector("svg.animate-spin")).toBeNull();
  });

  it("shows a durable refusal immediately even if the local wait has not reached its delay", async () => {
    await render(
      <ChatTurn messages={[user]} context={context} live={false} deliveryLabel="Sending" />,
    );
    await advance(100);
    expect(footer()).toBeNull();
    await render(
      <ChatTurn
        messages={[user]}
        context={{ ...context, deliveryLabels: new Map([[user.id, "Not delivered"]]) }}
        live={false}
      />,
    );
    expect(footer()?.textContent).toBe("Not delivered");
    // A refusal is a quiet chip whose mark carries the alarm.
    expect(footer()?.querySelector('[data-slot="badge"]')?.textContent).toBe("Not delivered");
    expect(footer()?.querySelector(".text-destructive")).not.toBeNull();
  });

  it("starts a fresh delay when the same component receives a different message", async () => {
    await render(
      <PendingMessage
        message={{ id: "first", text: "First", state: "sending", delivery: "send" }}
        context={context}
      />,
    );
    await advance(600);
    expect(footer()?.textContent).toBe("Sending");
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
    expect(footer()?.textContent).toBe("Sending");
  });
});
