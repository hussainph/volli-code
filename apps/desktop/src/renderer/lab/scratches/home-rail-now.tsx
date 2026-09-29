/**
 * Home's Now page — the Session card, at every state it has to survive
 * (VC-406).
 *
 * The question this scratch answers: does the page read as TWO objects at rail
 * width — the Session and its tree, then the money — where it used to read as
 * three, one of which was a `<dl>` of Model/Effort/Activity lines with each
 * label parked at the left and its value right-aligned against it?
 *
 * Read it in this order:
 *   1. The page — the card over the usage card it is now a sibling of. The
 *      frame, the seam and the row inset are the same recipe; that is the
 *      whole point, and it is the one thing a screenshot can check at a glance.
 *   2. What is in front — a chat on each vendor's mark, a terminal, nothing.
 *      Kinds of thing, not one kind with missing fields.
 *   3. Activity — the vocabulary, every state, because the words come from
 *      `SESSION_ACTIVITY_LABEL` now rather than from a map this page kept.
 *   4. The venue — reading, faulted, detached, clean.
 *   5. Narrow — the same page at the 240px floor.
 *
 * Every card is the SHIPPING `HomeSessionCard` over fixture facts: what is on
 * screen is what the rail draws, never a mock-up of it. The usage card beside
 * it is the shipping `HomeUsageBlock` over a real `summarizeSessionUsage`, and
 * the vendor marks are `models/model-identity.tsx`'s — the same ones the
 * composer's pill and the picker draw.
 */
import * as React from "react";

import { summarizeSessionUsage, type SessionUsage, type VenueSnapshot } from "@volli/shared";

import {
  HomeSessionCard,
  type HomeSessionFacts,
} from "@renderer/components/home/home-session-card";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import type { StatusDotState } from "@renderer/components/ui/status-dot";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { HomeUsageBlock } from "@renderer/components/usage/home-usage-block";
import type { VenueEntry } from "@renderer/stores/venue";
import type { UsageGroupRow, UsageWindow } from "@renderer/usage/usage-format";

export const title = "Home rail · Now page (VC-406)";
export const note = "The Session card and its venue — beside the usage card it is a sibling of";

/** The rail's two widths, from `stores/ui.ts`. */
const RAIL_DEFAULT = 300;
const RAIL_FLOOR = 240;

// ─── fixtures ───────────────────────────────────────────────────────────────

const VENUE: VenueSnapshot = {
  kind: "main-checkout",
  path: "/Users/someone/code/volli-code",
  branch: "main",
  files: { committed: 6, modified: 3, added: 1, untracked: 2 },
  diff: { added: 214, removed: 31, base: "main" },
};

const READY: VenueEntry = { status: "ready", venue: VENUE };
const CLEAN: VenueEntry = {
  status: "ready",
  venue: { ...VENUE, files: { committed: 6, modified: 0, added: 0, untracked: 0 } },
};
const DETACHED: VenueEntry = { status: "ready", venue: { ...VENUE, branch: null } };
const LONG: VenueEntry = {
  status: "ready",
  venue: {
    ...VENUE,
    kind: "worktree",
    path: "/Users/someone/.volli/worktrees/volli-code-f3732f45/VC-406-reorganize-and-redesign-the-in-ticket-right-side",
    branch: "volli/VC-406-reorganize-and-redesign-the-in-ticket-right-side",
  },
};
const FAULTED: VenueEntry = {
  status: "error",
  error: "ENOENT: no such file or directory, scandir '/Users/someone/code/volli-code'",
};

/**
 * Four accounts' models, because the row names one the way every model surface
 * does — the vendor's mark and the catalogue's own label (VC-406) — and here
 * the MARK is what tells the accounts apart: the first two are one model bought
 * from two of them, and the row never spends its width spelling that out.
 */
