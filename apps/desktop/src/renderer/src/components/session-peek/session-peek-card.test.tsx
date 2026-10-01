// @vitest-environment jsdom
/**
 * What the card shows, and what pressing it does.
 *
 * jsdom rather than static markup, because half of what this card is for is
 * acts: the pin that turns a read into a reply, the Send that behaves like the
 * composer's, and the one thing the card must NOT do — read the Session it is
 * describing (D6). A peek that quietly cleared an unread dot would look
 * identical in a screenshot and be exactly the bug VC-108 is about, so the
 * absence is asserted here against real presses.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  PERSON_STARTED,
  type RendererSessionInteraction,
  type SessionPeekContent,
  type Ticket,
} from "@volli/shared";

import { SessionPeekCard, type SessionPeekCardProps } from "./session-peek-card";
import type { SessionPeekRow } from "./use-session-peek";
import type { ModelCatalogue } from "@renderer/lib/use-model-catalogue";

const held = vi.hoisted(() => ({ catalogue: null as ModelCatalogue | null }));
vi.mock("@renderer/lib/use-model-catalogue", () => ({
  useModelCatalogue: () => held.catalogue,
}));

const NOW = 1_700_000_600_000;

let container: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  held.catalogue = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const TICKET: Ticket = {
  id: "tkt-14",
  projectId: "p1",
  ticketNumber: 14,
  title: "Sticky gutter marks lag a flick",
  body: "",
  status: "doing",
  priority: "medium",
  labels: [],
  usesWorktree: true,
  preferredHarnessId: "claude-code",
  order: 0,
  worktreePath: null,
  branch: null,
  baseBranch: null,
  prUrl: null,
  createdAt: 1,
  updatedAt: 1,
};

function row(overrides: Partial<SessionPeekRow> = {}): SessionPeekRow {
  return {
    rowId: "chat:chat-a1",
    sessionId: "chat-a1",
    title: "Gutter marks",
    ticket: TICKET,
    kind: "chat",
    state: "working",
    providerId: "anthropic",
    providerLabel: "Anthropic",
    at: NOW - 120_000,
    unread: false,
    model: { providerId: "anthropic", modelId: "claude-opus-5", reasoningLevel: "medium" },
    provenance: PERSON_STARTED,
    ...overrides,
  };
}

const QUESTION: RendererSessionInteraction = {
  id: "question:q1",
  attachmentId: "attach-1",
  kind: "question",
  title: "Which fix should land first?",
  detail: null,
  options: [
    { id: "question:0:c2Nyb2xs", label: "Recompute on scroll end", description: null },
    { id: "question:1:dmlld3BvcnQ", label: "Render from the virtual viewport", description: null },
  ],
  multiple: false,
  prompts: [
    {
      id: "prompt:0",
      label: "Which fix should land first?",
      detail: null,
      options: [
        { id: "question:0:c2Nyb2xs", label: "Recompute on scroll end", description: null },
        {
          id: "question:1:dmlld3BvcnQ",
          label: "Render from the virtual viewport",
          description: null,
        },
      ],
      multiple: false,
      custom: false,
    },
  ],
  native: { id: null, detail: null },
};

function content(overrides: Partial<SessionPeekContent> = {}): SessionPeekContent {
  return {
    sessionId: "chat-a1",
    entries: [
      { at: NOW - 200_000, role: "user", text: "Why do the marks lag?", tools: [] },
      { at: NOW - 180_000, role: "assistant", text: "", tools: ["read_file", "edit_file"] },
      {
        at: NOW - 120_000,
        role: "assistant",
        text: "The gutter recomputes from the DOM range, one frame behind the flick.",
        tools: [],
      },
    ],
    question: null,
    turns: 2,
    turnDepth: 1,
    unreadable: 0,
    lastActivityAt: NOW - 120_000,
    ...overrides,
  };
}

/** The card's ports, each as a mock typed by the prop it stands in for. */
function cardPorts(): {
  onPin: ReturnType<typeof vi.fn<() => void>>;
  onClose: ReturnType<typeof vi.fn<() => void>>;
  onOpen: ReturnType<typeof vi.fn<() => void>>;
  onViewConversation: ReturnType<typeof vi.fn<() => void>>;
  onAnswer: ReturnType<typeof vi.fn<SessionPeekCardProps["onAnswer"]>>;
  onSend: ReturnType<typeof vi.fn<SessionPeekCardProps["onSend"]>>;
} {
  return {
    onPin: vi.fn<() => void>(),
    onClose: vi.fn<() => void>(),
    onOpen: vi.fn<() => void>(),
    onViewConversation: vi.fn<() => void>(),
    onAnswer: vi.fn<SessionPeekCardProps["onAnswer"]>(() => Promise.resolve(true)),
    onSend: vi.fn<SessionPeekCardProps["onSend"]>(() => Promise.resolve(true)),
  };
}

