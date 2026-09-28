// @vitest-environment jsdom
/**
 * The Now page's Properties block (VC-406 revision 05): the value is the
 * control, the row is not a target, and the label run is additive with its own
 * per-pill Remove.
 *
 * The rows carry NO field caption any more — no `Status`, `Priority` or
 * `Labels` in muted ink at the right edge. What that removal must not take
 * with it is checked here: the leading glyph, the accessible names the
 * controls and the label run carry, and the edits themselves.
 *
 * A real jsdom ENVIRONMENT rather than a static render, because what revision
 * 05 corrected is all behaviour: which store action an edit reaches, what the
 * Add control offers, the ORDER a run keeps across an append and a removal, and
 * where the focus lands afterwards. A static render would prove the markup and
 * none of it.
 *
 * The board store is driven through its own actions, replaced here with spies:
 * the write-through, the optimistic patch, the rollback and the failure toast
 * are the store's and are tested there — what this file owns is whether the
 * block asks for the right one, with the right arguments.
 */
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Label, Ticket } from "@volli/shared";

import { TicketProperties } from "./ticket-properties";
import { useBoardStore } from "@renderer/stores/board";

let root: Root | null = null;
let container: HTMLElement | null = null;

const TICKET: Ticket = {
  id: "t1",
  projectId: "p1",
  ticketNumber: 1,
  title: "Example",
  body: "",
  status: "todo",
  priority: "medium",
  labels: ["UI", "improvement"],
  usesWorktree: false,
  preferredHarnessId: "claude-code",
  order: 0,
  worktreePath: null,
  branch: null,
  baseBranch: null,
  prUrl: null,
  createdAt: 1,
  updatedAt: 1,
};

/** The project's real label rows — the vocabulary the Add control offers from. */
const LABELS: Label[] = [
  { id: "l1", projectId: "p1", name: "UI", color: null, createdAt: 1 },
  { id: "l2", projectId: "p1", name: "UX", color: null, createdAt: 1 },
  { id: "l3", projectId: "p1", name: "improvement", color: null, createdAt: 1 },
] as unknown as Label[];

const moveTicket = vi.fn();
const setTicketPriority = vi.fn();
const setLabels = vi.fn();

async function render(ticket: Ticket = TICKET) {
  await act(async () => {
    root?.render(<TicketProperties projectId="p1" ticket={ticket} />);
  });
}

function query<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`no element matching ${selector}`);
  return found;
}

/** A row's leading glyph wrapper: the decorative mark at the left of the line. */
function glyph(field: string): HTMLElement {
  const row = query<HTMLElement>(`[data-testid="ticket-rail-property-row-${field}"]`);
  const first = row.firstElementChild;
  if (!(first instanceof HTMLElement)) throw new Error(`no glyph on the ${field} row`);
  return first;
}

function pills(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-testid="ticket-rail-label-pill"]')];
}

/** The pill names, in the order the run draws them. */
function pillNames(): string[] {
  return pills().map((pill) => pill.dataset.label ?? "");
}

/** Radix opens a dropdown trigger on pointerdown, not on click. */
async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
    element.click();
  });
}

/** One row of an open menu or command list, by the words on its face. */
function optionRow(label: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>(
      '[data-slot="dropdown-menu-radio-item"],[cmdk-item=""]',
    ),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (found === undefined) throw new Error(`no option named ${label}`);
  return found;
}