const VENDOR_MODELS = [
  { providerId: "anthropic", modelId: "claude-opus-4-1", label: "Claude Opus 4.1" },
  { providerId: "github-copilot", modelId: "claude-opus-4-1", label: "Claude Opus 4.1" },
  { providerId: "openai", modelId: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { providerId: "google", modelId: "gemini-3-pro", label: "Gemini 3 Pro" },
];

/** Typed as the chat MEMBER, so the states below can spread it and stay one. */
const CHAT: Extract<HomeSessionFacts, { kind: "chat" }> = {
  kind: "chat",
  model: { model: VENDOR_MODELS[0]!, providerLabel: "Anthropic" },
  tier: "Deep",
  effort: "high",
  activity: "working",
};

/** The same Session, pinned to another account's model. */
function pinnedTo(
  index: number,
  providerLabel: string,
): Extract<HomeSessionFacts, { kind: "chat" }> {
  return { ...CHAT, model: { model: VENDOR_MODELS[index]!, providerLabel } };
}

/** A cost rollup, so the card below is the real one rather than an empty frame. */
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

const PROJECT = summarizeSessionUsage(Array.from({ length: 120 }, () => op()));
const SESSION = summarizeSessionUsage(Array.from({ length: 11 }, () => op()));
const MODELS: readonly UsageGroupRow[] = [
  {
    key: "anthropic/claude-opus-4-1",
    label: "Claude Opus 4.1",
    usage: summarizeSessionUsage(Array.from({ length: 120 }, () => op())),
  },
];

// ─── the scratch ────────────────────────────────────────────────────────────

export default function HomeRailNow() {
  const [window, setWindow] = React.useState<UsageWindow>("30d");

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-8">
        <Intro />

        <Group heading="1 · The page">
          <Rail>
            <Now facts={CHAT} venue={READY} window={window} onWindowChange={setWindow} />
          </Rail>
          <Caption>
            Two cards, nesting the same two scopes twice — Session inside project, once as identity
            and once as money. Same frame, same seam, same row inset, because they are the rail
            card, not two cards that resemble each other. What stood here before was a hand-rolled
            venue card (its own radius, its own inset), an uppercase eyebrow, and a{" "}
            <code className="font-mono text-ui">&lt;dl&gt;</code> of Model / Effort / Activity.
          </Caption>
        </Group>

        <Group heading="2 · What is in front">
          <Row>
            <Labelled label="A chat">
              <Rail>
                <Card facts={CHAT} venue={READY} />
              </Rail>
            </Labelled>
            <Labelled label="The same model, another account">
              <Rail>
                <Card facts={pinnedTo(1, "GitHub Copilot")} venue={READY} />
              </Rail>
            </Labelled>
            <Labelled label="… on another vendor">
              <Rail>
                <Card facts={pinnedTo(2, "OpenAI")} venue={READY} />
              </Rail>
            </Labelled>
            <Labelled label="… and another">
              <Rail>
                <Card facts={pinnedTo(3, "Google")} venue={READY} />
              </Rail>
            </Labelled>
            <Labelled label="No model policy yet">
              <Rail>
                <Card facts={{ ...CHAT, model: null, tier: null, effort: null }} venue={READY} />
              </Rail>
            </Labelled>
            <Labelled label="A terminal">
              <Rail>
                <Card
                  facts={{ kind: "terminal", running: "Claude Code", activity: "working" }}
                  venue={READY}
                />
              </Rail>
            </Labelled>
            <Labelled label="Nothing (the Board tab)">
              <Rail>
                <Card facts={null} venue={READY} />
              </Rail>
            </Labelled>
          </Row>
          <Caption>
            The vendor&apos;s mark leads the catalogue&apos;s own name — &ldquo;Claude Opus
            4.1&rdquo;, not the wire id <code className="font-mono text-ui">claude-opus-4-1</code> —
            over the tier and the effort. The mark is{" "}
            <code className="font-mono text-ui">model-identity.tsx</code>&apos;s, so the row agrees
            with the composer&apos;s pill rather than resembling it. The ACCOUNT is never spelled
            out: the first two columns are the same model bought from two accounts and the mark
            alone tells them apart, where a trailing &ldquo;· Anthropic&rdquo; would spend the width
            the name needs. Hover or focus a name for the whole identity. The rest are kinds of
            thing, not one kind with fields missing: a PTY has no model and no effort, so it says
            what it is RUNNING; a chat that has accepted no model policy yet falls back to its kind
            glyph; the Board tab is not a Session at all and says so in a line. The tree stays on
            screen in all of them — it is the project&apos;s, not the front tab&apos;s — which is
            why it belongs in the same card rather than in a block that comes and goes with the row
            above it.
          </Caption>
        </Group>

        <Group heading="3 · Activity, every state">
          <Row>
            {(
              [
                "working",
                "waiting",
                "starting",
                "ready",
                "idle",
                "parked",
                "interrupted",
                "stopped",
                "exited",
                "error",
              ] as const
            ).map((activity) => (
              <Labelled key={activity} label={activity}>
                <Rail>
                  <Card facts={{ ...CHAT, activity: activity as StatusDotState }} venue={CLEAN} />
                </Rail>
              </Labelled>
            ))}
          </Row>
          <Caption>
            One tone dot and one short phrase at the row&apos;s right edge — the roster&apos;s own
            column, so the eye lands in the same place here as on a list of Sessions. The words are
            <code className="font-mono text-ui"> SESSION_ACTIVITY_LABEL</code>&apos;s: this page
            used to keep a private map that said &ldquo;Ended&rdquo; where every other surface says
            &ldquo;Exited&rdquo;. The four lifecycle states no durable listing has a word for
            (Starting, Setting up, Ready, Failed) are still spelled here, and only those.
          </Caption>
        </Group>

        <Group heading="4 · The venue">
          <Row>
            <Labelled label="Reading">
              <Rail>
                <Card facts={CHAT} venue={{ status: "loading" }} />
              </Rail>
            </Labelled>
            <Labelled label="Faulted">
              <Rail>
                <Card facts={CHAT} venue={FAULTED} />
              </Rail>
            </Labelled>
            <Labelled label="Detached HEAD">
              <Rail>
                <Card facts={CHAT} venue={DETACHED} />
              </Rail>
            </Labelled>
            <Labelled label="Clean tree">
              <Rail>
                <Card facts={CHAT} venue={CLEAN} />
              </Rail>
            </Labelled>
          </Row>
          <Caption>
            Two skeleton rows while it reads, because the card at rest is three rows and a
            placeholder of a different shape is what makes the usage card below jump. A fault gets
            the sentence a person needs, the raw error on{" "}
            <code className="font-mono text-ui">title</code> where it cannot push the control off
            the row, and the one act that fixes it. A clean tree says nothing: &ldquo;0 loose&rdquo;
            is a number where there is no news.
          </Caption>
        </Group>

        <Group heading="5 · The floor (240px)">
          <Row>
            <Labelled label="Long path, long branch">
              <Rail width={RAIL_FLOOR} narrow>
                <Card facts={CHAT} venue={LONG} />
              </Rail>
            </Labelled>
            <Labelled label="The whole page">
              <Rail width={RAIL_FLOOR} narrow>
                <Now facts={CHAT} venue={LONG} window={window} onWindowChange={setWindow} />
              </Rail>
            </Labelled>
          </Row>
          <Caption>
            Every value truncates rather than widening the column, and each one that does carries a
            focus stop with the whole of it (VC-288) — the path, the branch, and the model name
            alike. The status phrase never truncates: it is the shortest thing on the row and the
            reason the row is read at all.
          </Caption>
        </Group>
      </div>
    </TooltipProvider>
  );
}

