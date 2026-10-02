/**
 * VC-87's local usage surfaces, at every state they have to survive.
 *
 * The question this scratch answers: does a metered total stay HONEST at rail
 * width? Most of the design is notation — one glyph of hedge, absent versus
 * dash, tokens never labelled as cost — and notation only fails where it is
 * cramped, so every panel below is pinned to a real rail width (300px default,
 * 240px floor) rather than laid out to fit the page.
 *
 * Read it in this order:
 *   1. Home rail, live — both scopes in the one card the Now page has (VC-203).
 *   2. The states — empty, unpriced, partial, mixed, one model, long names.
 *   3. Narrow — the same content at the 240px floor.
 *
 * SINCE VC-203 THE CARDS ARE ALSO A TEST OF PROGRESSIVE DISCLOSURE, which a
 * static screenshot cannot check: open every caret. Model names, per-session
 * rankings, the cost basis and the session tally are all behind one now, and
 * the thing to look for is whether the face still answers the question a reader
 * actually arrived with.
 */
import * as React from "react";

import type { SessionUsage, SessionUsageSummary } from "@volli/shared";
import { summarizeSessionUsage } from "@volli/shared";

import { HomeSessionCard } from "@renderer/components/home/home-session-card";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { HomeUsageBlock } from "@renderer/components/usage/home-usage-block";
import { TicketUsageBlock } from "@renderer/components/usage/ticket-usage-block";
import { UsageBar } from "@renderer/components/usage/usage-bar";
import { UsageCostFigure } from "@renderer/components/usage/usage-card";
import { formatTokens } from "@volli/session-presentation";
import {
  formatCachedShare,
  formatUsageCost,
  totalUsageTokens,
  type UsageGroupRow,
  type UsageWindow,
} from "@renderer/usage/usage-format";

export const title = "Usage surfaces (VC-87)";
export const note = "Cost and token readouts at rail width — empty, unpriced, partial, mixed";

/** The rail's two widths, from `stores/ui.ts`. */
const RAIL_DEFAULT = 300;
const RAIL_FLOOR = 240;

// ─── fixtures ───────────────────────────────────────────────────────────────

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

const summarize = (ops: readonly SessionUsage[]): SessionUsageSummary => summarizeSessionUsage(ops);

/** A healthy Session: a dozen replies, a compaction, an auto-title. */
const SESSION = summarize([
  ...Array.from({ length: 10 }, () => op()),
  op({ cause: "compaction", inputTokens: 68_000, outputTokens: 3_100, costUsd: 0.21 }),
  op({ cause: "utility", inputTokens: 900, outputTokens: 40, costUsd: 0.004 }),
]);

/** A project across three models. */
const PROJECT = summarize([
  ...Array.from({ length: 120 }, () => op()),
  ...Array.from({ length: 60 }, () =>
    op({ providerId: "openai", modelId: "gpt-5.3-codex", costUsd: 0.028 }),
  ),
  ...Array.from({ length: 24 }, () =>
    op({ providerId: "google", modelId: "gemini-3-pro", costUsd: 0.011 }),
  ),
]);

/**
 * A model row as the rail hands one over: named against the catalogue, carrying
 * the identity its mark is drawn from (`modelName`). The marks are what make
 * this a column the eye scans rather than four grey lines.
 */
function modelRow(
  key: string,
  label: string,
  providerLabel: string,
  usage: SessionUsageSummary,
): UsageGroupRow {
  const slash = key.indexOf("/");
  const model = { providerId: key.slice(0, slash), modelId: key.slice(slash + 1), label };
  return { key, label, usage, model: { model, providerLabel } };
}

const PROJECT_MODELS: readonly UsageGroupRow[] = [
  modelRow(
    "anthropic/claude-opus-4-1",
    "Claude Opus 4.1",
    "Anthropic",
    summarize(Array.from({ length: 120 }, () => op())),
  ),
  modelRow(
    "openai/gpt-5.3-codex",
    "GPT-5.3 Codex",
    "OpenAI",
    summarize(Array.from({ length: 60 }, () => op({ costUsd: 0.028 }))),
  ),
  modelRow(
    "google/gemini-3-pro",
    "Gemini 3 Pro",
    "Google",
    summarize(Array.from({ length: 24 }, () => op({ costUsd: 0.011 }))),
  ),
  modelRow(
    "anthropic/claude-haiku-4",
    "Claude Haiku 4",
    "Anthropic",
    summarize([op({ costUsd: 0.002 })]),
  ),
];

