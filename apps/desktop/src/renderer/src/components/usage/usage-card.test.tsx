// @vitest-environment jsdom
/**
 * The rails' usage FOOTERS: what they put on screen unprompted, what they keep
 * behind the caret, and how much room the answer is allowed to take.
 *
 * STILL RENDERED STATICALLY, because that draws exactly the closed state: a
 * shut fold mounts no body, so `renderToStaticMarkup` gives the face and only
 * the face — which makes it the honest instrument for the requirement VC-203
 * turned on and VC-406 kept, that model names, cost bases and per-Session
 * rankings are revealed on demand rather than always listed. Passing `open`
 * renders the body the same way, with no interaction to simulate.
 *
 * jsdom is the ENVIRONMENT only so those strings can be parsed back into nodes
 * where a claim is about DOM placement — which element is inside the scroller
 * and which is outside it. Nothing here measures a layout jsdom does not do:
 * the height budget is asserted as the class that carries it, never as pixels.
 *
 * The production surfaces are `HomeUsageFooter` and `TicketUsageBlock`, both of
 * which `usage-rail.tsx` mounts. `HomeUsageBlock` — the pre-VC-406 card — is
 * kept for the UI lab's comparison scratches and is exercised there, not here.
 *
 * These components are pure over a `SessionUsageSummary` (see `usage-rail.tsx`
 * for why the store reads live one file up), so nothing here needs a mock.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { summarizeSessionUsage, type SessionUsage } from "@volli/shared";

import { RAIL_FOOTER, RAIL_FOOTER_ROW } from "@renderer/components/ticket/rail-panel-parts";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { HomeUsageFooter } from "@renderer/components/usage/home-usage-block";
import { TicketUsageBlock } from "@renderer/components/usage/ticket-usage-block";
import type { UsageGroupRow } from "@renderer/usage/usage-format";

function op(over: Partial<SessionUsage> = {}): SessionUsage {
  return {
    cause: "assistant",
    providerId: "anthropic",
    modelId: "claude-opus-4-1",
    inputTokens: 4_200,
    outputTokens: 1_100,
    cacheReadTokens: 38_000,
    cacheWriteTokens: 2_400,
    costUsd: 0.062,
    costBasis: "catalog-estimate",
    ...over,
  };
}

const METERED = summarizeSessionUsage([op(), op(), op()]);
const NOTHING_METERED = summarizeSessionUsage([]);

const MODELS: readonly UsageGroupRow[] = [
  {
    key: "anthropic/claude-opus-4-1",
    label: "Claude Opus 4.1",
    model: {
      model: { providerId: "anthropic", modelId: "claude-opus-4-1", label: "Claude Opus 4.1" },
      providerLabel: "Anthropic",
    },
    usage: summarizeSessionUsage([op()]),
  },
  {
    key: "openai/gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    model: {
      model: { providerId: "openai", modelId: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
      providerLabel: "OpenAI",
    },
    usage: summarizeSessionUsage([op({ costUsd: 0.028 })]),
  },
];

/** A model the catalogue could not name — `modelName`'s honest fallback. */
const UNNAMED_MODEL: UsageGroupRow = {
  key: "openai/gpt-5.6-luna",
  label: "gpt-5.6-luna",
  model: {
    model: { providerId: "openai", modelId: "gpt-5.6-luna", label: "gpt-5.6-luna" },
    providerLabel: "openai",
  },
  usage: summarizeSessionUsage([op()]),
};

const TICKET_SESSIONS: readonly UsageGroupRow[] = [
  { key: "s1", label: "Wire the projection", usage: summarizeSessionUsage([op()]) },
  // The honest gap: a manual companion Volli never mediated.
  { key: "s2", label: "Terminal (claude)", usage: NOTHING_METERED },
];

