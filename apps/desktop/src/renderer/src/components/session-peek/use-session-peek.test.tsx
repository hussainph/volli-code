// @vitest-environment jsdom
/**
 * The controller against a real DOM — the half of the peek no pure test reaches.
 *
 * Every case here was a bug the pure modules could not have caught, because each
 * one is about the controller's relationship with the document it was mounted
 * into: which element actually scrolls, whether `focus()` lands anywhere, what a
 * field inside a row means, and what happens to the hold when the row a card is
 * about stops existing. The reducer was correct in all four.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  PERSON_STARTED,
  type RendererSessionInteraction,
  type Ticket,
  type SessionPeekContent,
} from "@volli/shared";

import { useChatSessionsStore } from "@renderer/stores/chat-sessions";

import {
  useSessionPeek,
  type SessionPeekOptions,
  type SessionPeekPorts,
  type SessionPeekRow,
} from "./use-session-peek";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const NOW = 1_700_000_600_000;
const SESSION_ROW = "chat:chat-a1";
const SECOND_ROW = "chat:chat-b2";
const FOLDER_ROW = "folder:tkt-14";

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

const QUESTION: RendererSessionInteraction = {
  id: "question:q1",
  attachmentId: "attach-1",
  kind: "question",
  title: "Which fix should land first?",
  detail: null,
  options: [{ id: "question:0:c2Nyb2xs", label: "Recompute on scroll end", description: null }],
  multiple: false,
  prompts: [
    {
      id: "prompt:0",
      label: "Which fix should land first?",
      detail: null,
      options: [{ id: "question:0:c2Nyb2xs", label: "Recompute on scroll end", description: null }],
      multiple: false,
      custom: false,
    },
  ],
  native: { id: null, detail: null },
};

function row(rowId: string, overrides: Partial<SessionPeekRow> = {}): SessionPeekRow {
  return {
    rowId,
    sessionId: rowId.replace(/^chat:/, ""),
    title: `Session ${rowId}`,
    ticket: TICKET,
    kind: "chat",
    state: "working",
    providerId: "anthropic",
    providerLabel: "Anthropic",
    at: NOW - 120_000,
    unread: false,
    model: null,
    provenance: PERSON_STARTED,
    ...overrides,
  };
}

/** Every port a mock; nothing here needs main to answer. */
function ports(): SessionPeekPorts {
  return {
    readContent: vi.fn<SessionPeekPorts["readContent"]>(() => Promise.resolve(null)),
    answer: vi.fn(() => Promise.resolve(true)),
    sendMessage: vi.fn(() => Promise.resolve(true)),
    openSession: vi.fn(),
    openTicket: vi.fn(),
    viewConversation: vi.fn(),
    setRead: vi.fn(),
  };
}

interface SurfaceProps {
  /** The rows the listing draws right now. */
  rowIds: readonly string[];
  /** Row ids the listing still draws but can no longer describe. */
  missing?: readonly string[];
  /** Puts `data-peek-container` on the non-scrolling wrapper. */
  override?: boolean;
  /** Spreads `scrollProps` where the surfaces used to, as a surface mid-migration does. */
  spread?: boolean;
  folders?: ReadonlyMap<string, readonly string[]>;
  activityToken?: number;
  activityByRow?: ReadonlyMap<string, number>;
}

/**
 * A sidebar in miniature, shaped like the real ones: a scrolling pane, a wrapper
 * inside it that does NOT scroll, the rows below that, and — on a Session row —
 * the inline rename field the rail puts inside the same `<li>`.
 */
