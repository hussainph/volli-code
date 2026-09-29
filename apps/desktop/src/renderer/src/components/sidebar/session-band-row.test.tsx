// @vitest-environment jsdom
/**
 * What the two band rows SAY, now that the peek is the thing that explains a
 * Session (VC-30).
 *
 * Three of these are product decisions rather than layout, and each replaced a
 * line the band used to print:
 *
 *   • The Active row's second line is WHERE and WHEN — `VC-7 · 2m ago` — and
 *     never a state word. The mark beside it carries the state, and the line
 *     this replaced said it twice ("Doing · Working").
 *   • Unread is its own axis: a semibold title and a blue dot, never the mark's
 *     badge, which is busy saying what the Session is doing.
 *   • A peekable row has NO native `title`. The card says the untruncated
 *     title, the harness and the provenance, and a browser tooltip would open
 *     on top of it at almost the same instant.
 *
 * `renderToStaticMarkup` for most of it — a row is a pure function of its props
 * — with a real jsdom root for the one promise that is a gesture: the
 * right-click menu, which Radix only mounts once something opens it.
 */
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { FIRST_CLASS_HARNESS_IDS, PERSON_STARTED } from "@volli/shared";
import type { HarnessId, Ticket } from "@volli/shared";

import type { ActiveSessionRow, PreviousSessionRow } from "./active-session-listing";
import {
  ActiveBandRow,
  PreviousBandRow,
  sessionGroupPanelId,
  TicketGroupRow,
} from "./session-band-row";
import { SidebarProvider } from "@renderer/components/ui/sidebar";

const ticket: Ticket = {
  id: "ticket-7",
  projectId: "project-1",
  ticketNumber: 7,
  title: "Nav sidebar",
  body: "",
  status: "doing",
  priority: "medium",
  labels: [],
  usesWorktree: true,
  preferredHarnessId: "claude-code",
  order: 0,
  worktreePath: "/worktrees/VC-7-nav-sidebar",
  branch: "volli/VC-7-nav-sidebar",
  baseBranch: "main",
  prUrl: null,
  createdAt: 0,
  updatedAt: 0,
};

function row(overrides: Partial<ActiveSessionRow> = {}): ActiveSessionRow {
  return {
    id: "session:s1",
    ticket,
    title: "Session 1",
    source: "Claude Code",
    harnessId: "claude-code",
    activity: "working",
    activitySource: "reported",
    attention: null,
    waitingOn: null,
    lastActivityAt: 60_000,
    provenance: PERSON_STARTED,
    target: { kind: "terminal", tabId: "s1", paneId: "p1" },
    ...overrides,
  };
}

function previousRow(overrides: Partial<PreviousSessionRow> = {}): PreviousSessionRow {
  return {
    id: "session:s1",
    ticket,
    title: "Review fixes",
    kind: "chat",
    harnessId: null,
    endedOrQuietAt: 0,
    activity: "idle",
    provenance: PERSON_STARTED,
    target: null,
    cleaned: false,
    ...overrides,
  };
}

function render(
  subject: ActiveSessionRow,
  props: Partial<React.ComponentProps<typeof ActiveBandRow>> = {},
): string {
  return renderToStaticMarkup(
    <SidebarProvider>
      <ActiveBandRow
        row={subject}
        projectId="proj-1"
        ticketPrefix="VC"
        now={180_000}
        selected={false}
        onSelect={() => {}}
        {...props}
      />
    </SidebarProvider>,
  );
}

function renderPrevious(
  subject: PreviousSessionRow = previousRow(),
  props: Partial<React.ComponentProps<typeof PreviousBandRow>> = {},
): string {
  return renderToStaticMarkup(
    <SidebarProvider>
      <PreviousBandRow
        row={subject}
        projectId="proj-1"
        ticketPrefix="VC"
        now={60_000}
        selected={false}
        onSelect={() => {}}
        {...props}
      />
    </SidebarProvider>,
  );
}

/** The row's second line — `ListRow` typesets a string `secondary` in this span. */
function subtitle(markup: string): string {
  return (
    /<span class="block truncate text-ui text-muted-foreground\/70">([^<]*)<\/span>/.exec(
      markup,
    )?.[1] ?? ""
  );
}

