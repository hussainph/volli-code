// @vitest-environment jsdom
/**
 * VC-385 — an unsaved description edit belongs to the ticket that wrote it.
 *
 * This is the guarantee `home-surface.tsx` buys today by keying the whole
 * ticket workspace on `ticket.id`: a switch destroys the editor, and the
 * destruction flushes the pending autosave from a closure that still names the
 * old ticket. It works, and it costs a full rebuild of the workspace on every
 * switch — which is the cost VC-385 exists to cut.
 *
 * So the rule is held HERE instead, at the editor that owns the draft, where
 * it is true whether or not anything above it remounts. Both arms matter: the
 * one the key already covers, and the one that only holds if the editor itself
 * knows which ticket its draft was typed for.
 *
 * Monaco is stubbed because it cannot run in jsdom and because it is not what
 * is under test — the document editor is a system boundary here, and the seam
 * that matters is the `onChange` it calls and the `updateTicket` the host
 * issues. Everything between those two is real: the debouncer, the refs, the
 * board store's action.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Ticket } from "@volli/shared";

vi.mock("@renderer/components/editor/monaco-document-editor", () => ({
  MonacoDocumentEditor: ({
    value,
    onChange,
    ariaLabel,
  }: {
    value: string;
    onChange(next: string): void;
    ariaLabel?: string;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

// The body editor clears the registry's dirty flag through the Monaco runtime.
// In jsdom there is no runtime and nothing to clear; the ticket's bytes still
// have to reach the store, which is what this file is about.
vi.mock("@renderer/editor/monaco-runtime", () => ({
  loadMonacoRuntime: () => Promise.reject(new Error("no Monaco in jsdom")),
}));

import { TicketBodyEditor } from "./ticket-body-editor";
import { useBoardStore } from "@renderer/stores/board";

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "ticket-a",
    projectId: "p1",
    displayId: 1,
    title: "First ticket",
    body: "original body",
    status: "todo",
    priority: "none",
    index: 0,
    labels: [],
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    usesWorktree: false,
    ...overrides,
  } as Ticket;
}

let container: HTMLElement;
let root: Root;
let updateTicket: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  updateTicket = vi.fn(() => Promise.resolve({ ok: true }));
  useBoardStore.setState({ updateTicket } as never);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function type(text: string): void {
  const textarea = container.querySelector("textarea");
  if (textarea === null) throw new Error("the body editor rendered no input");
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("TicketBodyEditor autosave ownership", () => {
  it("flushes a pending edit to the ticket that authored it when the workspace goes away", () => {
    act(() => root.render(<TicketBodyEditor ticket={ticket()} />));

    type("edited before the switch");
    act(() => root.unmount());

    expect(updateTicket).toHaveBeenCalledWith({
      ticketId: "ticket-a",
      body: "edited before the switch",
    });
  });

  it("saves to the authoring ticket even when the same editor is handed the next one", () => {
    // The unkeyed switch: this editor is not destroyed, it is simply told it is
    // now showing a different ticket while a draft for the previous one is
    // still pending. The draft is ticket-a's; nothing about being shown
    // ticket-b makes it ticket-b's.
    act(() => root.render(<TicketBodyEditor ticket={ticket()} />));
    type("edited before the switch");

    act(() =>
      root.render(<TicketBodyEditor ticket={ticket({ id: "ticket-b", body: "b body" })} />),
    );

    expect(updateTicket).toHaveBeenCalledWith({
      ticketId: "ticket-a",
      body: "edited before the switch",
    });
    expect(updateTicket).not.toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: "ticket-b" }),
    );
  });
});