/** A Ticket that has run a lot of Sessions — the case the budget exists for. */
const MANY_SESSIONS: readonly UsageGroupRow[] = Array.from({ length: 40 }, (_, index) => ({
  key: `s${index}`,
  label: `Session ${index}`,
  usage: summarizeSessionUsage([op()]),
}));

/**
 * The app's tooltip provider, which `SidebarProvider` mounts around the whole
 * window: a model row hands its full identity back through a Radix tooltip
 * (`ValueReveal`), and one with no provider above it throws rather than
 * degrading.
 */
function home(over: Partial<Parameters<typeof HomeUsageFooter>[0]> = {}) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <HomeUsageFooter
        summary={METERED}
        models={MODELS}
        sessionCount={38}
        meteredSessionCount={24}
        session={null}
        window="30d"
        onWindowChange={() => {}}
        {...over}
      />
    </TooltipProvider>,
  );
}

function ticket(over: Partial<Parameters<typeof TicketUsageBlock>[0]> = {}) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <TicketUsageBlock
        summary={METERED}
        sessions={TICKET_SESSIONS}
        topModel={MODELS[0] ?? null}
        {...over}
      />
    </TooltipProvider>,
  );
}

/** Tags are separators in this markup, not something being sanitized away. */
function text(markup: string): string {
  return markup.split(/<[^>]+>/).join("");
}

/** One ranking's `<dl>` alone, so the footer's own glyphs are not read as a row's. */
function list(markup: string, heading: string): string {
  const from = markup.indexOf(heading);
  return markup.slice(from, markup.indexOf("</dl>", from));
}

/** The rendered markup as nodes, for the few claims that are about structure. */
function parse(markup: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = markup;
  return host;
}

function node(markup: string, testId: string): HTMLElement {
  const found = parse(markup).querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (found === null) throw new Error(`no node with test id ${testId}`);
  return found;
}

describe("the usage footers' faces", () => {
  it("are one row of the rail's own footer on both rails", () => {
    // VC-406's shape, as an assertion: neither scope is a card any more, and
    // both compose the one shared footer and the one shared row, so a retune of
    // either cannot move one rail and leave the other behind.
    for (const markup of [home(), ticket()]) {
      expect(markup).toContain("<footer");
      for (const utility of RAIL_FOOTER.split(" ")) expect(markup).toContain(utility);
      expect(markup).toContain(RAIL_FOOTER_ROW);
      // A rounded frame here would read as a block that happens to be last
      // rather than as the page's floor.
      expect(markup).not.toContain("rounded-xl");
    }
  });

  it("names no model and no Session until asked", () => {
    // The count is the affordance; the ranking is behind it.
    const markup = home();
    expect(markup).not.toContain("Claude Opus 4.1");
    expect(markup).not.toContain("GPT-5.3 Codex");
    expect(ticket()).not.toContain("Wire the projection");
  });

  it("keeps the cost basis and the session tally off the face", () => {
    const markup = home();
    // Both were unprompted lines before VC-203; both qualify the figure rather
    // than adding to it, so both are behind the caret.
    expect(markup).not.toContain("Estimated");
    expect(markup).not.toContain("24 metered");
  });

  it("shows the figure, its token count and the window it is read through", () => {
    const markup = home();
    expect(markup).toContain("$0.19");
    expect(markup).toContain("tokens");
    // The window is on the face because it is what the figure MEANS.
    expect(markup).toContain("30d");
    // The bar is a body fact: the face is one row.
    expect(markup).not.toContain('role="img"');
  });

  it("hedges an estimate with a muted `est.` after the money, never a tilde before it (VC-406)", () => {
    const markup = home();
    // The mark is its own node a step below the figure's rung, so it can be
    // set muted; the accessible name speaks the same two words.
    expect(markup).toContain(
      '$0.19</span><span class="shrink-0 text-label text-muted-foreground">est.</span>',
    );
    expect(markup).toContain('aria-label="Project usage $0.19 est. over 30d — show breakdown"');
    expect(markup).not.toContain("~$");
  });

  it("prints a provider-reported figure bare", () => {
    const markup = home({
      summary: summarizeSessionUsage([op({ costBasis: "provider-reported" })]),
    });
    expect(markup).not.toContain("est.");
    expect(markup).not.toContain("unverified");
  });

  it("hedges a basis it cannot vouch for as unverified rather than estimated", () => {
    // Volli knowing a number and Volli having computed it are different claims.
    const markup = home({
      summary: summarizeSessionUsage([op({ costBasis: "unavailable" })]),
    });
    expect(markup).toContain("unverified");
    expect(markup).not.toContain("est.");
  });
});