function Surface({
  rowIds,
  missing = NO_MISSING,
  override = false,
  spread = false,
  folders,
  activityToken = NOW - 120_000,
  activityByRow,
}: SurfaceProps) {
  const known = React.useMemo(() => {
    const map = new Map<string, SessionPeekRow>();
    for (const rowId of [...rowIds, SESSION_ROW, SECOND_ROW]) {
      if (missing.includes(rowId)) continue;
      if (rowId.startsWith("folder:")) continue;
      map.set(rowId, row(rowId, { at: activityByRow?.get(rowId) ?? activityToken }));
    }
    return map;
  }, [activityByRow, activityToken, missing, rowIds]);

  const options: SessionPeekOptions = {
    ticketPrefix: "VLT",
    now: NOW,
    rowOf: (rowId) => known.get(rowId),
    ticketOf: (ticketId) => (ticketId === TICKET.id ? TICKET : undefined),
    folders: folders ?? EMPTY_FOLDERS,
    ports: PORTS,
  };
  const peek = useSessionPeek(options);

  return (
    <div data-scroller="" style={{ overflowY: "auto" }}>
      {/* Where the surfaces used to spread `scrollProps`: it never scrolls. */}
      <div
        data-wrapper=""
        data-peek-container={override ? "" : undefined}
        data-scroll-props={typeof peek.scrollProps.onScroll}
        {...(spread ? peek.scrollProps : {})}
      >
        <ul data-list="" {...peek.rowProps("nav")}>
          {rowIds.map((rowId) =>
            rowId.startsWith("folder:") ? (
              <li key={rowId}>
                <button type="button" data-peek-row={rowId} data-peek-surface="nav">
                  VLT-14
                </button>
              </li>
            ) : (
              <li key={rowId} data-peek-row={rowId} data-peek-surface="nav">
                <button type="button">{rowId}</button>
                <input aria-label="Rename" defaultValue={rowId} />
              </li>
            ),
          )}
        </ul>
      </div>
      <span data-holding={peek.holding ? "yes" : "no"} data-shown={peek.shownRowId ?? ""} />
      {peek.card}
    </div>
  );
}

const LOCAL: SessionPeekContent = {
  sessionId: "chat-a1",
  entries: [{ at: 1, role: "assistant", text: "Readable local progress", tools: [] }],
  summary: null,
  question: QUESTION,
  turns: 1,
  turnDepth: 1,
  unreadable: 0,
  lastActivityAt: NOW,
};
const GENERATED = { ...LOCAL, summary: "Combined goal and progress" };
const EMPTY_FOLDERS: ReadonlyMap<string, readonly string[]> = new Map();
const NO_MISSING: readonly string[] = [];
let PORTS: SessionPeekPorts = ports();

let container: HTMLElement;
let root: Root | null = null;