/** The dearest model, which is the one fact the Ticket footer says about models. */
const TOP_MODEL: UsageGroupRow | null = PROJECT_MODELS[0] ?? null;

/** A name long enough to clip at the 240px floor, where the reveal is the way out. */
const LONG_TOP_MODEL: UsageGroupRow = modelRow(
  "anthropic/claude-opus-4-1-extended-thinking",
  "Claude Opus 4.1 (extended thinking)",
  "Anthropic",
  summarize(Array.from({ length: 120 }, () => op())),
);

const TICKET = summarize(Array.from({ length: 34 }, () => op()));

const TICKET_SESSIONS: readonly UsageGroupRow[] = [
  {
    key: "s1",
    label: "Wire the projection",
    usage: summarize(Array.from({ length: 18 }, () => op())),
  },
  {
    key: "s2",
    label: "Cost basis mapping",
    usage: summarize(Array.from({ length: 11 }, () => op())),
  },
  { key: "s3", label: "Backfill spike", usage: summarize(Array.from({ length: 5 }, () => op())) },
  // The honest gap: a manual companion Volli never mediated.
  { key: "s4", label: "Terminal (claude)", usage: summarize([]) },
];

/** Operations happened; none could be priced. */
const UNPRICED = summarize(
  Array.from({ length: 6 }, () => op({ costUsd: null, costBasis: "unavailable" })),
);

/** Half the operations priced — the report is a floor, not a total. */
const PARTIAL = summarize([
  ...Array.from({ length: 5 }, () => op()),
  ...Array.from({ length: 5 }, () => op({ costUsd: null, costBasis: "unavailable" })),
]);

/** A reported cost and an estimated one in the same report. */
const MIXED = summarize([
  ...Array.from({ length: 4 }, () => op({ costBasis: "provider-reported" })),
  ...Array.from({ length: 4 }, () => op({ costBasis: "catalog-estimate" })),
]);

/** Wholly provider-reported — the only case that prints a bare `$`. */
const REPORTED = summarize(Array.from({ length: 8 }, () => op({ costBasis: "provider-reported" })));

/** Cache cold: the operational incident the cached share is meant to surface. */
const COLD_CACHE = summarize(
  Array.from({ length: 6 }, () =>
    op({ inputTokens: 82_000, cacheReadTokens: 0, cacheWriteTokens: 21_000, costUsd: 0.94 }),
  ),
);

const EMPTY = summarize([]);

/**
 * How much worse the cold run is, DERIVED rather than typed into a caption.
 *
 * The first draft hard-coded "15x" and "94% cached" beside fixtures that
 * actually compute to 6.8x and 77%. A scratch whose prose disagrees with the
 * component beside it is worse than no scratch: it is the surface you check the
 * design against, and it was quietly wrong in the one direction that flatters
 * the design.
 */
const COLD_MULTIPLE =
  SESSION.knownCostUsd === null || COLD_CACHE.knownCostUsd === null
    ? null
    : COLD_CACHE.knownCostUsd / SESSION.knownCostUsd;

// ─── the scratch ────────────────────────────────────────────────────────────

