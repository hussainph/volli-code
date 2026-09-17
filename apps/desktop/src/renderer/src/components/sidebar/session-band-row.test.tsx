/**
 * What an Active row's second line SAYS — the one thing about these rows that
 * is a product decision rather than a layout one.
 *
 * The line's first slot holds where the Session lives (its ticket's column),
 * not what launched it. That was a swap, not an addition: the source label the
 * status displaced is still built for every row and still has to be reachable,
 * so every case here pins both halves — what the line reads, and that the
 * harness survived in the row's hover `title`.
 *
 * `renderToStaticMarkup` for the same reason the rail's row tests use it: the
 * suite runs on `environment: "node"` (root `vite.config.ts`) with no DOM. The
 * provider mirrors the real tree — `SidebarProvider` wraps the whole app, and
 * `SidebarMenuButton` reads its context unconditionally.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { PERSON_STARTED } from "@volli/shared";
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
    providerId: null,
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

function render(subject: ActiveSessionRow): string {
  return renderToStaticMarkup(
    <SidebarProvider>
      <ActiveBandRow
        row={subject}
        projectId="proj-1"
        ticketPrefix="VC"
        now={120_000}
        selected={false}
        onSelect={() => {}}
      />
    </SidebarProvider>,
  );
}

/**
 * The meta line's state half — the slot after the ticket id. It is the one span
 * whose class list is exactly `truncate`; the row's own title span carries
 * `session-row-dim truncate …`, so an exact-attribute match tells them apart
 * without a DOM to query.
 */
function stateLine(markup: string): string {
  return /<span class="truncate">([^<]*)<\/span>/.exec(markup)?.[1] ?? "";
}

/**
 * The row button's hover `title` — where the source label lives now.
 *
 * Deliberately NOT anchored on `<button`: `sidebarMenuButtonVariants` bakes in
 * Tailwind arbitrary variants like `[&>span:last-child]:truncate`, so a `>` sits
 * inside the class attribute and no `<button[^>]*` prefix can reach past it. The
 * row draws exactly one `title`, so the first match is the right one.
 */
function hoverTitle(markup: string): string {
  return /title="([^"]*)"/.exec(markup)?.[1] ?? "";
}

/**
 * The text the mark itself PRINTS, as distinct from the name it announces.
 *
 * Anchored on the mark's own accessible name and read past its bolt, rather
 * than on `<span class="truncate">` — the row's state line wears exactly
 * that class too, and matching it would have read the state as the mark.
 */
const markText = (markup: string): string | null =>
  /aria-label="Started by the Automation [^"]*"><svg[^]*?<\/svg>(?:<span class="truncate">([^<]*)<\/span>)?<\/span>/.exec(
    markup,
  )?.[1] ?? null;

