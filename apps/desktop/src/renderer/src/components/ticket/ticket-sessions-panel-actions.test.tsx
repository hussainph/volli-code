// @vitest-environment jsdom
/**
 * What the rail's Sessions block OFFERS: the create control in its heading,
 * and the acts a row carries in its own menu and keys (VC-30).
 *
 * The first half renders statically, so every store reads its INITIAL state —
 * an empty roster, which is what those cases are about. The second half mounts,
 * because a menu and a keypress need a document.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EMPTY_SESSION_USAGE_SUMMARY,
  PERSON_STARTED,
  type ChatSessionRecord,
  type SessionListingRow,
  type SessionRecord,
} from "@volli/shared";

import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useSessionsStore } from "@renderer/stores/sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useUiStore } from "@renderer/stores/ui";
import { TicketSessionsPanel } from "./ticket-sessions-panel";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

/**
 * The resident chat client a send from the card goes through. The delivery
 * path itself is the shipped one (`client.submit`) and is tested where it
 * lives; what these cases are about is what the RAIL does around its answer.
 */
const peekClient = vi.hoisted(() => ({
  submit: vi.fn(async (): Promise<"delivered" | "refused"> => "delivered"),
}));

vi.mock("@volli/session-presentation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@volli/session-presentation")>();
  return {
    ...actual,
    // The rail's own resume/source rules still come from the real module; only
    // the client a peek send reaches for is a fixture.
    getChatClient: () => peekClient as unknown as ReturnType<typeof actual.getChatClient>,
  };
});

const noop = (): void => {};

function buttonTag(html: string, label: string): string {
  const labelOffset = html.indexOf(`aria-label="${label}"`);
  return html.slice(html.lastIndexOf("<button", labelOffset), html.indexOf(">", labelOffset) + 1);
}

function panel(creating: boolean): string {
  return renderToStaticMarkup(
    <TicketSessionsPanel
      projectId="project-1"
      ticketId="ticket-6"
      creating={creating}
      onNewSession={noop}
      onNewChat={noop}
      onActivateSession={noop}
      onActivateChat={noop}
    />,
  );
}

describe("TicketSessionsPanel", () => {
  // Static markup reads every store's INITIAL state (`getServerSnapshot`), so
  // every case below is the roster BEFORE its baseline read — which paints the
  // rows' box, not an empty sentence (VC-383). The empty sentence itself is
  // proven on the mounted path in `ticket-sessions-panel-push.test.tsx`, where
  // a listing can land. The create control lives in the Sessions HEADING and is
  // present either way (the scratch draws it always) — these cases prove its
  // shape and its disabled state; `ticket-sessions-panel-rows.test.tsx` proves
  // it survives a populated roster.
  it("starts a chat in one press and keeps the terminal behind the caret", () => {
    const html = panel(false);

    expect(html).toContain('aria-label="New chat"');
    expect(buttonTag(html, "New chat")).not.toContain('aria-haspopup="menu"');
    expect(buttonTag(html, "Other things to open")).toContain('aria-haspopup="menu"');
    expect(html).not.toContain('aria-label="New session"');
  });

  it("announces the chord, which now starts what this control starts", () => {
    // This rail only exists inside a ticket, and ⌘T / ⌥⌘T resolve against the
    // surface in front (lib/new-session-shortcut.ts) — so inside a ticket they
    // mint a Session on that ticket, exactly as this control does. The rule is
    // unchanged ("only advertise a key that does what the item does"); the chord
    // is what moved.
    expect(buttonTag(panel(false), "New chat")).toContain('aria-keyshortcuts="Meta+T"');
  });

  it("disables both halves while the ticket worktree is booting", () => {
    const html = panel(true);

    expect(buttonTag(html, "New chat")).toContain('disabled=""');
    expect(buttonTag(html, "Other things to open")).toContain('disabled=""');
  });

  it("holds the rows' box, with the offer once above it, before the listing has answered", () => {
    // The heading's own control sits above the list either way, so neither the
    // pending box nor the empty frame carries a second copy of the same offer.
    const html = panel(false);

    expect(html).toContain('data-testid="ticket-sessions-loading"');
    expect(html).not.toContain("No active sessions");
    expect(html.match(/aria-label="New chat"/g)?.length).toBe(1);
  });
});

/* ------------------------------------------------------------ the row's acts */

