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
 *   1. Home rail, live — the three scopes stacked as the Now page has them.
 *   2. The states — empty, unpriced, partial, mixed, one model, long names.
 *   3. Narrow — the same content at the 240px floor, where the model line drops.
 */
import * as React from "react";

import type { SessionUsage, SessionUsageSummary } from "@volli/shared";
import { summarizeSessionUsage } from "@volli/shared";

import { SectionHeading } from "@renderer/components/ui/section-heading";
import { StatusDot } from "@renderer/components/ui/status-dot";
import { ProjectUsageBlock } from "@renderer/components/usage/project-usage-block";
import { SessionUsageFacts } from "@renderer/components/usage/session-usage-facts";
import { TicketUsageBlock } from "@renderer/components/usage/ticket-usage-block";
import { UsageBar } from "@renderer/components/usage/usage-bar";
import type { UsageGroupRow, UsageWindow } from "@renderer/usage/usage-format";

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

const PROJECT_MODELS: readonly UsageGroupRow[] = [
  {
    key: "anthropic/claude-opus-4-1",
    label: "Claude Opus 4.1",
    usage: summarize(Array.from({ length: 120 }, () => op())),
  },
  {
    key: "openai/gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    usage: summarize(Array.from({ length: 60 }, () => op({ costUsd: 0.028 }))),
  },
  {
    key: "google/gemini-3-pro",
    label: "Gemini 3 Pro",
    usage: summarize(Array.from({ length: 24 }, () => op({ costUsd: 0.011 }))),
  },
  {
    key: "anthropic/claude-haiku-4",
    label: "Claude Haiku 4",
    usage: summarize([op({ costUsd: 0.002 })]),
  },
];

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
    <div className="flex flex-col gap-8">
      <Intro />

      <Group heading="1 · Home rail — Now, all three scopes">
        <Rail>
          <SectionHeading as="h3">Session</SectionHeading>
          <dl className="flex flex-col gap-2">
            <Fact label="Model">claude-opus-4-1</Fact>
            <Fact label="Effort">high</Fact>
            <Fact label="Activity">
              <span className="flex items-center gap-1">
                <StatusDot state="working" />
                Working
              </span>
            </Fact>
            <SessionUsageFacts summary={SESSION} />
          </dl>
          <div className="pt-4">
            <ProjectUsageBlock
              summary={PROJECT}
              models={PROJECT_MODELS}
              sessionCount={38}
              meteredSessionCount={24}
              window={window}
              onWindowChange={setWindow}
            />
          </div>
        </Rail>
        <Caption>
          Three headings, three scopes. Cost is a fact each scope carries, never a section of its
          own — a second block headed “Usage” would be two sections with one name.
        </Caption>
      </Group>

      <Group heading="2 · Ticket rail — the card and its breakdown">
        <Rail>
          <TicketUsageBlock
            summary={TICKET}
            sessions={TICKET_SESSIONS}
            topModelLabel="Claude Opus 4.1"
          />
        </Rail>
        <Caption>
          Click the card. The popover is the per-session breakdown — the placement that adds no
          block and touches no roster row. “Terminal (claude)” stays in the list at `—`: dropping it
          would make the rows fail to add up to the total above them.
        </Caption>
      </Group>

      <Group heading="3 · The notation, every state">
        <div className="flex flex-wrap gap-4">
          <State label="Estimated · complete" summary={SESSION} />
          <State label="Provider-reported" summary={REPORTED} hint="the only bare $" />
          <State label="Mixed basis" summary={MIXED} hint="tilde: the weaker claim wins" />
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
              topModelLabel="Claude Opus 4.1 (extended thinking)"
            />
          </Rail>
          <Rail width={RAIL_FLOOR} narrow>
            <ProjectUsageBlock
              summary={PROJECT}
              models={PROJECT_MODELS}
              sessionCount={38}
              meteredSessionCount={24}
              window={window}
              onWindowChange={setWindow}
            />
          </Rail>
        </div>
        <Caption>
          At the floor the top-model line drops first and the bar never does — it is the cheapest
          information per pixel on the card.
        </Caption>
      </Group>

      <Group heading="6 · Empty projects">
        <Rail>
          <ProjectUsageBlock
            summary={EMPTY}
            models={[]}
            sessionCount={4}
            meteredSessionCount={0}
            window={window}
            onWindowChange={setWindow}
          />
        </Rail>
        <Caption>
          “No metered model calls yet”, and the session count kept beside it. `$0.00` here would be
          the single most misleading string this feature could print.
        </Caption>
      </Group>
    </div>
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
    <div
      className="group/rail flex shrink-0 flex-col rounded-container border border-border bg-background p-4"
      data-narrow={narrow ? "true" : "false"}
      style={{ width }}
    >
      {children}
    </div>
  );
}

/** One notation state, at the width its figure will really be read at. */
function State({
  label,
  summary,
  hint,
}: {
  label: string;
  summary: SessionUsageSummary;
  hint?: string;
}) {
  return (
    <div className="flex w-56 flex-col gap-2 rounded-row border border-border bg-card p-4">
      <p className="text-label font-medium uppercase text-muted-foreground">{label}</p>
      <dl className="flex flex-col gap-2">
        <SessionUsageFacts summary={summary} />
      </dl>
      {summary.requestCount === 0 ? (
        <p className="text-ui text-muted-foreground">(renders nothing)</p>
      ) : (
        <UsageBar summary={summary} />
      )}
      {hint === undefined ? null : <p className="text-ui text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** home-rail.tsx's own Fact row, copied so the scratch can stack it. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="shrink-0 text-ui text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-ui text-foreground">{children}</dd>
    </div>
  );
}
