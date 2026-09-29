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
// There is no runtime in jsdom, so the registry is a spy: what it is asked to
// clear is the second half of "this draft belongs to that ticket", and a wrong
// key there parks a document dirty forever rather than losing bytes.
const peek = vi.fn(() => ({ markSaved: vi.fn() }));
vi.mock("@renderer/editor/monaco-runtime", () => ({
  loadMonacoRuntime: () => Promise.resolve({ registry: { peek } }),
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
  peek.mockClear();
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

  it("clears the authoring ticket's document, not the incoming ticket's project", async () => {
    // A draft is owned by a Monaco document, and a document is keyed by project
    // AND ticket. Holding only the ticket id was enough to send the right bytes
    // to the right ticket, but `markSaved` still resolved the key against
    // whatever project was on screen WHEN THE SAVE RAN — so a switch that
    // crosses projects peeked `{new project, old ticket}`, matched nothing, and
    // left the body document marked dirty for the life of the window. That is
    // the exact failure the clear exists to prevent.
    act(() => root.render(<TicketBodyEditor ticket={ticket()} />));
    type("edited in project one");

    act(() =>
      root.render(
        <TicketBodyEditor ticket={ticket({ id: "ticket-b", projectId: "p2", body: "b body" })} />,
      ),
    );
    await act(async () => {});

    expect(updateTicket).toHaveBeenCalledWith({
      ticketId: "ticket-a",
      body: "edited in project one",
    });
    expect(peek).toHaveBeenCalledWith({
      kind: "ticket-body",
      projectId: "p1",
      ticketId: "ticket-a",
    });
  });
});

/**
 * The guarantee above has one exception, and a guarantee whose boundary is
 * unnamed is worse than a narrower one that is stated.
 *
 * When the body changed underneath an unsaved draft, autosave PAUSES: the
 * surface is holding two versions and a background write would silently pick
 * one, so `planAutosave` returns `skip-conflicted` and the banner asks the
 * person to choose. A switch at that moment therefore saves nothing, and the
 * draft goes with the outgoing ticket.
 *
 * This is not a regression — it is exactly what unmounting does today, because
 * the unmount flush runs the same paused `save`. It is recorded here so the
 * exception is a decision with a test on it rather than a surprise, and so that
 * anyone who later decides a paused draft should survive a switch has to change
 * this test deliberately.
 */
describe("TicketBodyEditor autosave ownership — the conflict exception", () => {
  it("drops a pending draft across a switch while the conflict banner is up", () => {
    act(() => root.render(<TicketBodyEditor ticket={ticket()} />));
    type("my unsaved edit");

    // The body changes underneath the unsaved draft: a conflict, not an
    // adoption. Autosave is paused from here.
    act(() => root.render(<TicketBodyEditor ticket={ticket({ body: "rewritten by an agent" })} />));
    expect(container.textContent).toContain("Changed elsewhere. Autosave paused.");

    act(() =>
      root.render(<TicketBodyEditor ticket={ticket({ id: "ticket-b", body: "b body" })} />),
    );

    // Nothing was written for either ticket — and in particular the paused
    // draft was not quietly resolved in favour of the person's version.
    expect(updateTicket).not.toHaveBeenCalled();
  });
});