const chat: ChatSessionRecord = {
  sessionId: "chat-1",
  title: "Trace the dropped decorations",
  projectId: "p1",
  ticketId: "t1",
  createdAt: 2,
  adapterId: "pi",
  live: true,
  activity: "waiting",
  waitingOn: "question",
  outcome: null,
  lastActivityAt: 2,
  bornTicketless: false,
  role: "ticket",
  parentSessionId: null,
  model: null,
};

const terminal: SessionRecord = {
  id: "terminal-0",
  projectId: "p1",
  ticketId: "t1",
  harnessId: "claude-code",
  activeHarnessId: null,
  harnessSessionId: null,
  launchKind: "agent",
  placement: "tab",
  title: "Closed shell",
  cwd: "/repo",
  createdAt: 1,
  endedAt: 3,
  exitCode: 0,
  lastActivityAt: 3,
  bornTicketless: false,
};

const rows: SessionListingRow[] = [
  {
    kind: "chat",
    record: chat,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    provenance: PERSON_STARTED,
    read: { unreadSince: 5 },
  },
  {
    kind: "terminal",
    record: terminal,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    provenance: PERSON_STARTED,
  },
];

let root: Root | null = null;
let container: HTMLElement | null = null;
let setRead: ReturnType<typeof vi.fn>;
/** Which chat Sessions the panel was asked to activate, in order. */
let activated: string[];

function rowElement(rowId: string): HTMLElement {
  const node = container?.querySelector<HTMLElement>(`[data-peek-row="${rowId}"]`);
  if (node === null || node === undefined) throw new Error(`no row ${rowId}`);
  return node;
}

/** Radix opens a context menu on the trigger's own `contextmenu` event. */
async function openMenu(rowId: string): Promise<void> {
  const trigger = rowElement(rowId).querySelector<HTMLElement>(
    '[data-slot="context-menu-trigger"]',
  );
  await act(async () => {
    trigger?.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 8, clientY: 8 }),
    );
  });
}

/**
 * The whole path a message takes from a rail row: dwell on the row until its
 * card opens, press `Send` to pin it, type, submit. Driven through the shipped
 * card rather than through the port, because what is being pinned here is that
 * the RAIL reads the Session when the card's send lands — and a test that
 * called the port directly would keep passing if the card stopped reaching it.
 */