/** Every accessible name the row's marks announce. */
const markNames = (markup: string): string[] =>
  Array.from(markup.matchAll(/aria-label="([^"]*)"/g), (match) => match[1]!);

/** Every drawing in the row, in order: the mark's logo first, its badge after. */
const glyphPaths = (markup: string): string[] =>
  Array.from(markup.matchAll(/<path d="([^"]*)"/g), (match) => match[1]!);

/**
 * The LOGO the row leads with, as a value two renders can be compared by.
 *
 * The first drawing only: the badge behind it says the state, which differs
 * between a working Active row and the same Session resting in Previous.
 */
const logo = (markup: string): string => glyphPaths(markup)[0] ?? "";

/** How many times a word appears in the markup at all. */
const occurrences = (markup: string, word: string): number => markup.split(word).length - 1;

/** Opens the row's context menu the way a person does. */
async function rightClick(): Promise<void> {
  const trigger = document.querySelector('[data-slot="context-menu-trigger"]');
  await act(async () => {
    trigger?.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
    );
  });
}

/** The open context menu's item labels. */
function menuItems(): string[] {
  return [...document.querySelectorAll('[data-slot="context-menu-item"]')].map(
    (item) => item.textContent ?? "",
  );
}

describe("the Active row's second line", () => {
  it("says where the Session lives and when it last spoke, and no state word", () => {
    const markup = render(row());

    expect(subtitle(markup)).toBe("VC-7 · 2m ago");
    // The words the line used to carry are gone: the ticket's column, the
    // harness, the degradation notice. What is left of the state is the MARK's
    // accessible name, and exactly once.
    expect(markup).not.toContain("Doing");
    expect(markup).not.toContain("Not reporting");
    expect(occurrences(markup, "Working")).toBe(1);
    expect(markNames(markup)).toContain("Claude Code · Working");
    expect(subtitle(render(row({ activitySource: "silent" })))).toBe("VC-7 · 2m ago");
  });

  it("says so rather than leaving a hole for a Session with no ticket", () => {
    expect(subtitle(render(row({ ticket: null, lastActivityAt: 180_000 - 22 * 60_000 })))).toBe(
      "No ticket · 22m ago",
    );
  });

  it("says only where it lives when nothing can date it", () => {
    expect(subtitle(render(row({ lastActivityAt: null })))).toBe("VC-7");
  });

  it("drops the errand copy a waiting row used to print", () => {
    const markup = render(
      row({ activity: "waiting", attention: { signal: "waiting", reason: null } }),
    );

    expect(subtitle(markup)).toBe("VC-7 · 2m ago");
    expect(markup).not.toContain("Answer a question");
    expect(markup).not.toContain("Blocked");
    // The errand is the MARK's now, said once, in the words the band already
    // used for it.
    expect(occurrences(markup, "Waiting for you")).toBe(1);
    expect(markNames(markup)).toContain("Claude Code · Waiting for you");
  });
});

describe("the Active row's marks", () => {
  it("leads with the vendor's logo and the state as one accessible name", () => {
    expect(markNames(render(row()))).toContain("Claude Code · Working");
    expect(markNames(render(row({ activity: "idle" })))).toContain("Claude Code · Idle");
    expect(markNames(render(row({ activity: "interrupted" })))).toContain(
      "Claude Code · Interrupted",
    );
  });

  it("names the band's own vendor when the caller hands one over", () => {
    // A chat's logo comes from the model it runs, which only the band holds.
    const markup = render(row({ id: "chat:c1", harnessId: null, source: "Chat" }), {
      vendor: { providerId: "anthropic", providerLabel: "anthropic" },
    });

    expect(markNames(markup)).toContain("anthropic · Working");
  });

  it("keeps the working title's sweep, and the provenance mark beside it", () => {
    expect(render(row())).toContain("session-title-sweep");
    expect(render(row({ activity: "idle" }))).not.toContain("session-title-sweep");

    const marked = render(
      row({
        title: "Fix the flaky worktree test",
        provenance: { kind: "automation", automationName: "Nightly sweep" },
      }),
    );
    expect(marked).toContain('aria-label="Started by the Automation Nightly sweep"');
    expect(render(row())).not.toContain("Started by the Automation");
  });
});