export default function UsageSurfaces() {
  const [window, setWindow] = React.useState<UsageWindow>("30d");

  return (
    // The app's own provider is `SidebarProvider`'s, which the lab shell has no
    // half of — and every model row on this page hands its full identity back
    // through a Radix tooltip (`ValueReveal`), which throws rather than
    // degrading without one.
    <TooltipProvider>
      <div className="flex flex-col gap-8">
        <Intro />

        <Group heading="1 · Home rail — Now, both scopes in one card">
          <Rail>
            {/* The block above the usage card, as the rail really draws it since
              VC-406 — the shipping `HomeSessionCard` rather than a copy of its
              innards. This scratch used to restate it as a `<dl>` of
              Model/Effort/Activity rows, which was accurate until the page it
              was copied from stopped being a table; a scratch that redraws a
              component beside it is the surface you check the design against,
              and it was quietly a version behind. `home-rail-now.tsx` is where
              this card is studied at its states. */}
            <div className="flex flex-col gap-2 px-4">
              <SectionHeading as="h3">Session</SectionHeading>
            </div>
            <HomeSessionCard
              facts={{
                kind: "chat",
                model: {
                  model: {
                    providerId: "anthropic",
                    modelId: "claude-opus-4-1",
                    label: "Claude Opus 4.1",
                  },
                  providerLabel: "Anthropic",
                },
                tier: "Deep",
                effort: "high",
                activity: "working",
              }}
              venue={{
                status: "ready",
                venue: {
                  kind: "main-checkout",
                  path: "/Users/someone/code/volli-code",
                  branch: "main",
                  files: { committed: 6, modified: 3, added: 1, untracked: 2 },
                  diff: { added: 214, removed: 31, base: "main" },
                },
              }}
              onRetryVenue={() => {}}
            />
            <HomeUsageBlock
              summary={PROJECT}
              models={PROJECT_MODELS}
              sessionCount={38}
              meteredSessionCount={24}
              session={SESSION}
              window={window}
              onWindowChange={setWindow}
            />
          </Rail>
          <Caption>
            The Session block stops at what the Session IS; what it has spent is a row of the card
            below, beside the project total it is part of. Before VC-203 those were three key/value
            rows up in the Session list and a separate card down here — two drawings of one kind of
            number, a section apart.
          </Caption>
        </Group>

        <Group heading="1b · The same card with no Session in front">
          <Rail>
            <HomeUsageBlock
              summary={PROJECT}
              models={PROJECT_MODELS}
              sessionCount={38}
              meteredSessionCount={24}
              session={null}
              window={window}
              onWindowChange={setWindow}
            />
          </Rail>
          <Caption>
            The Board tab, a file tab, a terminal companion, a chat before its first reply. The row
            leaves; the card does not restructure itself around its absence.
          </Caption>
        </Group>

        <Group heading="2 · Ticket rail — the pinned footer and its breakdown">
          <Rail>
            <TicketUsageBlock summary={TICKET} sessions={TICKET_SESSIONS} topModel={TOP_MODEL} />
          </Rail>
          <Caption>
            One row, one door (VC-406): the figure with its muted <code>est.</code>, the token
            count, the caret. Everything the hero used to carry — the bar and its legend, the cached
            share, the basis sentence, the top model, the per-session ranking — is behind that one
            press. “Terminal (claude)” stays in the ranking at `—`: dropping it would make the rows
            fail to add up to the total above them. It is pinned UNDER the Now page rather than
            stacked in it, so it wears a top rule instead of a frame: cost is the one thing on that
            page that is only ever read, and a footer&rsquo;s boundary is with the page above it.
          </Caption>
        </Group>

        <Group heading="3 · The notation, every state">
          <div className="flex flex-wrap gap-4">
            <State label="Estimated · complete" summary={SESSION} />
            <State label="Provider-reported" summary={REPORTED} hint="the only bare $" />
            <State label="Mixed basis" summary={MIXED} hint="est.: the weaker claim wins" />
            <State label="Partial coverage" summary={PARTIAL} hint="+ means at least" />
            <State label="Unpriced" summary={UNPRICED} hint="— never $0.00" />
            <State label="Nothing metered" summary={EMPTY} hint="absent, not zero" />
          </div>
        </Group>

        <Group heading="4 · Cache cold — the incident the bar is for">
          <div className="flex flex-wrap gap-4">
            <State label="Warm cache" summary={SESSION} hint="cache carrying the prompt" />
            <State
              label="Cold cache"
              summary={COLD_CACHE}
              hint={
                COLD_MULTIPLE === null
                  ? "cache cold"
                  : `${COLD_MULTIPLE.toFixed(1)}× the cost, same token count`
              }
            />
          </div>
          <Caption>
            Same component, same notation. The bar is the fastest read of the difference — and it is
            labelled in tokens, because cost cannot be divided this way.
          </Caption>
        </Group>

        <Group heading="5 · The 240px floor">
          <div className="flex flex-wrap items-start gap-4">
            <Rail width={RAIL_FLOOR} narrow>
              <TicketUsageBlock
                summary={TICKET}
                sessions={TICKET_SESSIONS}
                topModel={LONG_TOP_MODEL}
              />
            </Rail>
            <Rail width={RAIL_FLOOR} narrow>
              <HomeUsageBlock
                summary={PROJECT}
                models={PROJECT_MODELS}
                sessionCount={38}
                meteredSessionCount={24}
                session={SESSION}
                window={window}
                onWindowChange={setWindow}
              />
            </Rail>
          </div>
          <Caption>
            Nothing has to drop at the floor any more — the lines that used to be squeezed here
            (model names, the basis sentence, the session tally) are behind carets at every width,
            so the narrow card is the wide card with a tighter inset rather than a reduced one.
          </Caption>
        </Group>

        <Group heading="6 · Empty projects">
          <Rail>
            <HomeUsageBlock
              summary={EMPTY}
              models={[]}
              sessionCount={4}
              meteredSessionCount={0}
              session={null}
              window={window}
              onWindowChange={setWindow}
            />
          </Rail>
          <Caption>
            “No metered model calls yet”, and the session count kept beside it. `$0.00` here would
            be the single most misleading string this feature could print.
          </Caption>
        </Group>
      </div>
    </TooltipProvider>
  );
}

