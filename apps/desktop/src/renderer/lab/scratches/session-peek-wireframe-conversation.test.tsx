// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PeekConversation } from "./session-peek-wireframe-conversation";
import type { SessionFixture } from "./session-peek-wireframe-card";
import type { SendOutcome } from "./session-peek-wireframe-model";

const fixture: SessionFixture = {
  rowId: "first",
  sessionId: "first-id",
  sessionTitle: "First session",
  ticketId: null,
  ticketTitle: null,
  ticketStage: null,
  recency: "now",
  state: "idle",
  failure: null,
  lastActivity: "Generated summary, not source messages",
  question: null,
  model: { providerId: "anthropic", providerLabel: "Anthropic", modelId: "opus", label: "Opus" },
  messages: [{ role: "assistant", text: "Source conversation." }],
};
const other = {
  ...fixture,
  rowId: "second",
  sessionId: "second-id",
  sessionTitle: "Second session",
};
let host: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
const onOpen = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  onClose.mockClear();
  onOpen.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(value: SessionFixture | null = fixture, outcome: SendOutcome = "success") {
  await act(async () =>
    root.render(
      <PeekConversation
        fixture={value}
        outcome={outcome}
        onClose={onClose}
        onOpen={onOpen}
        returnFocus={() => null}
      />,
    ),
  );
}
const dialog = () => document.querySelector<HTMLElement>("[data-session-peek-dialog]")!;
const field = () => dialog().querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
const transcript = () => dialog().querySelector("[data-conversation-transcript]")!;
async function type(text: string) {
  const input = field();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function send() {
  await act(async () =>
    dialog().querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click(),
  );
}
async function settle() {
  await act(async () => vi.advanceTimersByTimeAsync(500));
}

describe("the shared conversation overlay's fixture composer", () => {
  it("renders source chat with the real composer and keeps drafts per recipient across closing", async () => {
    await render();
    expect(transcript().textContent).toContain("Source conversation.");
    expect(transcript().textContent).not.toContain("Generated summary");
    expect(dialog().textContent).toContain("Lab fixture · not a live session");
    await type("First draft");
    await render(null);
    expect(document.querySelector("[data-session-peek-dialog]")).toBeNull();
    await render(other);
    expect(field().value).toBe("");
    await type("Second draft");
    await render(fixture);
    expect(field().value).toBe("First draft");
    await render(other);
    expect(field().value).toBe("Second draft");
  });

  it("delivers once to the captured recipient even if the preview switches during sending", async () => {
    await render();
    await type("Only to the first session");
    await send();
    await send();
    expect(field().disabled).toBe(true);
    expect(transcript().textContent).not.toContain("Only to the first session");
    await render(other);
    await type("Keep second draft");
    await settle();
    expect(transcript().textContent).not.toContain("Only to the first session");
    expect(field().value).toBe("Keep second draft");
    await render(fixture);
    expect(field().value).toBe("");
    expect(transcript().textContent?.match(/Only to the first session/g)).toHaveLength(1);
  });

  it("retains a failed message for retry without claiming delivery", async () => {
    await render(fixture, "failure");
    await type("Do not lose this message");
    await send();
    await settle();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("Couldn’t send");
    expect(field().value).toBe("Do not lose this message");
    expect(transcript().textContent).not.toContain("Do not lose this message");
    await render(null);
    await render();
    expect(field().value).toBe("Do not lose this message");
    await send();
    await settle();
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
    expect(transcript().textContent).toContain("Do not lose this message");
    expect(field().value).toBe("");
  });

  it("finishes an in-flight fixture send while the overlay is closed", async () => {
    await render();
    await type("Send then close");
    await send();
    await render(null);
    await settle();
    await render();
    expect(field().value).toBe("");
    expect(transcript().textContent).toContain("Send then close");
  });
});
