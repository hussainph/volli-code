/**
 * The rails' usage cards: what they put on screen unprompted, and what they
 * keep behind a caret.
 *
 * THE POINT OF RENDERING STATICALLY is that it draws exactly the closed state.
 * A Radix popover mounts nothing until it opens, so `renderToStaticMarkup` gives
 * the card's FACE and only its face — which makes it the honest instrument for
 * the one requirement VC-203 actually turns on: that model names, cost bases and
 * per-session rankings are revealed on demand rather than always listed. A test
 * that had to open the popover to prove they were hidden would be testing Radix.
 *
 * These components are pure over a `SessionUsageSummary` (see `usage-rail.tsx`
 * for why the store reads live one file up), so nothing here needs a mock.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { summarizeSessionUsage, type SessionUsage } from "@volli/shared";

import { RAIL_CARD_FRAME } from "@renderer/components/ticket/rail-panel-parts";
import { HomeUsageBlock } from "@renderer/components/usage/home-usage-block";
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
    usage: summarizeSessionUsage([op()]),
  },
  {
    key: "openai/gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    usage: summarizeSessionUsage([op({ costUsd: 0.028 })]),
  },
];

const TICKET_SESSIONS: readonly UsageGroupRow[] = [
  { key: "s1", label: "Wire the projection", usage: summarizeSessionUsage([op()]) },
  // The honest gap: a manual companion Volli never mediated.
  { key: "s2", label: "Terminal (claude)", usage: NOTHING_METERED },
];

function home(over: Partial<Parameters<typeof HomeUsageBlock>[0]> = {}) {
  return renderToStaticMarkup(
    <HomeUsageBlock
      summary={METERED}
      models={MODELS}
      sessionCount={38}
      meteredSessionCount={24}
      session={null}
      window="30d"
      onWindowChange={() => {}}
      {...over}
    />,
  );
}

describe("the usage card's face", () => {
  it("wears the repository card's frame, so the two rails read as one kind of object", () => {
    // The whole of VC-203's second complaint, as an assertion: the usage surface
    // used to be `rounded-row border-border bg-card` beside a `rounded-xl`
    // sidebar-bordered Git card. Both now compose the one shared constant, so a
    // retune of that frame cannot move one card and leave the other behind.
    for (const markup of [
      home(),
      renderToStaticMarkup(
        <TicketUsageBlock
          summary={METERED}
          sessions={TICKET_SESSIONS}
          topModelLabel="Claude Opus 4.1"
        />,
      ),
    ]) {
      for (const utility of RAIL_CARD_FRAME.split(" ")) {
        expect(markup).toContain(utility);
      }
    }
  });

  it("names no model until asked", () => {
    const markup = home();
    // The count is the affordance; the ranking is behind it.
    expect(markup).toContain("2 models");
    expect(markup).not.toContain("Claude Opus 4.1");
    expect(markup).not.toContain("GPT-5.3 Codex");
  });

  it("keeps the cost basis and the session tally off the face", () => {
    const markup = home();
    // Both were unprompted lines before VC-203; both qualify the figure rather
    // than adding to it, so both moved behind the face's own caret.
    expect(markup).not.toContain("Estimated");
    expect(markup).not.toContain("24 metered");
  });

  it("shows the figure, the bar and the one caption that reads it", () => {
    const markup = home();
    expect(markup).toContain("~$0.19");
    expect(markup).toContain("tokens");
    expect(markup).toContain("cached");
    expect(markup).toContain('role="img"');
  });
});

describe("the Session in front", () => {
  it("is a row of the project card when it has metered something", () => {
    const markup = home({ session: METERED });
    expect(markup).toContain("This session");
    expect(markup).toContain("~$0.19");
  });

  it("is absent, not dashed, for a Session that metered nothing", () => {
    // A terminal companion, or a chat before its first reply. Three rows of
    // dashes on the default rail would be noise dressed as honesty.
    expect(home({ session: NOTHING_METERED })).not.toContain("This session");
    expect(home({ session: null })).not.toContain("This session");
  });
});

describe("an unmeasured project", () => {
  it("says so rather than printing a zero", () => {
    const markup = home({ summary: NOTHING_METERED, models: [], meteredSessionCount: 0 });
    expect(markup).toContain("No metered model calls yet");
    // The single most misleading string this feature could print.
    expect(markup).not.toContain("$0.00");
  });

  it("keeps the session tally beside it, because the gap is the news", () => {
    const markup = home({ summary: NOTHING_METERED, models: [], meteredSessionCount: 0 });
    expect(markup).toContain("38 sessions · 0 metered");
  });
});

describe("the Ticket card", () => {
  it("draws nothing at all for a Ticket that never metered a call", () => {
    const markup = renderToStaticMarkup(
      <TicketUsageBlock summary={NOTHING_METERED} sessions={[]} topModelLabel={null} />,
    );
    expect(markup).toBe("");
  });

  it("counts its Sessions on the face and ranks them behind it", () => {
    const markup = renderToStaticMarkup(
      <TicketUsageBlock
        summary={METERED}
        sessions={TICKET_SESSIONS}
        topModelLabel="Claude Opus 4.1"
      />,
    );
    expect(markup).toContain("2 sessions");
    expect(markup).not.toContain("Wire the projection");
    // Named nowhere on the face — it is a qualifier on the figure, not a line.
    expect(markup).not.toContain("Claude Opus 4.1");
  });
});