// ─── scratch furniture ──────────────────────────────────────────────────────

function Intro() {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-heading text-foreground">Local usage surfaces</p>
      <p className="max-w-content text-sm leading-prose text-muted-foreground">
        Cost lives where work lives — the rails only. No chrome-band readout and no composer pill,
        both cut by owner ruling. Every figure below is drawn from a real{" "}
        <code className="font-mono text-ui">summarizeSessionUsage</code> over fixture operations, so
        the notation is the shipping notation rather than a mock-up of it.
      </p>
    </div>
  );
}

function Group({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <SectionHeading as="h2">{heading}</SectionHeading>
      {children}
    </section>
  );
}

function Caption({ children }: { children: React.ReactNode }) {
  return <p className="max-w-content text-ui leading-prose text-muted-foreground">{children}</p>;
}

/**
 * A rail-width column on the rail's own backdrop.
 *
 * `group/rail` plus `data-narrow` is the real contract — `rail-panel-parts.tsx`
 * drives its narrow inset off exactly this, so a component that responds to it
 * here will respond to it in the app.
 */
function Rail({
  children,
  width = RAIL_DEFAULT,
  narrow = false,
}: {
  children: React.ReactNode;
  width?: number;
  narrow?: boolean;
}) {
  return (
    // VERTICAL padding only. A horizontal inset here would stack on top of the
    // blocks' own `RAIL_PANEL_INSET`/`RAIL_PANEL_MARGIN` and draw every card
    // 32px narrower than the rail actually draws it — on a page whose entire
    // subject is whether these figures survive at rail width, that is the one
    // lie the furniture must not tell.
    <div
      className="group/rail flex shrink-0 flex-col rounded-container border border-border bg-background py-4"
      data-narrow={narrow ? "true" : "false"}
      style={{ width }}
    >
      {children}
    </div>
  );
}

/**
 * One notation state, at the width its figure will really be read at.
 *
 * The figure and its caption are spelled here rather than mounted from a
 * component, because after VC-203 there is no component that draws only those
 * two: the card's face is a popover trigger, and mounting six of them would put
 * six triggers on a page whose subject is the NOTATION rather than the
 * disclosure. Both lines still come from the shipping formatters, so the strings
 * on this page are the strings the rail prints.
 */
function State({
  label,
  summary,
  hint,
}: {
  label: string;
  summary: SessionUsageSummary;
  hint?: string;
}) {
  const cost = formatUsageCost(summary);
  const tokens = totalUsageTokens(summary);
  const cached = formatCachedShare(summary);
  return (
    <div className="flex w-56 flex-col gap-2 rounded-row border border-border bg-card p-4">
      <p className="text-label font-medium uppercase text-muted-foreground">{label}</p>
      {cost === null ? (
        <p className="text-ui text-muted-foreground">(renders nothing)</p>
      ) : (
        <>
          <UsageCostFigure summary={summary} className="text-heading text-foreground" />
          <UsageBar summary={summary} />
          {tokens > 0 ? (
            <p className="text-ui text-muted-foreground tabular-nums">
              {formatTokens(tokens)} tokens{cached === null ? "" : ` · ${cached} cached`}
            </p>
          ) : null}
        </>
      )}
      {hint === undefined ? null : <p className="text-ui text-muted-foreground">{hint}</p>}
    </div>
  );
}