async function sendFromCard(text: string): Promise<void> {
  vi.useFakeTimers();
  try {
    // Focus is the cheap door into the same dwell the pointer takes.
    const target = rowElement("chat:chat-1").querySelector<HTMLElement>("button");
    await act(async () => target?.focus());
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    const pin = [...document.querySelectorAll<HTMLElement>("[data-peek-card] button")].find(
      (button) => button.textContent === "Send",
    );
    await act(async () => pin?.click());

    const box = document.querySelector<HTMLTextAreaElement>("[data-peek-card] textarea");
    // React reads the value off the node, so the native setter is what makes a
    // controlled field see typed text.
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => {
      setValue?.call(box, text);
      box?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const form = document.querySelector<HTMLFormElement>("#peek-reply-form");
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  } finally {
    vi.useRealTimers();
  }
}

function menuItems(): string[] {
  return [...document.querySelectorAll('[data-slot="context-menu-item"]')].map(
    (item) => item.textContent ?? "",
  );
}

describe("a rail row's acts", () => {
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    activated = [];
    setRead = vi.fn(async () => ({ ok: true as const, read: { unreadSince: null } }));
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        sessions: {
          listForTicket: vi.fn(async () => ({ ok: true as const, sessions: rows })),
          setRead,
          peekContent: vi.fn(async () => ({ ok: true as const, content: null })),
        },
      },
    });
    peekClient.submit.mockClear();
    peekClient.submit.mockImplementation(async () => "delivered");
    // Adoption is an attach, and these cases are not about the transport.
    useChatSessionsStore.setState({ adoptChatSession: vi.fn() });
    useSessionsStore.setState({ byOwner: {}, sessionOwner: {}, lastOutputAt: {} });
    useUiStore.setState({ railFolds: { sessionsRecord: true, worktree: false, usage: false } });
    useTicketSessionRecordsStore.setState({
      byTicket: { t1: rows },
      listingState: { t1: "loaded" },
      listingError: {},
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TicketSessionsPanel
          projectId="p1"
          ticketId="t1"
          creating={false}
          onNewSession={noop}
          onNewChat={noop}
          onActivateSession={noop}
          onActivateChat={(sessionId) => activated.push(sessionId)}
        />,
      );
    });
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    useTicketSessionRecordsStore.setState({ byTicket: {}, listingState: {}, listingError: {} });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("offers the read item beside Rename on a chat row", async () => {
    await openMenu("chat:chat-1");

    // The row is unread, so the menu offers the direction that clears it — and
    // Rename is still there, untouched by the peek (D6).
    expect(menuItems()).toEqual(["Rename", "Mark as read"]);
  });

  it("keeps Resume on a resumable record row, and offers it no read item", async () => {
    await openMenu("session:terminal-0");

    // A terminal companion has no turns to leave unseen (plan §3.5).
    expect(menuItems()).toEqual(["Resume", "Rename"]);
  });

  it("still renames a row in place, with the peek's handlers on the list around it", async () => {
    // The peek listens on the block, never on the row, so the row keeps every
    // gesture it had: double-clicking the title opens the rename field.
    // The innermost span: the title's own node is the one carrying the
    // double-click handler, and its wrapper reads the same textContent because a
    // person-started row draws no provenance mark beside it.
    const title = [...rowElement("chat:chat-1").querySelectorAll<HTMLElement>("span")].find(
      (span) => span.textContent === chat.title && span.children.length === 0,
    );
    await act(async () => {
      title?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    const field = container?.querySelector<HTMLInputElement>("input");
    expect(field?.getAttribute("aria-label")).toBe(`Rename ${chat.title}`);
  });

  it("marks the Session read from the menu", async () => {
    await openMenu("chat:chat-1");
    const mark = [
      ...document.querySelectorAll<HTMLElement>('[data-slot="context-menu-item"]'),
    ].find((item) => item.textContent === "Mark as read");
    await act(async () => mark?.click());

    expect(setRead).toHaveBeenCalledWith({ sessionId: "chat-1", unread: false });
  });

  it("opens the Session from the card, through the row's own activation, and reads it", async () => {
    // The card's `Open session` is not a second route into a Session: it calls
    // the row's own activation (`railRowActivation`), and opening reads it (D6).
    vi.useFakeTimers();
    try {
      const target = rowElement("chat:chat-1").querySelector<HTMLElement>("button");
      // Focus is the cheap door into the same dwell the pointer takes
      // (`PEEK_FOCUS_DWELL_MS`), and it needs no layout to resolve a row.
      await act(async () => target?.focus());
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      const open = document.querySelector<HTMLElement>('[aria-label="Open session"]');
      expect(open).not.toBeNull();
      await act(async () => open?.click());

      expect(activated).toEqual(["chat-1"]);
      expect(setRead).toHaveBeenCalledWith({ sessionId: "chat-1", unread: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the Session when the ROW itself is clicked (plan §3.4)", async () => {
    // Opening reads, wherever the open starts. The card's `Open session` did
    // this and the row's own click did not, so clicking a row left the dot on
    // a Session that was now in front of the person.
    const target = rowElement("chat:chat-1").querySelector<HTMLElement>("button");
    await act(async () => target?.click());

    expect(activated).toEqual(["chat-1"]);
    expect(setRead).toHaveBeenCalledWith({ sessionId: "chat-1", unread: false });
  });

  it("reads the Session when a message is sent from the card (plan §3.4)", async () => {
    await sendFromCard("ship it");

    expect(peekClient.submit).toHaveBeenCalledTimes(1);
    expect(setRead).toHaveBeenCalledWith({ sessionId: "chat-1", unread: false });
  });

  it("does not read when the send was refused", async () => {
    // A message the client could not take is not a turn anybody has seen, so
    // the dot stays where it is.
    peekClient.submit.mockImplementation(async () => "refused");

    await sendFromCard("ship it");

    expect(peekClient.submit).toHaveBeenCalledTimes(1);
    expect(setRead).not.toHaveBeenCalled();
  });

  it("toggles read with U on the focused row", async () => {
    const target = rowElement("chat:chat-1").querySelector<HTMLElement>("button");
    await act(async () => {
      target?.dispatchEvent(new KeyboardEvent("keydown", { key: "u", bubbles: true }));
    });

    // The row is unread, so U reads it (D6) — one deliberate key, and the only
    // read the peek controller ever asks for.
    expect(setRead).toHaveBeenCalledWith({ sessionId: "chat-1", unread: false });
  });
});