describe("ActiveBandRow", () => {
  it("names the ticket's column in the slot the harness name used to hold", () => {
    const markup = render(row());

    expect(stateLine(markup)).toBe("Doing · Working");
    // Displaced, not dropped.
    expect(hoverTitle(markup)).toContain("Claude Code");
  });

  it("shows the age of the row's newest activity", () => {
    expect(render(row())).toContain("last 1m");
  });

  it("says where a ticketed chat Session lives and keeps its source plain", () => {
    const markup = render(
      row({
        id: "chat:c1",
        source: "Chat",
        harnessId: null,
        ticket: { ...ticket, status: "needs_review" },
      }),
    );

    expect(stateLine(markup)).toBe("Needs Review · Working");
    expect(hoverTitle(markup)).toContain("Chat");
    expect(markup).not.toContain("Live");
  });

  it("keeps the source on a ticketless row, which has no column to name", () => {
    const markup = render(
      row({ ticket: null, source: "Shell", harnessId: null, activity: "idle" }),
    );

    expect(stateLine(markup)).toBe("Shell · Idle");
  });

  it("still reports a silent harness, against the column rather than the source", () => {
    const markup = render(row({ activitySource: "silent" }));

    expect(stateLine(markup)).toBe("Doing · Not reporting");
  });

  // VC-131's three marks, at the surface VC-112 calls out by name. Everything
  // asserted here is about a RESTING band: what it draws, and what it refuses
  // to draw for the two parties that get no ink.
  describe("who started the Session", () => {
    const RUN = { kind: "automation", automationName: "Nightly sweep" } as const;

    it("carries a bolt and the Automation's name for a Run's Session", () => {
      const markup = render(row({ title: "Fix the flaky worktree test", provenance: RUN }));

      expect(markup).toContain('aria-label="Started by the Automation Nightly sweep"');
      expect(markText(markup)).toBe("Nightly sweep");
      expect(hoverTitle(markup)).toContain("Automation · Nightly sweep");
    });

    // A Run titles its Session after its Automation, so the word is usually
    // already the largest text on the row and the mark declines to repeat it.
    it("draws the bolt alone when the title already is the name", () => {
      const markup = render(row({ title: "Nightly sweep", provenance: RUN }));

      // Still announced in full — the fact never depends on a sighted
      // comparison with the title beside it.
      expect(markup).toContain('aria-label="Started by the Automation Nightly sweep"');
      expect(markText(markup)).toBeNull();
    });

    it("names the parent in the tooltip for a Session another Session started, and mints no glyph", () => {
      const markup = render(
        row({
          provenance: {
            kind: "session",
            parentSessionId: "session-parent",
            parentTitle: "Orchestrator",
          },
        }),
      );

      expect(hoverTitle(markup)).toContain("Started by Orchestrator");
      // No bolt, and no mark of any kind: a link answers "which agent" where a
      // glyph answers neither question (VC-112).
      expect(markup).not.toContain("Started by the Automation");
      expect(markup).not.toContain("text-primary");
    });

    it("gives a person's Session no mark at all — the resting rail stays quiet", () => {
      const marked = render(row({ provenance: RUN }));
      const resting = render(row());

      expect(resting).not.toContain("Started by the Automation");
      expect(hoverTitle(resting)).toBe("Session 1\nClaude Code");
      // The resting row is strictly SHORTER: the feature adds no node, no
      // class and no character to a band nobody automated.
      expect(resting.length).toBeLessThan(marked.length);
    });
  });

  it("leaves an errand row saying the errand, which never held a source", () => {
    const blocked = render(row({ attention: { signal: "blocked", reason: "Needs a decision" } }));
    expect(stateLine(blocked)).toBe("Blocked · Needs a decision");

    const waiting = render(
      row({ activity: "waiting", attention: { signal: "waiting", reason: null } }),
    );
    expect(stateLine(waiting)).toBe("Waiting for you");
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

  it("names the ticket, how many sessions are behind it, and the newest one's age", () => {
    const markup = renderGroup(5, false);

    expect(markup).toContain("VC-7");
    expect(markup).toContain("Nav sidebar");
    expect(markup).toContain(">5<");
    expect(markup).toContain("1h");
  });

  it("draws the count even at one, so a stack is never invisible", () => {
    // Every ticket gets one of these rows, so the count is the only mark that
    // separates a ticket hiding six sessions from one hiding a single session.
    expect(renderGroup(1, false)).toContain(">1<");
  });

  it("spells the count's unit out of band, so it cannot run into the age", () => {
    // Two unlabelled numbers side by side read as one token: 3 sessions at 43m
    // is announced "343m". The unit is what separates them for a screen reader,
    // and it is not worth the width on screen.
    expect(renderGroup(3, false)).toContain("sessions");
    expect(renderGroup(1, false)).toContain("session<");
    expect(renderGroup(1, false)).not.toContain("sessions");
  });

  it("says nothing rather than the epoch when no stamp can date the newest session", () => {
    // 0 is the listing model's "nothing durable can date this" sentinel, and
    // the child rows already refuse to draw an age from it.
    const undated = renderGroup(2, false, { newestAt: 0 });

    expect(undated).not.toContain("1970");
    expect(undated).not.toContain("Jan");
    // The rest of the row is unaffected.
    expect(undated).toContain("VC-7");
    expect(undated).toContain(">2<");
  });

  it("takes the active treatment when the session in front of you is one of its own", () => {
    // The band reveals the group as well as marking it, but a reader who
    // collapses it by hand is left with this mark alone pointing at where they
    // are — so it has to survive the collapsed state.
    expect(renderGroup(4, false, { selected: true })).toContain('data-active="true"');
    expect(renderGroup(4, true, { selected: true })).toContain('data-active="true"');
    expect(renderGroup(4, false)).toContain('data-active="false"');
  });

  it("carries no status dot in either state — attention never reaches this band", () => {
    // A Session needing a human is pinned to Active for as long as it is
    // asking, so nothing behind a collapsed ticket here can be waiting.
    expect(renderGroup(3, false)).not.toContain('data-slot="status-dot"');
    expect(renderGroup(3, true)).not.toContain('data-slot="status-dot"');
  });

  it("names the list it discloses, not just that it is open", () => {
    // `aria-expanded` alone announces a state with no subject. The id is
    // derived from the ticket so the row and the band can agree on it without
    // a channel between them.
    expect(renderGroup(2, true)).toContain(`aria-controls="${sessionGroupPanelId(ticket.id)}"`);
  });

  it("announces its disclosure state and turns only the caret", () => {
    expect(renderGroup(2, false)).toContain('aria-expanded="false"');

    const open = renderGroup(2, true);
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("rotate-90");
  });
});

describe("PreviousBandRow identity", () => {
  const previous: PreviousSessionRow = {
    id: "session:s1",
    ticket,
    title: "Review fixes",
    kind: "chat",
    harnessId: null,
    providerId: null,
    endedOrQuietAt: 0,
    activity: "idle",
    provenance: PERSON_STARTED,
    target: null,
    cleaned: false,
  };

  function renderPrevious(
    showIdentity?: boolean,
    overrides: Partial<PreviousSessionRow> = {},
  ): string {
    return renderToStaticMarkup(
      <SidebarProvider>
        <PreviousBandRow
          row={{ ...previous, ...overrides }}
          projectId="proj-1"
          ticketPrefix="VC"
          now={60_000}
          selected={false}
          onSelect={() => {}}
          showIdentity={showIdentity}
        />
      </SidebarProvider>,
    );
  }

  it("draws its ticket id when standing on its own", () => {
    expect(renderPrevious()).toContain("VC-7");
  });

  it("carries the same mark, from the same slot, once a Run's Session ages into it", () => {
    const markup = renderToStaticMarkup(
      <SidebarProvider>
        <PreviousBandRow
          row={{
            ...previous,
            title: "Fix the flaky worktree test",
            provenance: { kind: "automation", automationName: "Nightly sweep" },
          }}
          projectId="proj-1"
          ticketPrefix="VC"
          now={60_000}
          selected={false}
          onSelect={() => {}}
        />
      </SidebarProvider>,
    );

    expect(markup).toContain('aria-label="Started by the Automation Nightly sweep"');
    expect(markup).toContain("Automation · Nightly sweep");
  });

  it("stays entirely unmarked for the Sessions a person opened", () => {
    expect(renderPrevious()).not.toContain("Started by the Automation");
    // No `title` at all on a row with nothing to add, rather than an empty one.
    expect(renderPrevious()).toContain('title="Review fixes"');
  });

  it("drops the id under a ticket entry, which already said it", () => {
    const markup = renderPrevious(false);

    expect(markup).not.toContain("VC-7");
    // Only the identity goes: the row keeps its title and its kind glyph.
    expect(markup).toContain("Review fixes");
    expect(markup).toContain('aria-label="Chat"');
  });

  // VC-324: `interrupted` is durable, so it survives the quiet window into
  // Previous — and it must survive the RELAUNCH too, which is the same row
  // built purely from the record. One line is all this band gives a row, so
  // the mark is the destructive dot plus the words out of band.
  it("draws the interrupted dot for a historical interrupted Session (VC-324)", () => {
    const interrupted = renderPrevious(undefined, {
      id: "session:dead",
      title: "Died mid-run",
      activity: "interrupted",
    });
    const idle = renderPrevious(undefined, { activity: "idle" });

    // The destructive state the Active band gives the same fact.
    expect(interrupted).toContain('data-state="interrupted"');
    expect(idle).not.toContain('data-state="interrupted"');
  });

  it("says Interrupted out of band, as this row's one-line size demands", () => {
    const interrupted = renderPrevious(undefined, { activity: "interrupted" });
    const idle = renderPrevious(undefined, { activity: "idle" });

    expect(interrupted).toContain('class="sr-only">Interrupted</span>');
    expect(idle).not.toContain("Interrupted");
  });
});

/**
 * VC-402: WHOSE agent a row is running, as the vendor's own mark carrying the
 * state the dot used to carry.
 *
 * The acceptance is exactly what these assert — two rows on different vendors
 * are told apart with every word hidden — so the tests read the mark's own SVG
 * path rather than only its accessible name: a mapping that handed two
 * harnesses the same drawing would still announce two names.
 *
 * The COLOUR assertions are relations, never hexes, for the same reason
 * `ui/status-dot.test.tsx` states them that way: what has to hold is that the
 * mark and the dot cannot disagree about one Session, not what green is.
 */
// `Array.from` rather than a spread of `.matchAll().map()`: the iterator
// helper's `map` hands back another ITERATOR, which has no length and compares
// equal to every other one.
const glyphPaths = (markup: string): string[] =>
  Array.from(markup.matchAll(/<path d="([^"]*)"/g), (match) => match[1]!);

/** The `<span data-slot="session-mark">` wrapper's classes, or `[]` if there is none. */
const markWrapperClasses = (markup: string): string[] =>
  /<span data-slot="session-mark"[^>]*class="([^"]*)"/.exec(markup)?.[1]?.split(" ") ?? [];