type Spies = ReturnType<typeof cardPorts>;

function render(overrides: Partial<SessionPeekCardProps> = {}): Spies {
  const ports = cardPorts();
  root = createRoot(container);
  act(() => {
    root?.render(
      <SessionPeekCard
        row={row()}
        ticketPrefix="VLT"
        now={NOW}
        content={content()}
        loading={false}
        failed={false}
        position={{ left: 288, top: 120, maxHeight: 600 }}
        cardWidth={360}
        pinned={false}
        canReply
        {...ports}
        {...overrides}
      />,
    );
  });
  return ports;
}

/** The one button whose accessible name or text matches. */
function button(name: string | RegExp): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((candidate) => {
    const label = candidate.getAttribute("aria-label") ?? candidate.textContent ?? "";
    return typeof name === "string" ? label.includes(name) : name.test(label);
  });
  if (match === undefined) throw new Error(`no button matching ${String(name)}`);
  return match as HTMLButtonElement;
}

function press(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** jsdom implements no implicit form submission, so the form is asked directly. */
function submitForm(): void {
  const form = container.querySelector("form");
  if (form === null) throw new Error("no form");
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("identity", () => {
  it("leads with the mark, the title and the age", () => {
    render();
    expect(container.querySelector("[data-peek-session-title]")?.textContent).toBe("Gutter marks");
    expect(
      container.querySelector("[data-session-glyph]")?.getAttribute("data-session-glyph"),
    ).toBe("working");
    expect(container.textContent).toContain("2m ago");
  });

  it("says Unread in the row's own blue, and never reads it (D6)", () => {
    const spies = render({ row: row({ unread: true }) });
    const unread = container.querySelector("[data-peek-unread]");
    expect(unread?.textContent).toContain("Unread");
    expect(unread?.className).toContain("text-info");
    expect(unread?.querySelector("span")?.className).toContain("bg-info");
    // No read affordance exists on the card at all: the card takes no `setRead`
    // port, so a peek cannot clear a dot however long it stays up.
    expect(() => button(/read/i)).toThrow();
    expect(Object.values(spies).some((spy) => spy.mock.calls.length > 0)).toBe(false);
  });

  it("names the ticket it belongs to, with its column", () => {
    render();
    expect(container.textContent).toContain("VLT-14");
    expect(container.textContent).toContain("Doing");
    expect(container.querySelector("[data-peek-ticket-title]")?.textContent).toBe(
      "Sticky gutter marks lag a flick",
    );
  });

  it("carries what the row's dropped `title` attribute used to say (D1)", () => {
    render({
      row: row({
        provenance: { kind: "automation", automationName: "Nightly triage" },
      }),
    });
    const line = container.querySelector("[data-peek-identity]")?.textContent ?? "";
    expect(line).toContain("Anthropic");
    expect(line).toContain("claude-opus-5");
    expect(line).toContain("Automation · Nightly triage");
  });

  it("resolves the peek's model name and mark without losing provenance", () => {
    held.catalogue = {
      models: [
        {
          providerId: "anthropic",
          modelId: "claude-opus-5",
          label: "Claude Opus 5",
          state: "available",
          reasoningLevels: [],
          acceptsImageInput: true,
        },
      ],
      providers: [],
    };
    render({ row: row({ provenance: { kind: "automation", automationName: "Nightly triage" } }) });
    const identity = container.querySelector("[data-peek-identity]");
    expect(identity?.textContent).toContain(
      "Claude Opus 5 · Anthropic · Automation · Nightly triage",
    );
    expect(identity?.textContent).not.toContain("claude-opus-5");
    expect(identity?.querySelector("svg[aria-hidden] path")).not.toBeNull();
  });

  it("offers Close only while pinned", () => {
    render();
    expect(() => button("Close reply")).toThrow();
    act(() => root?.unmount());
    render({ pinned: true, content: content() });
    expect(button("Close reply")).toBeDefined();
  });
});

describe("the summary", () => {
  it("shows the full generated summary in non-shrinking blocks inside the scroller", () => {
    const summary = Array.from(
      { length: 12 },
      (_, index) => `Step ${index + 1}: the gutter now tracks the viewport without lag.`,
    ).join("\n");
    render({
      content: content({ summary, entries: [] }),
      position: { left: 288, top: 120, maxHeight: 240 },
    });
    const prose = container.querySelector("[data-peek-summary]");
    expect(prose?.textContent).toBe(summary);
    expect(prose?.className).not.toMatch(/line-clamp|truncate|overflow-hidden/);
    expect(prose?.classList.contains("whitespace-pre-wrap")).toBe(true);
    const body = prose?.closest(".overflow-y-auto");
    expect(body).not.toBeNull();
    expect(body?.classList.contains("min-h-0")).toBe(true);
    for (const block of body?.children ?? []) {
      expect(block.classList.contains("shrink-0")).toBe(true);
    }
    expect(container.querySelector<HTMLElement>("[data-peek-card]")?.style.maxHeight).toBe("240px");
  });

  it.each([undefined, null])(
    "shows the full durable-tail fallback when summary is %s",
    (summary) => {
      const text = "The gutter tracks the viewport. ".repeat(80);
      render({
        content: content({
          summary,
          entries: [{ at: NOW, role: "assistant", text, tools: [] }],
        }),
      });
      const prose = container.querySelector("[data-peek-summary]");
      expect(prose?.textContent).toBe(text);
      expect(prose?.className).not.toMatch(/line-clamp|truncate|overflow-hidden/);
      expect(prose?.closest(".overflow-y-auto")).not.toBeNull();
    },
  );

  it("prefers the generated summary over the transcript fallback", () => {
    render({ content: content({ summary: "The gutter fix is ready for review." }) });
    expect(container.querySelector("[data-peek-summary]")?.textContent).toBe(
      "The gutter fix is ready for review.",
    );
  });

  it("is the newest assistant words from the durable tail", () => {
    render();
    expect(container.querySelector("[data-peek-summary]")?.textContent).toBe(
      "The gutter recomputes from the DOM range, one frame behind the flick.",
    );
  });

  it("falls back to the tool names, never to invented prose", () => {
    render({
      content: content({
        entries: [{ at: NOW, role: "assistant", text: "", tools: ["read_file", "edit_file"] }],
      }),
    });
    expect(container.querySelector("[data-peek-summary]")?.textContent).toBe(
      "Ran read_file, edit_file",
    );
  });

  it("holds the box with a skeleton while the fold is in flight", () => {
    render({ content: null, loading: true });
    const block = container.querySelector("[data-summary-state]");
    expect(block?.getAttribute("data-summary-state")).toBe("loading");
    expect(block?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector("[data-slot='skeleton']")).not.toBeNull();
  });

  it("says so when the fold gave nothing readable", () => {
    render({ content: null, loading: false, failed: true });
    expect(container.textContent).toContain("Summary unavailable");
    expect(container.querySelector("[data-peek-summary]")).toBeNull();
  });

  it("counts the messages it could not read rather than shortening the tail silently", () => {
    render({ content: content({ unreadable: 2 }) });
    expect(container.querySelector("[data-peek-unreadable]")?.textContent).toBe(
      "Some messages could not be read",
    );
  });
});

describe("a question", () => {
  it("previews the ask while unpinned, and offers Answer", () => {
    const spies = render({ content: content({ question: QUESTION }) });
    expect(container.querySelector("[data-peek-question]")?.textContent).toBe(
      "Which fix should land first?",
    );
    // Unpinned there is no form: reading is not answering.
    expect(container.querySelector("form")).toBeNull();
    press(button("Answer"));
    expect(spies.onPin).toHaveBeenCalledTimes(1);
  });

  it("mounts the SHIPPED InteractionCard once pinned, not a form of its own", () => {
    render({ pinned: true, content: content({ question: QUESTION }), activeQuestion: QUESTION });
    // The shipped card's own controls, by their labels (interaction-ui.tsx).
    expect(container.textContent).toContain("Send answer");
    expect(container.textContent).toContain("Recompute on scroll end");
    // And the summary steps aside for it.
    expect(container.querySelector("[data-peek-summary]")).toBeNull();
    // No second Send in the footer: the shipped card owns submission.
    expect(() => button(/^Send$/)).toThrow();
  });

  it("says a question that has already been answered elsewhere was not delivered (§3.3)", async () => {
    // The override is asserted directly: the card was handed THIS mock, so the
    // refusal it reports is the one this port answered with.
    const onAnswer = vi.fn<SessionPeekCardProps["onAnswer"]>(() => Promise.resolve(false));
    render({
      pinned: true,
      content: content({ question: QUESTION }),
      activeQuestion: QUESTION,
      onAnswer,
    });
    press(button("Recompute on scroll end"));

    // jsdom fires no submit from a button press, so the card's own form is asked
    // directly — the same event its `Send answer` would have raised.
    submitForm();
    await act(async () => {
      await Promise.resolve();
    });
    expect(onAnswer).toHaveBeenCalledWith("question:q1", expect.anything());
    const answer = container.querySelector("[data-peek-refused]");
    expect(answer?.textContent).toBe("That question was already answered.");
  });
});

describe("the question a pinned card answers (§3.3)", () => {
  it("is the RESIDENT projection's, not the fold the pull happened to catch", () => {
    // The pull still carries the question it read; the Session's live
    // interactions no longer do, because it was answered in its own tab.
    render({ pinned: true, content: content({ question: QUESTION }), activeQuestion: null });

    // No form for a decision nobody is waiting on, and no preview line either:
    // what a pinned card with nothing to answer offers is a message.
    expect(container.textContent).not.toContain("Send answer");
    expect(container.querySelector("[data-peek-question]")).toBeNull();
    expect(container.querySelector("textarea")).not.toBeNull();
  });

  it("drives the form from the live question when the fold never saw one", () => {
    // The other order of the same race: the question opened after the pull.
    render({ pinned: true, content: content(), activeQuestion: QUESTION });
    expect(container.textContent).toContain("Send answer");
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("previews the pulled question while UNPINNED, whatever the projection holds", () => {
    render({ content: content({ question: QUESTION }), activeQuestion: null });
    expect(container.querySelector("[data-peek-question]")?.textContent).toBe(
      "Which fix should land first?",
    );
    expect(button("Answer")).toBeDefined();
  });
});

describe("a message", () => {
  /**
   * React tracks a field's last value on the node, so assigning `.value`
   * directly is deduped and no `onChange` ever fires. Going through the
   * prototype's own setter is what the tracker cannot see.
   */
  function type(text: string): void {
    const field = container.querySelector("textarea");
    if (field === null) throw new Error("no message field");
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    act(() => {
      setValue?.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("has nothing to send until something is typed", () => {
    render({ pinned: true });
    expect(button(/Send/).disabled).toBe(true);
    type("Land the scroll-end fix");
    expect(button(/Send/).disabled).toBe(false);
  });

  it("sends once, confirms, then closes — and offers no Undo (§3.2)", async () => {
    vi.useFakeTimers();
    const spies = render({ pinned: true });
    type("Land the scroll-end fix");
    submitForm();
    expect(spies.onSend).toHaveBeenCalledWith("Land the scroll-end fix");
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Sent");
    expect(container.textContent).not.toContain("Undo");
    expect(spies.onClose).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(spies.onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the words and offers a retry when the send did not land", async () => {
    const spies = render({
      pinned: true,
      onSend: vi.fn<SessionPeekCardProps["onSend"]>(() => Promise.resolve(false)),
    });
    type("Land the scroll-end fix");
    submitForm();
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector("[data-peek-send-error]")).not.toBeNull();
    expect(container.querySelector("textarea")?.value).toBe("Land the scroll-end fix");
    expect(button(/Try again/)).toBeDefined();
    expect(spies.onClose).not.toHaveBeenCalled();
  });

  it("treats a rejected send as a failure rather than losing the words", async () => {
    render({
      pinned: true,
      onSend: vi.fn<SessionPeekCardProps["onSend"]>(() => Promise.reject(new Error("offline"))),
    });
    type("Land the scroll-end fix");
    submitForm();
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector("[data-peek-send-error]")).not.toBeNull();
  });
});

describe("what a card cannot do", () => {
  it("offers a terminal companion nothing to answer and no transcript (§3.5)", () => {
    render({
      row: row({
        rowId: "session:pane-9",
        sessionId: "pane-9",
        kind: "terminal",
        state: "idle",
        providerId: "anthropic",
        providerLabel: "Claude Code",
        model: null,
      }),
      canReply: false,
      content: null,
    });
    expect(() => button(/Send|Answer/)).toThrow();
    expect(() => button("View conversation")).toThrow();
    expect(container.querySelector("[data-summary-state]")).toBeNull();
    // What it does have: identity, its ticket, and the way in.
    expect(button("Open session")).toBeDefined();
  });

  it("names the folder it was drilled from and says the ticket only once (D2)", () => {
    const back = vi.fn();
    render({ back: { ticketLabel: "VLT-14", onBack: back }, canReply: false });
    expect(container.querySelector("[data-peek-strip]")?.textContent).toContain("VLT-14");
    expect(container.querySelector("[data-peek-ticket-title]")).toBeNull();
    press(button("Back to VLT-14"));
    expect(back).toHaveBeenCalledTimes(1);
    // A drilled card is read-only: its recipient was never pointed at.
    expect(() => button(/Send|Answer/)).toThrow();
  });
});

describe("the ways out", () => {
  it("opens the Session and views the conversation through its ports", () => {
    const spies = render();
    press(button("Open session"));
    expect(spies.onOpen).toHaveBeenCalledTimes(1);
    press(button("View conversation"));
    expect(spies.onViewConversation).toHaveBeenCalledTimes(1);
  });

  it("closes from the header while pinned", () => {
    const spies = render({ pinned: true });
    press(button("Close reply"));
    expect(spies.onClose).toHaveBeenCalledTimes(1);
  });

  it("can be focused on request but never sits in the tab order", () => {
    // `Space` into a card, `Escape` out of a field and the drill's way back all
    // call `focus()` on this element: without a tabIndex every one is a no-op.
    render();
    const card = container.querySelector<HTMLElement>("[data-peek-card]")!;
    expect(card.getAttribute("tabindex")).toBe("-1");
    act(() => card.focus());
    expect(document.activeElement).toBe(card);
  });

  it("is a note when read and a dialog when pinned", () => {
    render();
    expect(container.querySelector("[data-peek-card]")?.getAttribute("role")).toBe("note");
    act(() => root?.unmount());
    render({ pinned: true });
    expect(container.querySelector("[data-peek-card]")?.getAttribute("role")).toBe("dialog");
  });
});