describe("unread, on its own axis (VC-108)", () => {
  it("draws a blue dot and a semibold title, and says the word out of band", () => {
    const markup = render(row(), { unread: true });

    expect(markup).toContain("data-unread-dot");
    expect(markup).toContain("bg-info");
    expect(markup).toContain("Unread");
    expect(markup).toContain("font-semibold");
  });

  it("draws nothing at all when the Session has been read", () => {
    const markup = render(row());

    expect(markup).not.toContain("data-unread-dot");
    expect(markup).not.toContain("Unread");
    expect(markup).not.toContain("font-semibold");
  });
});

describe("a peekable row", () => {
  it("addresses itself to the peek and drops its native tooltip", () => {
    const markup = render(row());

    expect(markup).toContain('data-peek-row="session:s1"');
    expect(markup).toContain('data-peek-surface="nav"');
    expect(markup).not.toContain("title=");
  });

  it("leaves a Chat Draft out of it — a Draft stands for no Session", () => {
    // A provisional Draft's row id carries no `chat:`/`session:` prefix.
    const markup = render(
      row({ id: "draft-1", target: { kind: "chat", tabId: "t", sessionId: "d" } }),
    );

    expect(markup).not.toContain("data-peek-row");
    expect(markup).not.toContain("data-peek-surface");
  });

  it("holds the Previous row and the folder to the same rule", () => {
    const previous = renderPrevious();
    expect(previous).toContain('data-peek-row="session:s1"');
    expect(previous).not.toContain("title=");

    const folder = renderToStaticMarkup(
      <SidebarProvider>
        <TicketGroupRow
          ticket={ticket}
          ticketPrefix="VC"
          count={2}
          newestAt={0}
          now={60_000}
          open={false}
          selected={false}
          onToggle={() => {}}
        />
      </SidebarProvider>,
    );
    // The folder's peek hangs off its BUTTON: its `<li>` also holds the nested
    // list, and a pointer over a child must resolve to the child.
    expect(folder).toContain('data-peek-row="folder:ticket-7"');
    expect(folder).toContain('data-peek-surface="nav"');
    expect(folder).not.toContain("title=");
  });
});

describe("the Previous row", () => {
  it("keeps its one line: identity, title, and the age alone on the right", () => {
    const markup = renderPrevious(previousRow({ endedOrQuietAt: 0 }));

    expect(markup).toContain("VC-7");
    expect(markup).toContain("Review fixes");
    // 0 is the model's "nothing durable can date this" sentinel.
    expect(markup).not.toContain("1970");

    expect(
      renderPrevious(previousRow({ endedOrQuietAt: 0 }), { showIdentity: false }),
    ).not.toContain("VC-7");
    expect(renderPrevious(previousRow({ endedOrQuietAt: 1 }))).toContain("1m");
  });

  it("passes its real state to the mark, so an interrupted chat stays interrupted", () => {
    // VC-324: the record's activity is durable, so the relaunch did not end it.
    expect(markNames(renderPrevious(previousRow({ activity: "interrupted" })))).toContain(
      "Chat · Interrupted",
    );
    expect(markNames(renderPrevious())).toContain("Chat · Idle");
    // One mark, not a mark and a dot: the badge carries the state now.
    expect(renderPrevious(previousRow({ activity: "interrupted" }))).not.toContain(
      'data-slot="status-dot"',
    );
  });

  it("weights an unread title, and marks the row for the band around it", () => {
    const unread = renderPrevious(previousRow(), { unread: true });

    expect(unread).toContain("data-unread");
    expect(unread).toContain("font-semibold");
    // Unread is the exception in this band — a read row carries neither mark.
    expect(renderPrevious()).not.toContain("data-unread");
    expect(renderPrevious()).not.toContain("font-semibold");
  });

  it("ghosts a cleaned row and says so out of band", () => {
    expect(renderPrevious(previousRow({ cleaned: true }))).toContain("Cleaned up");
    expect(renderPrevious()).not.toContain("Cleaned up");
  });
});