/** Types into the open Add popover's field, as a person does. */
async function type(text: string): Promise<void> {
  const input = query<HTMLInputElement>('[data-slot="command-input"]');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setValue === undefined) throw new Error("no value setter");
  await act(async () => {
    setValue.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The words on every row of the open list. */
function offered(): string[] {
  return [...document.querySelectorAll('[cmdk-item=""]')].map(
    (row) => row.textContent?.trim() ?? "",
  );
}

async function choose(label: string): Promise<void> {
  const row = optionRow(label);
  await act(async () => {
    row.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    row.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
    row.click();
  });
}

/** cmdk observes its list; jsdom ships no `ResizeObserver`. */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  // cmdk keeps its selected row in view; jsdom lays nothing out.
  Element.prototype.scrollIntoView ??= () => {};
  moveTicket.mockReset();
  setTicketPriority.mockReset();
  setLabels.mockReset();
  useBoardStore.setState({
    labelsByProject: { p1: LABELS },
    ticketsByProject: { p1: [TICKET] },
    moveTicket,
    setTicketPriority,
    setLabels,
  } as unknown as Partial<ReturnType<typeof useBoardStore.getState>>);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

describe("the property rows", () => {
  it("draws the value as a 28px dropdown trigger, and no field caption beside it", async () => {
    await render();

    const status = query<HTMLButtonElement>('[data-testid="ticket-rail-property-status"]');
    const priority = query<HTMLButtonElement>('[data-testid="ticket-rail-property-priority"]');
    // The app's own compact trigger: 28px tall, sized to its label.
    expect(status.className).toContain("h-7");
    expect(priority.className).toContain("h-7");
    // The value is the only thing the row spends ink on.
    expect(status.textContent).toContain("Todo");
    expect(priority.textContent).toContain("Medium");
    // The caption that used to trail each row is gone from all three — the
    // glyph at the left already says which field the line is.
    for (const [field, word] of [
      ["status", "Status"],
      ["priority", "Priority"],
      ["labels", "Labels"],
    ] as const) {
      expect(query(`[data-testid="ticket-rail-property-row-${field}"]`).textContent).not.toContain(
        word,
      );
    }
    // Nothing beside the control names the field, so the control still does:
    // "Todo" alone names no field.
    expect(status.getAttribute("aria-label")).toBe("Status: Todo");
    expect(priority.getAttribute("aria-label")).toBe("Priority: Medium");
  });

  it("keeps the leading glyph, decorative beside the control that names the field", async () => {
    await render();

    for (const field of ["status", "priority", "labels"]) {
      const mark = glyph(field);
      expect(mark.querySelector('svg, [role="img"]')).not.toBeNull();
      expect(mark.getAttribute("aria-hidden")).toBe("true");
    }
    // `PriorityIndicator` is a labelled `img`: hidden, it cannot say
    // "Priority: Medium" a second time beside the trigger that says it.
    const indicator = query('[role="img"][aria-label="Priority: Medium"]');
    expect(indicator.closest("[aria-hidden]")).toBe(glyph("priority"));
  });

  it("is not itself a target: the row holds one control and answers no press", async () => {
    await render();

    const row = query('[data-testid="ticket-rail-property-row-status"]');
    // Exactly one pressable thing on the line — the value. A row that hovered
    // and opened a side picker is what revision 05 corrected.
    expect(row.querySelectorAll("button")).toHaveLength(1);
    expect(row.tagName).toBe("LI");
    expect(row.className).not.toContain("hover:bg-accent");
  });

  it("writes a status change through the board's own move, side effects and all", async () => {
    await render();
    await press(query<HTMLElement>('[data-testid="ticket-rail-property-status"]'));
    await choose("Doing");

    // `moveTicket` rather than a field write: the column move is what arms the
    // Automation the block three rows down marks Armed.
    expect(moveTicket).toHaveBeenCalledWith("p1", "t1", "doing", Number.MAX_SAFE_INTEGER);
    expect(setTicketPriority).not.toHaveBeenCalled();
  });

  it("writes a priority change through the board store", async () => {
    await render();
    await press(query<HTMLElement>('[data-testid="ticket-rail-property-priority"]'));
    await choose("High");

    expect(setTicketPriority).toHaveBeenCalledWith("p1", "t1", "high");
    expect(moveTicket).not.toHaveBeenCalled();
  });
});

describe("the label run", () => {
  it("draws one removable pill per label, in the ticket's own order", async () => {
    await render();

    expect(pillNames()).toEqual(["UI", "improvement"]);
    for (const name of pillNames()) {
      expect(document.querySelector(`[aria-label="Remove ${name}"]`)).not.toBeNull();
    }
    expect(query('[data-testid="ticket-rail-label-run"]').getAttribute("aria-label")).toBe(
      "Labels: UI, improvement",
    );
  });

  // VC-406 follow-up: Add is its glyph. The word beside the `+` sat on a line
  // of NAMES, where it read at a glance as a label called Add, and it spent
  // rail width saying what the universal mark already said. What the removal
  // must not take with it is checked here — both names, the glyph, the size of
  // the target, and the field the press opens.
  it("draws Add as a bare glyph, still named for the pointer and the screen reader", async () => {
    await render();
    const add = query<HTMLButtonElement>('[data-testid="ticket-rail-label-add"]');

    // No visible word on its face, and none anywhere in the run but the labels'
    // own names.
    expect(add.textContent?.trim()).toBe("");
    expect(query('[data-testid="ticket-rail-label-run"]').textContent).not.toContain("Add");
    expect(add.querySelector("svg")).not.toBeNull();
    // The two names a reader without the glyph is served by.
    expect(add.getAttribute("aria-label")).toBe("Add label");
    expect(add.getAttribute("title")).toBe("Add label");
    // Square at the run's own 24px height rather than a shrunken pill: dropping
    // the text must not shrink what a pointer has to hit.
    expect(add.className).toContain("size-6");
    // …and it still opens the field it always did.
    await press(add);
    expect(offered()).toContain("UX");
  });

  it("offers only what is not applied, and appends it to the end of the run", async () => {
    await render();
    await press(query<HTMLElement>('[data-testid="ticket-rail-label-add"]'));

    // The project knows UI, UX and improvement; two are applied.
    expect(offered()).toContain("UX");
    expect(offered()).not.toContain("UI");
    expect(offered()).not.toContain("improvement");

    await choose("UX");
    // Additive, left to right: appended, never re-sorted.
    expect(setLabels).toHaveBeenCalledWith("t1", ["UI", "improvement", "UX"]);
  });

  it("still creates once every label the project knows is applied", async () => {
    // A project's vocabulary being spent is the common case on a young board,
    // not the end of labelling: the field behind Add is how a label is MADE.
    // The control used to go dead here, which took the create path away exactly
    // when it was the only one left.
    await render({ ...TICKET, labels: ["UI", "UX", "improvement"] });

    const add = query<HTMLButtonElement>('[data-testid="ticket-rail-label-add"]');
    expect(add.disabled).toBe(false);
    expect(add.getAttribute("title")).toBe("Add label");

    await press(add);
    // Nothing known is left to offer, and the empty state says what remains.
    expect(offered()).toEqual([]);
    expect(document.body.textContent).toContain("Type a new label name");

    await type("spike");
    await choose("Create \u201cspike\u201d");
    expect(setLabels).toHaveBeenCalledWith("t1", ["UI", "UX", "improvement", "spike"]);
  });

  it("creates the first label of a project that has none", async () => {
    useBoardStore.setState({ labelsByProject: { p1: [] } } as unknown as Partial<
      ReturnType<typeof useBoardStore.getState>
    >);
    await render({ ...TICKET, labels: [] });

    await press(query<HTMLElement>('[data-testid="ticket-rail-label-add"]'));
    await type("triage");
    await choose("Create \u201ctriage\u201d");

    expect(setLabels).toHaveBeenCalledWith("t1", ["triage"]);
  });

  it("refuses to mint a second spelling of a name the project already knows", async () => {
    // `newLabelFromQuery`'s rule, reaching this surface: `ui` where `UI` exists
    // offers the existing label rather than a second casing of it — and here UI
    // is applied, so the honest answer is no row at all.
    await render();
    await press(query<HTMLElement>('[data-testid="ticket-rail-label-add"]'));
    await type("ui");

    expect(offered().some((row) => row.startsWith("Create"))).toBe(false);

    // The unapplied vocabulary is still reachable by the same field.
    await type("u");
    expect(offered()).toContain("UX");
  });

  it("removes one label and keeps the rest in order", async () => {
    await render({ ...TICKET, labels: ["UI", "UX", "improvement"] });
    await act(async () => {
      query<HTMLElement>('[aria-label="Remove UX"]').click();
    });

    expect(setLabels).toHaveBeenCalledWith("t1", ["UI", "improvement"]);
  });

  it("leaves focus on the pill that slid into the removed one's place", async () => {
    // The store's optimistic patch is what re-renders the run in the app; here
    // the write is spied, so the re-render is performed explicitly with the
    // labels the block asked for.
    await render({ ...TICKET, labels: ["UI", "UX", "improvement"] });
    await act(async () => {
      query<HTMLElement>('[aria-label="Remove UI"]').click();
    });
    await render({ ...TICKET, labels: ["UX", "improvement"] });

    expect(document.activeElement?.getAttribute("aria-label")).toBe("Remove UX");
  });

  it("falls back to the last pill when the removed one was last", async () => {
    await render({ ...TICKET, labels: ["UI", "UX"] });
    await act(async () => {
      query<HTMLElement>('[aria-label="Remove UX"]').click();
    });
    await render({ ...TICKET, labels: ["UI"] });

    expect(document.activeElement?.getAttribute("aria-label")).toBe("Remove UI");
  });

  it("hands focus to Add when the run is emptied", async () => {
    await render({ ...TICKET, labels: ["UI"] });
    await act(async () => {
      query<HTMLElement>('[aria-label="Remove UI"]').click();
    });
    await render({ ...TICKET, labels: [] });

    expect(document.activeElement?.getAttribute("aria-label")).toBe("Add label");
  });
});