function Intro() {
  return (
    <div className="flex flex-col gap-2">
      <SectionHeading as="h2">What this is for</SectionHeading>
      <p className="max-w-content text-sm leading-prose text-muted-foreground">
        Home&apos;s Now page answers two questions mid-session: what is in front, and where does it
        write. Those were three drawings — a hand-rolled venue card, a key/value table, and the
        rail&apos;s shared usage card — and a Home Session runs in the Main checkout by
        construction, so the first two are one object. Every card below is the shipping{" "}
        <code className="font-mono text-ui">HomeSessionCard</code>, so what is on screen is what the
        rail decides.
      </p>
    </div>
  );
}

/** The page: the card, its eyebrow, and the usage card under it. */
function Now({
  facts,
  venue,
  window,
  onWindowChange,
}: {
  facts: HomeSessionFacts;
  venue: VenueEntry;
  window: UsageWindow;
  onWindowChange(next: UsageWindow): void;
}) {
  return (
    <>
      <Card facts={facts} venue={venue} />
      <HomeUsageBlock
        summary={PROJECT}
        models={MODELS}
        sessionCount={38}
        meteredSessionCount={24}
        session={SESSION}
        window={window}
        onWindowChange={onWindowChange}
      />
    </>
  );
}

/** The card as the rail mounts it — eyebrow included, since the pair is the block. */
function Card({ facts, venue }: { facts: HomeSessionFacts; venue: VenueEntry }) {
  return (
    <div className="flex flex-col gap-2 pt-4">
      <div className="px-4 group-data-[narrow=true]/rail:px-3">
        <SectionHeading as="h3">Session</SectionHeading>
      </div>
      <HomeSessionCard facts={facts} venue={venue} onRetryVenue={() => {}} />
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

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-start gap-6">{children}</div>;
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-label uppercase text-muted-foreground">{label}</p>
      {children}
    </div>
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
 * here responds to it in the app. Vertical padding only: a horizontal inset
 * would stack on the blocks' own and draw every card narrower than the rail
 * really draws it.
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
      className="group/rail flex shrink-0 flex-col rounded-container border border-border bg-background pb-4"
      data-narrow={narrow ? "true" : "false"}
      style={{ width }}
    >
      {children}
    </div>
  );
}