/**
 * VC-402 × A3: a companion leads with its HARNESS'S VENDOR, so a Claude Code
 * pane and a Claude chat read as the same maker. Only a harness nobody
 * publishes a mark for keeps the band's Phosphor mnemonic.
 */
describe("a companion's mark", () => {
  it("draws a different mark for every first-class harness, in both bands", () => {
    const byDrawing = new Map<string, HarnessId[]>();
    for (const harnessId of FIRST_CLASS_HARNESS_IDS) {
      const active = logo(render(row({ harnessId })));
      expect(active).not.toBe("");
      // A Session keeps its mark as it ages from one band into the other.
      expect(logo(renderPrevious(previousRow({ kind: "terminal", harnessId })))).toBe(active);
      byDrawing.set(active, [...(byDrawing.get(active) ?? []), harnessId]);
    }

    expect([...byDrawing.values()].map((ids) => ids.join(" + "))).toEqual([
      ...FIRST_CLASS_HARNESS_IDS,
    ]);
  });

  it("keeps the generic terminal for a harness this build does not know", () => {
    const custom = "my-custom-harness" as HarnessId;
    const bare = renderPrevious(previousRow({ kind: "terminal", harnessId: null }));

    expect(
      markNames(renderPrevious(previousRow({ kind: "terminal", harnessId: custom }))),
    ).toContain("my-custom-harness · Idle");
    expect(logo(renderPrevious(previousRow({ kind: "terminal", harnessId: custom })))).toBe(
      logo(bare),
    );
  });

  it("stands a chat and a bare shell apart with the glyphs they already had", () => {
    const chat = logo(renderPrevious());
    const shell = logo(renderPrevious(previousRow({ kind: "terminal" })));

    expect(chat).not.toBe(shell);
  });
});

/**
 * The ticket entry the Previous band collapses onto, and the one thing a child
 * row gives up to sit under it (VC-69).
 */
describe("TicketGroupRow", () => {
  const HOUR_AGO = 60_000 * 60;
  const NOW = HOUR_AGO * 2;

  function renderGroup(
    count: number,
    open: boolean,
    overrides: { newestAt?: number; selected?: boolean } = {},
  ): string {
    return renderToStaticMarkup(
      <SidebarProvider>
        <TicketGroupRow
          ticket={ticket}
          ticketPrefix="VC"
          count={count}
          newestAt={overrides.newestAt ?? HOUR_AGO}
          now={NOW}
          open={open}
          selected={overrides.selected ?? false}
          onToggle={() => {}}
        />
      </SidebarProvider>,
    );
  }

  it("keeps its face: the ticket, how many sessions, and the newest one's age", () => {
    const markup = renderGroup(5, false);

    expect(markup).toContain("VC-7");
    expect(markup).toContain("Nav sidebar");
    expect(markup).toContain(">5<");
    expect(markup).toContain("1h");
  });

  it("draws the count even at one, and spells its unit out of band", () => {
    expect(renderGroup(1, false)).toContain(">1<");
    expect(renderGroup(3, false)).toContain("sessions");
    expect(renderGroup(1, false)).toContain("session<");
    expect(renderGroup(1, false)).not.toContain("sessions");
  });

  it("says nothing rather than the epoch when no stamp can date the newest session", () => {
    const undated = renderGroup(2, false, { newestAt: 0 });

    expect(undated).not.toContain("1970");
    expect(undated).toContain("VC-7");
  });

  it("takes the active treatment when the session in front of you is one of its own", () => {
    expect(renderGroup(4, false, { selected: true })).toContain('data-active="true"');
    expect(renderGroup(4, false)).toContain('data-active="false"');
  });

  it("carries no status dot in either state — attention never reaches this band", () => {
    expect(renderGroup(3, false)).not.toContain('data-slot="status-dot"');
    expect(renderGroup(3, true)).not.toContain('data-slot="status-dot"');
  });

  it("names the list it discloses and turns only the caret", () => {
    expect(renderGroup(2, true)).toContain(`aria-controls="${sessionGroupPanelId(ticket.id)}"`);
    expect(renderGroup(2, false)).toContain('aria-expanded="false"');

    const open = renderGroup(2, true);
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("rotate-90");
  });
});

/**
 * The read menu (D6). A gesture, so a real root: Radix mounts the content only
 * once something opens it.
 */