/** Every bridge call refuses; the store is seeded directly instead. */
function bridgeNode(path: string[]): unknown {
  return new Proxy(() => {}, {
    get(_target, key) {
      return typeof key !== "string" || key === "then" ? undefined : bridgeNode([...path, key]);
    },
    apply() {
      if (path.at(-1)?.startsWith("on")) return () => {};
      return Promise.resolve({ ok: false, error: "not stubbed" });
    },
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("api", bridgeNode([]));
  PORTS = ports();
  useChatSessionsStore.setState({ sessions: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  useChatSessionsStore.setState({ sessions: {} });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(props: SurfaceProps): Promise<void> {
  await act(async () => {
    root?.render(<Surface {...props} />);
  });
}

/** The card is portalled to the body, out of the surface that mounts it. */
const card = () => document.querySelector<HTMLElement>("[data-peek-card]");
const holding = () =>
  container.querySelector<HTMLElement>("[data-holding]")?.dataset.holding === "yes";
const rowButton = (rowId: string) =>
  container.querySelector<HTMLElement>(`[data-peek-row="${rowId}"]`) instanceof HTMLButtonElement
    ? container.querySelector<HTMLButtonElement>(`[data-peek-row="${rowId}"]`)!
    : container.querySelector<HTMLButtonElement>(`[data-peek-row="${rowId}"] button`)!;

/** Space on a row: the keyboard path, which opens without waiting out a dwell. */
async function pressSpace(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
  });
}

async function pressKey(element: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function rectOf(top: number, bottom: number): () => DOMRect {
  return () => ({ top, bottom, left: 0, right: 240, width: 240, height: bottom - top }) as DOMRect;
}

describe("the scroller the hook finds for itself", () => {
  it("dismisses on a scroll of the element that really scrolls", async () => {
    await render({ rowIds: [SESSION_ROW] });
    await pressSpace(rowButton(SESSION_ROW));
    expect(card()).not.toBeNull();

    // Nothing spread `scrollProps` anywhere: the controller found the pane by
    // walking up from the rows container, and listens on it natively.
    const scroller = container.querySelector<HTMLElement>("[data-scroller]")!;
    await act(async () => {
      scroller.dispatchEvent(new Event("scroll"));
    });

    expect(card()).toBeNull();
    expect(holding()).toBe(false);
  });

  it("takes `[data-peek-container]` as the override, wherever it sits", async () => {
    await render({ rowIds: [SESSION_ROW], override: true });
    await pressSpace(rowButton(SESSION_ROW));

    const wrapper = container.querySelector<HTMLElement>("[data-wrapper]")!;
    await act(async () => {
      wrapper.dispatchEvent(new Event("scroll"));
    });

    expect(card()).toBeNull();
  });

  it("clamps the card to the scroller's box, not to the wrapper's", async () => {
    await render({ rowIds: [SESSION_ROW] });
    // The pane spans 100–400; the row sits at its bottom edge. The wrapper, which
    // is what `scrollProps` used to be spread on, measures zero.
    container.querySelector<HTMLElement>("[data-scroller]")!.getBoundingClientRect = rectOf(
      100,
      400,
    );
    container.querySelector<HTMLElement>(
      `[data-peek-row="${SESSION_ROW}"]`,
    )!.getBoundingClientRect = rectOf(380, 412);

    await pressSpace(rowButton(SESSION_ROW));

    // Clamped into the pane: its top, and its 300px of room as the budget.
    expect(card()?.style.top).toBe("100px");
    expect(card()?.style.maxHeight).toBe("300px");
  });

  it("keeps `scrollProps` on the binding, and keeps it harmless", async () => {
    // Compatibility, not a requirement: the field stays so a surface still
    // spreading it compiles and behaves, and the native listener is what makes
    // the dismissal happen either way — asking twice is idempotent.
    await render({ rowIds: [SESSION_ROW], spread: true });
    const wrapper = container.querySelector<HTMLElement>("[data-wrapper]")!;
    expect(wrapper.dataset.scrollProps).toBe("function");

    await pressSpace(rowButton(SESSION_ROW));
    expect(card()).not.toBeNull();

    await act(async () => {
      container.querySelector<HTMLElement>("[data-scroller]")!.dispatchEvent(new Event("scroll"));
    });
    expect(card()).toBeNull();
  });
});

describe("focus arriving in a row", () => {
  it("arms no peek when it landed in a field the row happens to contain", async () => {
    vi.useFakeTimers();
    await render({ rowIds: [SESSION_ROW] });
    const field = container.querySelector<HTMLInputElement>("input[aria-label='Rename']")!;

    await act(async () => {
      field.focus();
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    // An inline rename must not put a card over the name being typed.
    expect(card()).toBeNull();
  });

  it("arms one when it landed on the row itself", async () => {
    vi.useFakeTimers();
    await render({ rowIds: [SESSION_ROW] });

    await act(async () => {
      rowButton(SESSION_ROW).focus();
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(card()).not.toBeNull();
  });
});

describe("J and K", () => {
  it("step whatever Shift is doing", async () => {
    await render({ rowIds: [SESSION_ROW, SECOND_ROW] });
    const first = rowButton(SESSION_ROW);
    await act(async () => {
      first.focus();
    });

    await pressKey(first, "J");
    expect(document.activeElement).toBe(rowButton(SECOND_ROW));

    await pressKey(rowButton(SECOND_ROW), "K");
    expect(document.activeElement).toBe(first);
  });
});

describe("Space into a folder's card", () => {
  it("requests no content before a peek opens and uses generated folder summaries", async () => {
    const readContent = vi.mocked(PORTS.readContent);
    readContent.mockResolvedValue({
      sessionId: SESSION_ROW.replace(/^chat:/, ""),
      entries: [{ at: 1, role: "assistant", text: "Raw progress", tools: [] }],
      summary: "Combined user request and agent progress",
      question: null,
      turns: 1,
      turnDepth: 1,
      unreadable: 0,
      lastActivityAt: NOW,
    });
    const folders = new Map([[TICKET.id, [SESSION_ROW]]]);
    await render({ rowIds: [FOLDER_ROW], folders });
    expect(readContent).not.toHaveBeenCalled();
    await pressSpace(rowButton(FOLDER_ROW));
    expect(readContent.mock.calls).toEqual([
      ["chat-a1", false],
      ["chat-a1", true],
    ]);
    expect(card()?.querySelector("[data-peek-summary]")?.textContent).toBe(
      "Combined user request and agent progress",
    );
  });

  it("retries folder reads on a later peek instead of retaining a refused summary forever", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      const folders = new Map([[TICKET.id, [SESSION_ROW]]]);
      await render({ rowIds: [FOLDER_ROW], folders });
      await pressSpace(rowButton(FOLDER_ROW));
      expect(PORTS.readContent).toHaveBeenCalledTimes(1);
      await pressKey(card()!, "Escape");
      clock.mockReturnValue(NOW + 1_001);
      await pressSpace(rowButton(FOLDER_ROW));
      expect(PORTS.readContent).toHaveBeenCalledTimes(1);
      await pressKey(card()!, "Escape");
      clock.mockReturnValue(NOW + 60_000);
      await pressSpace(rowButton(FOLDER_ROW));
      expect(PORTS.readContent).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("shows local folder lines and joins pending refinement when reopened after dismissal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const local = Promise.withResolvers<SessionPeekContent | null>();
    const refinement = Promise.withResolvers<SessionPeekContent | null>();
    const readContent = vi.mocked(PORTS.readContent);
    readContent.mockImplementation((_id, refine) => (refine ? refinement.promise : local.promise));
    const folders = new Map([[TICKET.id, [SESSION_ROW]]]);
    await render({ rowIds: [FOLDER_ROW], folders });
    await pressSpace(rowButton(FOLDER_ROW));
    expect(readContent.mock.calls).toEqual([["chat-a1", false]]);
    expect(card()?.querySelector("[data-peek-summary]")?.textContent).toBe("No summary yet");
    await act(async () => local.resolve(LOCAL));
    expect(card()?.querySelector("[data-peek-summary]")?.textContent).toBe(
      "Readable local progress",
    );
    expect(readContent.mock.calls).toEqual([
      ["chat-a1", false],
      ["chat-a1", true],
    ]);
    await pressKey(card()!, "Escape");
    expect(card()).toBeNull();
    await act(async () => vi.advanceTimersByTime(1_001));
    await pressSpace(rowButton(FOLDER_ROW));
    expect(card()?.dataset.peekSubject).toBe("ticket");
    expect(card()?.querySelector("[data-peek-summary]")?.textContent).toBe(
      "Readable local progress",
    );
    expect(readContent).toHaveBeenCalledTimes(2);
    await act(async () => refinement.resolve(GENERATED));
    expect(card()?.querySelector("[data-peek-summary]")?.textContent).toBe(GENERATED.summary);
  });

  it("a folder drill shares pending refinement with the Session card", async () => {
    const refinement = Promise.withResolvers<SessionPeekContent | null>();
    const readContent = vi.mocked(PORTS.readContent);
    readContent.mockImplementation((_id, refine) =>
      refine ? refinement.promise : Promise.resolve(LOCAL),
    );
    const folders = new Map([[TICKET.id, [SESSION_ROW]]]);
    await render({ rowIds: [FOLDER_ROW], folders });
    await pressSpace(rowButton(FOLDER_ROW));
    await act(async () => {
      card()!
        .querySelector<HTMLButtonElement>(`[data-peek-drill="${SESSION_ROW}"]`)!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(card()?.dataset.peekSubject).toBe("session");
    expect(card()?.querySelector("[data-peek-summary]")?.textContent).toBe(
      "Readable local progress",
    );
    expect(readContent.mock.calls).toEqual([
      ["chat-a1", false],
      ["chat-a1", true],
    ]);
    await act(async () => refinement.resolve(GENERATED));
    expect(card()?.querySelector("[data-peek-summary]")?.textContent).toBe(GENERATED.summary);
  });

  it("folder activity invalidates local reads and drops late old refinements", async () => {
    const old = Promise.withResolvers<SessionPeekContent | null>();
    const readContent = vi.mocked(PORTS.readContent);
    readContent.mockResolvedValueOnce(LOCAL).mockReturnValueOnce(old.promise);
    const folders = new Map([[TICKET.id, [SESSION_ROW]]]);
    await render({ rowIds: [FOLDER_ROW], folders, activityToken: 1 });
    await pressSpace(rowButton(FOLDER_ROW));
    const fresh = { ...GENERATED, lastActivityAt: NOW + 1, summary: "Fresh activity" };
    readContent.mockResolvedValue(fresh);
    await render({ rowIds: [FOLDER_ROW], folders, activityToken: 2 });
    await act(async () => old.resolve(GENERATED));
    expect(card()?.querySelector("[data-peek-summary]")?.textContent).toBe("Fresh activity");
    expect(readContent).toHaveBeenCalledTimes(4);
  });

  it("another Session's activity does not expire an unchanged line during a continuous glance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fresh = Promise.withResolvers<SessionPeekContent | null>();
    const readContent = vi.mocked(PORTS.readContent);
    readContent.mockImplementation(async (id, refine) => ({
      ...LOCAL,
      sessionId: id,
      summary: refine ? `Summary for ${id}` : null,
    }));
    const folders = new Map([[TICKET.id, [SESSION_ROW, SECOND_ROW]]]);
    await render({ rowIds: [FOLDER_ROW], folders, activityToken: 1 });
    await pressSpace(rowButton(FOLDER_ROW));
    expect(readContent.mock.calls).toEqual([
      ["chat-a1", false],
      ["chat-b2", false],
      ["chat-a1", true],
      ["chat-b2", true],
    ]);
    await act(async () => vi.advanceTimersByTime(60_000));
    readContent.mockImplementation(() => fresh.promise);
    await render({
      rowIds: [FOLDER_ROW],
      folders,
      activityToken: 1,
      activityByRow: new Map([[SECOND_ROW, 2]]),
    });
    expect(
      card()?.querySelector(`[data-peek-drill="${SESSION_ROW}"] [data-peek-summary]`)?.textContent,
    ).toBe("Summary for chat-a1");
    expect(readContent.mock.calls.filter(([id]) => id === "chat-a1")).toEqual([
      ["chat-a1", false],
      ["chat-a1", true],
    ]);
    expect(readContent.mock.calls.at(-1)).toEqual(["chat-b2", false]);
    await act(async () =>
      fresh.resolve({ ...GENERATED, sessionId: "chat-b2", lastActivityAt: NOW + 1 }),
    );
    expect(readContent.mock.calls.filter(([id]) => id === "chat-a1")).toHaveLength(2);
    expect(readContent.mock.calls.at(-1)).toEqual(["chat-b2", true]);
  });

  it("a closed folder never refines a local read that settles after dismissal", async () => {
    const local = Promise.withResolvers<SessionPeekContent | null>();
    const readContent = vi.mocked(PORTS.readContent);
    readContent.mockReturnValueOnce(local.promise);
    const folders = new Map([[TICKET.id, [SESSION_ROW]]]);
    await render({ rowIds: [FOLDER_ROW], folders });
    await pressSpace(rowButton(FOLDER_ROW));
    await pressKey(card()!, "Escape");
    await act(async () => local.resolve(LOCAL));
    expect(card()).toBeNull();
    expect(readContent.mock.calls).toEqual([["chat-a1", false]]);
  });

  it("folder refinement failure retains a real fallback and retries only after cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const readContent = vi.mocked(PORTS.readContent);
    readContent.mockImplementation(async (_id, refine) => {
      if (refine) throw new Error("Utility offline");
      return LOCAL;
    });
    const folders = new Map([[TICKET.id, [SESSION_ROW]]]);
    await render({ rowIds: [FOLDER_ROW], folders });
    await pressSpace(rowButton(FOLDER_ROW));
    expect(card()?.querySelector("[data-peek-summary]")?.textContent).toBe(
      "Readable local progress",
    );
    await pressKey(card()!, "Escape");
    await act(async () => vi.advanceTimersByTime(1_001));
    await pressSpace(rowButton(FOLDER_ROW));
    expect(readContent).toHaveBeenCalledTimes(2);
    await pressKey(card()!, "Escape");
    await act(async () => vi.advanceTimersByTime(60_000));
    readContent.mockImplementation(async (_id, refine) => (refine ? GENERATED : LOCAL));
    await pressSpace(rowButton(FOLDER_ROW));
    expect(readContent).toHaveBeenCalledTimes(4);
    expect(card()?.querySelector("[data-peek-summary]")?.textContent).toBe(GENERATED.summary);
  });

  it("moves focus onto the card, which has to be focusable to receive it", async () => {
    const folders = new Map([[TICKET.id, [SESSION_ROW]]]);
    await render({ rowIds: [FOLDER_ROW], folders });
    const folder = rowButton(FOLDER_ROW);

    await pressSpace(folder);
    const open = card();
    expect(open?.dataset.peekSubject).toBe("ticket");

    // A folder is never pinnable (D2), so the second Space steps INTO the card.
    await pressSpace(folder);
    expect(document.activeElement).toBe(open);
  });
});

describe("a subject that leaves the listing", () => {
  it("closes the card and releases the hold rather than freezing both sidebars", async () => {
    await render({ rowIds: [SESSION_ROW, SECOND_ROW] });
    await pressSpace(rowButton(SESSION_ROW));
    expect(holding()).toBe(true);

    // The Session ends and the listing stops describing its row.
    await render({ rowIds: [SECOND_ROW], missing: [SESSION_ROW] });

    expect(card()).toBeNull();
    expect(holding()).toBe(false);
    expect(container.querySelector<HTMLElement>("[data-shown]")?.dataset.shown).toBe("");
  });
});

/** A resident projection carrying `active`, which is all the hook reads of it. */
function resident(active: readonly RendererSessionInteraction[]): void {
  useChatSessionsStore.setState({
    sessions: {
      "chat-a1": { projection: { interactions: { active, resolved: [] } } },
    },
  } as never);
}

describe("the pinned card's question (§3.3)", () => {
  it.each([true, false])(
    "pinned activity reads are local, including a hidden summary (question=%s)",
    async (question) => {
      const local = Promise.withResolvers<SessionPeekContent | null>();
      const readContent = vi.mocked(PORTS.readContent);
      readContent.mockReturnValueOnce(local.promise).mockResolvedValue(LOCAL);
      resident(question ? [QUESTION] : []);
      await render({ rowIds: [SESSION_ROW], activityToken: 1 });
      await pressSpace(rowButton(SESSION_ROW));
      await pressSpace(rowButton(SESSION_ROW));
      expect(card()?.getAttribute("role")).toBe("dialog");
      await act(async () => local.resolve(LOCAL));
      await render({ rowIds: [SESSION_ROW], activityToken: 2 });
      expect(readContent.mock.calls).toEqual([
        ["chat-a1", false],
        ["chat-a1", false],
      ]);
      if (question) {
        expect(card()?.querySelector("[data-peek-summary]")).toBeNull();
        expect(card()?.textContent).toContain("Recompute on scroll end");
      } else {
        expect(card()?.querySelector("[data-peek-summary]")?.textContent).toBe(
          "Readable local progress",
        );
      }
    },
  );

  it("a keyboard-open unpinned card shows local text and its question while refinement is pending", async () => {
    const local = Promise.withResolvers<SessionPeekContent | null>();
    const refinement = Promise.withResolvers<SessionPeekContent | null>();
    const readContent = vi.mocked(PORTS.readContent);
    readContent.mockImplementation((_id, refine) => (refine ? refinement.promise : local.promise));
    await render({ rowIds: [SESSION_ROW] });
    await pressSpace(rowButton(SESSION_ROW));
    expect(readContent.mock.calls).toEqual([["chat-a1", false]]);
    expect(card()?.querySelector("[data-summary-state]")?.getAttribute("data-summary-state")).toBe(
      "loading",
    );
    await act(async () => local.resolve(LOCAL));
    expect(card()?.querySelector("[data-peek-summary]")?.textContent).toBe(
      "Readable local progress",
    );
    expect(card()?.querySelector("[data-peek-question]")?.textContent).toBe(QUESTION.title);
    expect(card()?.querySelector("[data-summary-state]")?.getAttribute("data-summary-state")).toBe(
      "ready",
    );
    expect(readContent.mock.calls).toEqual([
      ["chat-a1", false],
      ["chat-a1", true],
    ]);
    await act(async () => refinement.resolve(GENERATED));
    expect(card()?.querySelector("[data-peek-summary]")?.textContent).toBe(GENERATED.summary);
  });

  it("is the resident projection's, and goes the instant that does", async () => {
    resident([QUESTION]);
    await render({ rowIds: [SESSION_ROW] });
    await pressSpace(rowButton(SESSION_ROW));

    // Pin through the card's own footer button — the pointer path into answering.
    const pin = [...document.querySelectorAll<HTMLButtonElement>("[data-peek-card] button")].find(
      (button) => /Send|Answer/.test(button.textContent ?? ""),
    )!;
    await act(async () => {
      pin.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(card()?.getAttribute("role")).toBe("dialog");
    expect(card()?.textContent).toContain("Recompute on scroll end");

    // Answered in its own tab: the question leaves the projection, so it leaves
    // the card in the same beat.
    await act(async () => {
      resident([]);
    });

    expect(card()?.textContent).not.toContain("Recompute on scroll end");
    // What is left is a message to the same Session, not a stale form.
    expect(card()?.querySelector("textarea")).not.toBeNull();
  });
});

describe("where the card is drawn", () => {
  it("is portalled to the body, outside every ancestor that could clip it", async () => {
    await render({ rowIds: [SESSION_ROW] });
    await pressSpace(rowButton(SESSION_ROW));
    const shown = card();
    expect(shown).not.toBeNull();
    // The framed shell clips the left sidebar with `clip-path`, which a
    // `position: fixed` descendant does not escape — so the card must not be one.
    expect(container.contains(shown)).toBe(false);
    expect(shown?.parentElement).toBe(document.body);
  });
});