/** The ink utility the mark's own `<svg>` paints with. */
const markInk = (markup: string): string | undefined => {
  const svg = /<svg role="img"[^>]*class="([^"]*)"/.exec(markup)?.[1]?.split(" ") ?? [];
  return svg.find((one) => one.startsWith("text-"));
};

describe("session vendor mark", () => {
  function renderPrevious(overrides: Partial<PreviousSessionRow>): string {
    return renderToStaticMarkup(
      <SidebarProvider>
        <PreviousBandRow
          row={{
            id: "session:s1",
            ticket,
            title: "Session 1",
            kind: "terminal",
            harnessId: null,
            providerId: null,
            endedOrQuietAt: 0,
            activity: null,
            provenance: PERSON_STARTED,
            target: null,
            cleaned: false,
            ...overrides,
          }}
          projectId="proj-1"
          ticketPrefix="VC"
          now={60_000}
          selected={false}
          onSelect={() => {}}
        />
      </SidebarProvider>,
    );
  }

  it("draws a different mark for each first-class harness, in both bands", () => {
    const claude = render(row({ harnessId: "claude-code" }));
    const codex = render(row({ harnessId: "codex" }));

    expect(claude).toContain('aria-label="Claude Code, Working"');
    expect(codex).toContain('aria-label="Codex, Working"');
    // The whole point: with every word hidden, the two rows still differ.
    expect(glyphPaths(claude)).not.toEqual(glyphPaths(codex));

    const cursor = glyphPaths(renderPrevious({ harnessId: "cursor" }));
    const opencode = glyphPaths(renderPrevious({ harnessId: "opencode" }));
    expect(cursor).not.toEqual(opencode);
    expect(cursor).not.toEqual(glyphPaths(renderPrevious({ harnessId: "claude-code" })));
  });

  it("draws a different mark for each provider a structured Session can run", () => {
    const providers = ["anthropic", "openai-codex", "opencode-go", "zai"];
    const drawings = providers.map((providerId) =>
      glyphPaths(render(row({ source: "Chat", harnessId: null, providerId }))),
    );

    for (const drawing of drawings) expect(drawing).toHaveLength(1);
    expect(new Set(drawings.map((paths) => paths[0]!)).size).toBe(providers.length);
    expect(render(row({ source: "Chat", harnessId: null, providerId: "zai" }))).toContain(
      'aria-label="Z.ai, Working"',
    );
  });

  // The provider is the ACCOUNT, never the family: a Claude model reached
  // through a gateway is that gateway's row, so the mark follows `providerId`
  // and nothing about the model is consulted at all.
  it("draws the harness ahead of the provider on a row that somehow has both", () => {
    const both = render(row({ harnessId: "cursor", providerId: "anthropic" }));
    expect(both).toContain('aria-label="Cursor, Working"');
    expect(glyphPaths(both)).toEqual(glyphPaths(render(row({ harnessId: "cursor" }))));
  });

  // The mark replaces the dot rather than joining it: one status slot, one
  // mark in it, or the band grows a column that says the same thing twice.
  it("stands where the dot stood, and the dot stands down", () => {
    const marked = render(row({ harnessId: "claude-code" }));
    expect(marked).not.toContain('data-slot="status-dot"');
    expect(marked).toContain('data-slot="session-mark"');

    // A row with no vendor to name keeps the dot and grows no mark.
    const bare = render(row({ source: "Shell", harnessId: null }));
    expect(bare).toContain('data-slot="status-dot"');
    expect(bare).not.toContain('data-slot="session-mark"');
  });

  // The relation `ui/status-dot.tsx` exists to protect, now across two
  // drawings: the mark's ink and the dot's fill are one verdict about one
  // Session, so they must move together and never be separately decided.
  it("takes the dot's own tone, and breathes on the same one state", () => {
    const working = render(row({ harnessId: "claude-code", activity: "working" }));
    const idle = render(row({ harnessId: "claude-code", activity: "idle" }));
    const waiting = render(
      row({ harnessId: "claude-code", attention: { signal: "waiting", reason: null } }),
    );
    const interrupted = render(row({ harnessId: "claude-code", activity: "interrupted" }));

    expect(markInk(working)).toBe("text-positive");
    expect(markInk(waiting)).toBe("text-attention");
    expect(markInk(interrupted)).toBe("text-destructive");
    expect(markInk(idle)).toMatch(/^text-muted-foreground\//);
    expect(markInk(idle)).not.toBe(markInk(working));

    // The dot's own class, not a second keyframe at a second period: the tab
    // strip still draws discs for Sessions this band draws marks for.
    expect(markWrapperClasses(working)).toContain("status-dot-live");
    for (const still of [idle, waiting, interrupted]) {
      expect(markWrapperClasses(still)).not.toContain("status-dot-live");
    }
  });

  // A bring-your-own harness gets no invented artwork, and a provider this
  // build has never heard of gets none either — both keep what they drew.
  it("keeps the old drawing for a vendor this build does not know", () => {
    const custom = renderPrevious({ harnessId: "my-custom-harness" as HarnessId });
    expect(custom).toContain('aria-label="Terminal"');
    expect(glyphPaths(custom)).toEqual(glyphPaths(renderPrevious({ harnessId: null })));

    const unknownProvider = render(row({ source: "Chat", harnessId: null, providerId: "acme-ai" }));
    expect(unknownProvider).toContain('data-slot="status-dot"');
    expect(unknownProvider).not.toContain('data-slot="session-mark"');
  });

  // The words the mark stands for, in the one place this one-line row can
  // afford them. The Active row has carried them in its `title` all along.
  it("decodes whatever mark it drew in the row's hover title", () => {
    expect(renderPrevious({ harnessId: "codex" })).toContain('title="Session 1\nCodex"');
    // A chat's mark is its provider, so that is what the title names — the rule
    // was written for the mark, not for the harness that first filled it.
    expect(renderPrevious({ kind: "chat", providerId: "zai" })).toContain(
      'title="Session 1\nZ.ai"',
    );
    expect(renderPrevious({ harnessId: null })).toContain('title="Session 1"');
  });

  // The continuity the Previous band's mark exists for: the same drawing, in
  // the band's own muted ink, saying nothing about status and moving not at all.
  it("keeps the mark as a Session ages out of Active, with the status left behind", () => {
    const previous = renderPrevious({ harnessId: "claude-code" });

    expect(glyphPaths(previous)).toEqual(glyphPaths(render(row({ harnessId: "claude-code" }))));
    expect(previous).toContain('aria-label="Claude Code"');
    expect(previous).toContain('data-state="none"');
    expect(markInk(previous)).toBeUndefined();
    expect(markWrapperClasses(previous)).not.toContain("status-dot-live");
  });

  // A chat with no mark keeps its circle; the rows that have one lose it.
  it("leaves a markless structured row exactly as it was", () => {
    const chatPrevious = renderPrevious({ kind: "chat", harnessId: null });
    expect(chatPrevious).toContain('aria-label="Chat"');
    expect(glyphPaths(chatPrevious)).toHaveLength(1);

    const marked = renderPrevious({ kind: "chat", harnessId: null, providerId: "anthropic" });
    expect(marked).not.toContain('aria-label="Chat"');
    expect(marked).toContain('aria-label="Anthropic"');
  });
});