describe("the row's read menu", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    if (root !== null) {
      await act(async () => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
    vi.unstubAllGlobals();
  });

  async function mount(node: React.ReactElement): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<SidebarProvider>{node}</SidebarProvider>);
    });
  }

  it("offers the direction the row is not in, and marks it", async () => {
    const onToggleRead = vi.fn();
    await mount(
      <ActiveBandRow
        row={row({
          id: "chat:c1",
          harnessId: null,
          target: { kind: "chat", tabId: "t", sessionId: "c1" },
        })}
        projectId="proj-1"
        ticketPrefix="VC"
        now={180_000}
        selected={false}
        onSelect={() => {}}
        onToggleRead={onToggleRead}
      />,
    );
    await rightClick();

    expect(menuItems()).toEqual(["Mark as unread"]);
    await act(async () => {
      document.querySelector<HTMLElement>('[data-slot="context-menu-item"]')?.click();
    });
    expect(onToggleRead).toHaveBeenCalledTimes(1);
  });

  it("offers the other direction on an unread row", async () => {
    await mount(
      <ActiveBandRow
        row={row({
          id: "chat:c1",
          harnessId: null,
          target: { kind: "chat", tabId: "t", sessionId: "c1" },
        })}
        projectId="proj-1"
        ticketPrefix="VC"
        now={180_000}
        selected={false}
        unread
        onToggleRead={() => {}}
        onSelect={() => {}}
      />,
    );
    await rightClick();

    expect(menuItems()).toEqual(["Mark as read"]);
  });

  it("brings a Previous Session back by marking it unread", async () => {
    const onToggleRead = vi.fn();
    await mount(
      <PreviousBandRow
        row={previousRow({ id: "chat:c1" })}
        projectId="proj-1"
        ticketPrefix="VC"
        now={60_000}
        selected={false}
        onSelect={() => {}}
        onToggleRead={onToggleRead}
      />,
    );
    await rightClick();

    expect(menuItems()).toEqual(["Mark as unread"]);
    await act(async () => {
      document.querySelector<HTMLElement>('[data-slot="context-menu-item"]')?.click();
    });
    expect(onToggleRead).toHaveBeenCalledTimes(1);
  });

  it("offers the read direction on a Previous row that IS unread", async () => {
    // The row used to hard-code `unread={false}`, so its menu could only ever
    // offer "Mark as unread" — including for a Session that already was one,
    // where the act did nothing a reader could see.
    await mount(
      <PreviousBandRow
        row={previousRow({ id: "chat:c1" })}
        projectId="proj-1"
        ticketPrefix="VC"
        now={60_000}
        selected={false}
        unread
        onSelect={() => {}}
        onToggleRead={() => {}}
      />,
    );
    await rightClick();

    expect(menuItems()).toEqual(["Mark as read"]);
  });

  it("gives a companion no menu at all — it has no turns to be unread", async () => {
    // Amendment A4 Q2: no manual unread on terminal rows.
    await mount(
      <PreviousBandRow
        row={previousRow({ kind: "terminal", harnessId: "codex" })}
        projectId="proj-1"
        ticketPrefix="VC"
        now={60_000}
        selected={false}
        onSelect={() => {}}
        onToggleRead={null}
      />,
    );

    expect(document.querySelector('[data-slot="context-menu-trigger"]')).toBeNull();
    // And the row is still a row: activation, drag and its mark are untouched.
    expect(document.querySelector('[data-peek-row="session:s1"]')).not.toBeNull();
  });

  it("keeps the row draggable and activatable under the menu", async () => {
    const onSelect = vi.fn();
    await mount(
      <ActiveBandRow
        row={row({
          id: "chat:c1",
          harnessId: null,
          target: { kind: "chat", tabId: "tab-1", sessionId: "c1" },
        })}
        projectId="proj-1"
        ticketPrefix="VC"
        now={180_000}
        selected={false}
        onSelect={onSelect}
        onToggleRead={() => {}}
      />,
    );

    const button = document.querySelector<HTMLElement>('[data-peek-row="chat:c1"] button');
    expect(button?.getAttribute("draggable")).toBe("true");
    await act(async () => {
      button?.click();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