describe("the Session in front", () => {
  it("is a row of the project's breakdown when it has metered something", () => {
    const markup = home({ session: METERED, open: true });
    expect(markup).toContain("This session");
    expect(markup).toContain('data-testid="home-usage-session"');
  });

  it("is absent, not dashed, for a Session that metered nothing", () => {
    // A terminal companion, or a chat before its first reply. Three rows of
    // dashes on the default rail would be noise dressed as honesty.
    expect(home({ session: NOTHING_METERED, open: true })).not.toContain("This session");
    expect(home({ session: null, open: true })).not.toContain("This session");
  });
});

describe("an unmeasured project", () => {
  it("says so rather than printing a zero", () => {
    const markup = home({ summary: NOTHING_METERED, models: [], meteredSessionCount: 0 });
    expect(markup).toContain("No metered model calls yet");
    // The single most misleading string this feature could print.
    expect(markup).not.toContain("$0.00");
  });

  it("keeps the session tally behind the caret, because the gap is the news", () => {
    const markup = home({
      summary: NOTHING_METERED,
      models: [],
      meteredSessionCount: 0,
      open: true,
    });
    expect(markup).toContain("38 sessions · 0 metered");
  });
});

describe("a model row", () => {
  it("is drawn, never spelled: the vendor's mark leads the catalogue's name", () => {
    // The rows used to print the wire id with its provider prefix stripped
    // (`claude-opus-4-1`), which was the last usage surface still doing it.
    const markup = home({ open: true });
    const ranking = list(markup, "By model");

    expect(text(ranking)).toContain("Claude Opus 4.1");
    expect(text(ranking)).not.toContain("claude-opus-4-1");
    // The vendor's own inline `<svg>` (`ModelMark`), before the name.
    expect(ranking.slice(0, ranking.indexOf("Claude Opus 4.1"))).toContain("<svg");
  });

  it("never spends the row's width on the account, and keeps it a focus away", () => {
    // The rail rule: the mark says whose model this is, so the words are in the
    // reveal rather than on the row (VC-288).
    const markup = home({ open: true });

    expect(text(markup)).not.toContain("Claude Opus 4.1 · Anthropic");
    expect(markup).toContain('aria-label="Model · Claude Opus 4.1 · Anthropic"');
    expect(markup).toContain('aria-label="Model · GPT-5.3 Codex · OpenAI"');
  });

  it("keeps the id for a model the catalogue cannot name", () => {
    // A provider signed out from under a Session, or a model retired from the
    // catalogue. The money was still spent by that id.
    expect(text(home({ models: [UNNAMED_MODEL], open: true }))).toContain("gpt-5.6-luna");
  });

  it("marks no Session row, because every row in that ranking is one", () => {
    // A kind glyph repeated down a column marks nothing, and a Session is not a
    // model — the By-session ranking stays plain labels.
    const markup = ticket({ open: true });
    const ranking = list(markup, "By session");

    expect(text(ranking)).toContain("Wire the projection");
    expect(ranking).not.toContain("<svg");
    expect(ranking).not.toContain('aria-label="Model ·');
  });
});

describe("the Ticket footer", () => {
  it("draws nothing at all for a Ticket that never metered a call", () => {
    expect(ticket({ summary: NOTHING_METERED, sessions: [], topModel: null })).toBe("");
  });

  it("says its Top model the way every other model surface says one", () => {
    const markup = ticket({ open: true });
    const fact = markup.slice(markup.indexOf("Top model"));

    expect(text(fact)).toContain("Claude Opus 4.1");
    expect(fact.slice(0, fact.indexOf("Claude Opus 4.1"))).toContain("<svg");
    expect(markup).toContain('aria-label="Model · Claude Opus 4.1 · Anthropic"');
    // One fact, not a ranking: the Ticket footer still names no second model.
    expect(text(markup)).not.toContain("By model");
  });

  it("keeps the closed row pinned and reveals the trimmed breakdown above it (VC-406)", () => {
    const closed = ticket();
    expect(closed).toContain('aria-label="Ticket usage $0.19 est. — show breakdown"');
    expect(closed).not.toContain('role="img"');
    expect(closed).not.toContain("Cached input share");

    const open = ticket({ open: true });
    expect(open).toContain('aria-label="Ticket usage $0.19 est. — hide breakdown"');
    expect(open).toContain('role="img"');
    expect(open).toContain("Cached input share");
    expect(open).toContain("Top model");
    expect(open).toContain("By session");
    expect(open).toContain("Wire the projection");
    expect(open).not.toContain("Total tokens");
    expect(open.indexOf('role="img"')).toBeLessThan(open.indexOf('data-testid="ticket-usage"'));
  });

  it("reports a Session that metered nothing rather than dropping it", () => {
    // These rows have to add up to the figure on the row above them, and a
    // manual companion is where the missing work went.
    expect(ticket({ open: true })).toContain("Terminal (claude)");
  });
});

describe("the fold's height budget", () => {
  it("bounds both bodies with a scroller rather than letting the data set the height", () => {
    // The P1 this fixes: the Ticket's body drew EVERY Session at full height,
    // so opening usage on a busy Ticket pushed the Now scroller and its roster
    // out of the rail. `max-h-40` is the rail's existing cap — Home's body and
    // the Automations list already wear it — and `overscroll-contain` keeps the
    // wheel from chaining to the page behind it once the list ends.
    for (const body of [
      node(home({ open: true }), "home-usage-body"),
      node(ticket({ open: true }), "ticket-usage-body"),
    ]) {
      expect(body.className).toContain("max-h-40");
      expect(body.className).toContain("overflow-y-auto");
      expect(body.className).toContain("overscroll-contain");
    }
  });

  it("keeps the same cap with forty Sessions in it, and every row inside the scroller", () => {
    const markup = ticket({ open: true, sessions: MANY_SESSIONS });
    const body = node(markup, "ticket-usage-body");

    expect(body.className).toContain("max-h-40");
    // No row is dropped to make it fit: the cap scrolls, it does not truncate.
    expect(body.textContent).toContain("Session 0");
    expect(body.textContent).toContain("Session 39");
    expect(body.querySelectorAll("dl > div")).toHaveLength(MANY_SESSIONS.length);
  });

  it("leaves the trigger outside the scroller, so the row stays put and stays pressable", () => {
    // A trigger inside its own scrolling body is one the reader can scroll away
    // from; the footer's whole argument is a row that never moves.
    const markup = ticket({ open: true, sessions: MANY_SESSIONS });
    const body = node(markup, "ticket-usage-body");
    const trigger = node(markup, "ticket-usage");

    expect(body.contains(trigger)).toBe(false);
    expect(body.querySelector('[data-testid="ticket-usage"]')).toBeNull();
    expect(trigger.tagName).toBe("BUTTON");
  });

  it("keeps Home's window control on the same terms", () => {
    const markup = home({ open: true });
    const body = node(markup, "home-usage-body");
    const trigger = node(markup, "home-usage");

    expect(body.contains(trigger)).toBe(false);
    // The control that changes the window rides inside the bounded body, where
    // pressing it cannot be confused with opening the fold.
    expect(body.textContent).toContain("Project usage");
  });
});
