/**
 * Home's Now page as ONE framed object: the Session in front, and the tree it
 * writes to (VC-406).
 *
 * NOT A PRODUCTION SURFACE ANY MORE — `home-rail.tsx` composes Now from its
 * own `BoardSessionsBlock` over the usage footer, and pins the checkout
 * under every page through `home-rail-footer.tsx`; the later VC-406 pass moved
 * "where does it write" out of this card and into that footer, where it is
 * true of Files and Search too. `home-rail.test.tsx` pins the absence. It is
 * kept because the UI lab still mounts it: `lab/scratches/home-rail-now.tsx`
 * draws it at every state it had to survive, and `lab/scratches/usage-surfaces.tsx`
 * puts it beside the usage card it was designed as a sibling of. The lab is
 * type-checked with the app (see `tsconfig.web.json`), so this export has real
 * callers a signature change would break; it is not dead code.
 *
 * Everything below is the reasoning as it stood when the card WAS the page,
 * kept because it is what the lab galleries are read against.
 *
 * WHAT IT REPLACES. The page drew this in three drawings. A hand-rolled venue
 * card (`rounded-row border-border bg-card p-4`, its own radius and its own
 * inset), then an uppercase eyebrow, then a `<dl>` of key/value lines — Model,
 * Effort, Activity, each label parked at the left with its value right-aligned
 * against it — and then the usage card, which is the rail's SHARED card
 * (`RAIL_CARD_FRAME`, seamed rows). Three objects for two scopes, and the
 * middle one was a string table: a shape that says "here are some fields"
 * rather than "here is a Session", and the one shape on the page nothing else
 * in the app was drawn in.
 *
 * ONE CARD, because the page has one subject said two ways. A Home Session
 * runs in the project's Main checkout — always, by construction — so "what is
 * in front" and "where does it write" are the same object's head and body, not
 * two blocks that happen to be adjacent. That is the ruling the Diffs page's
 * repository card already makes for the worktree (VC-406): the fact and the
 * thing it is about belong in one frame. The usage card below it then reads as
 * this card's sibling — same frame, same seam, same row inset — and the page is
 * two cards nesting the same two scopes: Session inside project, twice, once as
 * identity and once as money.
 *
 * THE IDENTITY ROW IS A ROSTER ROW, in the card's clothes. Kind glyph, name,
 * a quieter line under it, and the dot-plus-phrase at the right edge — the
 * exact reading order the ticket rail's roster, Home's own Sessions page and
 * the sidebar's bands all use, so a reader who has learned a Session row
 * anywhere in the app has learned this one. It is drawn on `RAIL_CARD_ROW`
 * rather than with `ui/list-row.tsx` for the reason that primitive's own
 * comment gives: a list row is a floating 12px-radius object inset to its
 * list's 8, and one drawn inside a card sits a rounded rectangle inside a
 * rounded rectangle at two different insets.
 *
 * WHAT IS ON THE ROW, AND WHY IT IS NOT MORE. The model is the name, because
 * the Session's title is already on the tab in front of the reader and the
 * model is the fact this page exists to keep answering after the empty chat is
 * gone. The tier and the effort are the quiet line under it: both are
 * qualifiers OF the model — "which one, set how hard" — and a qualifier that
 * takes its own labelled row is a qualifier promoted to a subject. Cost is not
 * here at all; it is the card below, beside the project total it is part of
 * (VC-203).
 *
 * THE MODEL IS A THING YOU RECOGNISE, NOT A STRING YOU READ. The vendor's mark
 * (`ModelMark` — the same glyph the composer's pill, the picker and Settings
 * wear) leads the CATALOGUE's name for it: "Claude Opus 4.1", not the wire id
 * `claude-opus-4-1`. This page printed the bare id, and it was the last place
 * in the app that did.
 *
 * THE ACCOUNT IS NOT SAID ON THE ROW. The roomier model surfaces append a
 * "· Anthropic" where two signed-in providers ship the same model name
 * (`needsProvider`), and in a column this narrow that term is what pushes the
 * NAME into an ellipsis — it took more of the fact than it added. The mark
 * carries it instead: marks are chosen by provider first, so an Opus from
 * Anthropic and an Opus from Copilot already wear different glyphs. Same
 * answer, drawn rather than spelled, and the words are still one hover or one
 * focus away in the reveal.
 *
 * The id survives as the fallback for a selection the catalogue does not list
 * — a provider signed out from under a pinned Session — which is the composer
 * pill's own behaviour: a model we cannot name is still the model this Session
 * will send to.
 *
 * THE WORDS ARE THE APP'S, NOT THIS FILE'S. Activity says what
 * `SESSION_ACTIVITY_LABEL` says, and effort says what `effortLabel` says —
 * both shared, because "Working" and "Extra high" are facts about a Session
 * rather than about a surface. This page used to keep a private map that said
 * "Ended" where every other surface says "Exited", and print the raw enum
 * `xhigh` where the composer's own chip says "Extra high".
 *
 * PURE, AND STORE-FREE, for the reason `home-usage-block.tsx` is: the UI lab
 * mounts the real component over fixtures (`lab/scratches/home-rail-now.tsx`),
 * so what is reviewed is what ships rather than a reimplementation of it. The
 * store reads and the venue's `ensure` stay in `home-rail.tsx`.
 */
import * as React from "react";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";

import { effortLabel } from "@volli/session-presentation";
import { venueLooseCount, type ModelAccessModel } from "@volli/shared";

import { venueKindLabel } from "@renderer/components/chat/empty/venue-chips";
import { venuePathTail } from "@renderer/components/home/home-rail-model";
import { ModelMark } from "@renderer/components/models/model-identity";
import {
  RAIL_CARD_FRAME,
  RAIL_CARD_ROW,
  RAIL_CARD_SEAM,
  RAIL_PANEL_MARGIN,
} from "@renderer/components/ticket/rail-panel-parts";
import { Button } from "@renderer/components/ui/button";
import { SESSION_ACTIVITY_LABEL } from "@renderer/components/ui/session-activity-status";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { ValueReveal } from "@renderer/components/ui/value-reveal";
import { cn } from "@renderer/lib/utils";
import type { VenueEntry } from "@renderer/stores/venue";

/**
 * What the Session in front IS — three kinds of thing, not one kind with
 * missing fields.
 *
 * A chat is a model and an effort. A TERMINAL is neither: it is a PTY, and
 * asking it for a model would print two dashes and call that a reading, so it
 * answers with what it actually has. The Board tab and a file tab are not
 * Sessions at all, and say so in a line (`null`).
 */
export type HomeSessionFacts =
  | {
      kind: "chat";
      /**
       * The model this Session is pinned to, resolved against the catalogue,
       * or `null` for one that has accepted no model policy yet. The row then
       * names the KIND rather than drawing a title made of punctuation — a
       * chat before its first turn is not a broken reading.
       */
      model: HomeSessionModel | null;
      /** The tier it resolved from, as its label, where a start named one (VC-259). */
      tier: string | null;
      /** The reasoning level, as its own enum spells it — labelled here. */
      effort: string | null;
      activity: StatusDotState;
    }
  | { kind: "terminal"; running: string; activity: StatusDotState }
  | null;

/**
 * A model as {@link ModelMark} takes one, plus the account behind it.
 *
 * Resolved by the caller rather than here because the drawing is pure: the
 * catalogue read lives in `home-rail.tsx`, and what arrives is the answer.
 */
export interface HomeSessionModel {
  model: Pick<ModelAccessModel, "providerId" | "modelId" | "label">;
  /**
   * The account as the catalogue names it. NOT drawn on the row — the mark is
   * what says whose model this is — but it is the lettermark's initial for a
   * vendor with no glyph of its own, and the reveal's second term, which is
   * where "whose account is billed for this" stays reachable.
   */
  providerLabel: string;
}

/**
 * The activity vocabulary this card can draw.
 *
 * `SESSION_ACTIVITY_LABEL` is the source for every state a durable Session
 * reaches; the four spelled here are the chat LIFECYCLE's own (a Session whose
 * executor is coming up, or has failed to), which no durable listing has a word
 * for. Composed rather than copied: the overlapping states cannot drift from
 * what the sidebar and the ticket rail call them, and this map cannot quietly
 * rename "Exited".
 */
const ACTIVITY_LABEL: Record<StatusDotState, string> = {
  ...SESSION_ACTIVITY_LABEL,
  setup: "Setting up",
  ready: "Ready",
  starting: "Starting",
  error: "Failed",
};

/** Every row of the card: the shared frame, at the card's own inset. */
const CARD_ROW = cn(RAIL_CARD_ROW, "min-h-8 py-2");

export function HomeSessionCard({
  facts,
  venue,
  onRetryVenue,
}: {
  facts: HomeSessionFacts;
  /** `undefined` before the first read — the same state as `loading` here. */
  venue: VenueEntry | undefined;
  onRetryVenue(): void;
}) {
  return (
    <section
      aria-label="Session"
      data-testid="home-session-card"
      className={cn(RAIL_CARD_FRAME, RAIL_PANEL_MARGIN, "flex flex-col")}
    >
      <IdentityRow facts={facts} />
      <VenueRows venue={venue} onRetry={onRetryVenue} />
    </section>
  );
}

/**
 * The head: what is in front, what it is running, and what it is doing.
 *
 * The status pair sits at the right edge at `text-label`, which is the
 * roster's own column — one tone dot and one short phrase, so a reader's eye
 * lands in the same place here as it does on a list of Sessions.
 */
function IdentityRow({ facts }: { facts: HomeSessionFacts }) {
  if (facts === null) {
    // Not a row with dashes in it: the Board tab HAS no model, and a table of
    // absences reads as a Session that failed to report rather than as no
    // Session at all.
    return (
      <p className={cn(CARD_ROW, "text-ui text-muted-foreground")} data-testid="home-session-none">
        No session in front
      </p>
    );
  }
  const model = facts.kind === "chat" ? facts.model : null;
  const meta = facts.kind === "chat" ? modelMetaLine(facts.tier, facts.effort) : null;

  return (
    <div className={CARD_ROW} data-testid="home-session-identity">
      {/* The vendor's mark leads, exactly as it does on the composer's pill: a
          Session pinned to a model is told apart by WHICH model far more often
          than by the fact that it is a chat. `size-4` rather than the mark's
          own 3.5, so it sits on the same left axis as the venue rows' glyphs
          under it. */}
      {model === null ? (
        <Glyph facts={facts} />
      ) : (
        <ModelMark
          model={model.model}
          providerLabel={model.providerLabel}
          className="size-4 self-start"
        />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        {model === null ? (
          <span className="truncate text-ui text-sidebar-foreground">
            {facts.kind === "chat" ? "Chat" : facts.running}
          </span>
        ) : (
          <ModelNameLine model={model} />
        )}
        {meta === null ? null : (
          <span className="truncate text-label text-muted-foreground">{meta}</span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1 text-label text-muted-foreground">
        <StatusDot state={facts.activity} />
        {ACTIVITY_LABEL[facts.activity]}
      </span>
    </div>
  );
}

/**
 * The model's name: one truncating line, with the whole identity — the name
 * AND the account — on a reveal (VC-288).
 *
 * `ModelName`, which every roomier model surface uses, wraps instead, and its
 * run would put the mark beside the middle of a three-line block and push the
 * venue rows down. A rail clips and hands the value back on hover AND on
 * focus; that is what the path and the branch under this row already do.
 */
function ModelNameLine({ model }: { model: HomeSessionModel }) {
  return (
    <ValueReveal
      term="Model"
      full={`${model.model.label} · ${model.providerLabel}`}
      side="left"
      className="min-w-0 truncate rounded-sm text-left text-ui text-sidebar-foreground"
    >
      {model.model.label}
    </ValueReveal>
  );
}

/**
 * The kind glyph, for the two rows that have no model mark to lead them: a
 * terminal (a PTY has no model) and a chat that has accepted no model policy
 * yet.
 */
function Glyph({ facts }: { facts: NonNullable<HomeSessionFacts> }) {
  const Icon = facts.kind === "chat" ? ChatCircleIcon : TerminalWindowIcon;
  return (
    <Icon
      weight="bold"
      aria-label={facts.kind === "chat" ? "Chat" : "Terminal"}
      className="size-4 shrink-0 text-muted-foreground"
    />
  );
}

/**
 * What trails the model's name: `Deep · High effort`.
 *
 * "effort" is said because the level alone is not a fact about itself — `High`
 * after a model name reads as a second claim about the MODEL, which is the
 * ambiguity `modelPillLabel` names when it refuses to append a bare level to a
 * model's name. Either term may be absent: a Session started without a tier
 * has none to report, and a model with no reasoning levels has no effort.
 */
export function modelMetaLine(tier: string | null, effort: string | null): string | null {
  const terms = [tier, effort === null ? null : `${effortLabel(effort)} effort`].filter(
    (term): term is string => term !== null,
  );
  return terms.length === 0 ? null : terms.join(" · ");
}

/**
 * The tree, under the Session that writes to it.
 *
 * TWO SKELETON ROWS WHILE IT READS, not one and not a spinner: the card's
 * resting height is the identity row plus these two, so a placeholder of the
 * same shape is what keeps the usage card below from jumping up and back as
 * the read lands.
 */
function VenueRows({ venue, onRetry }: { venue: VenueEntry | undefined; onRetry(): void }) {
  if (venue === undefined || venue.status === "loading" || venue.status === "resolving") {
    return (
      <div aria-hidden data-testid="home-venue-loading">
        {["w-3/5", "w-2/5"].map((width) => (
          <div key={width} className={cn(CARD_ROW, RAIL_CARD_SEAM)}>
            <Skeleton className={cn("h-3", width)} />
          </div>
        ))}
      </div>
    );
  }
  if (venue.status === "error") {
    // The rail's fault rule (`rail-panel-parts.tsx`): the sentence a person
    // needs on the row, the diagnostic on `title`, and the one action that
    // fixes it beside them. The raw read error at this width is an ellipsis
    // that pushes Retry off the end.
    return (
      <div
        className={cn(CARD_ROW, RAIL_CARD_SEAM)}
        title={venue.error}
        data-testid="home-venue-error"
      >
        <WarningIcon weight="bold" className="size-4 shrink-0 text-destructive" />
        <span className="min-w-0 flex-1 truncate text-ui text-muted-foreground">
          Couldn&apos;t read the venue
        </span>
        <Button size="xs" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  const loose = venueLooseCount(venue.venue.files);
  return (
    <>
      <VenueRow
        icon={FolderOpenIcon}
        term={venueKindLabel(venue.venue)}
        full={venue.venue.path}
        value={venuePathTail(venue.venue.path)}
        testId="home-venue-path"
      />
      {/* A detached HEAD has no branch to reveal — `detached` IS the whole
          value — so it stays a plain row rather than becoming a focus stop
          that opens a bubble repeating the word under it. */}
      {venue.venue.branch === null ? (
        <div className={cn(CARD_ROW, RAIL_CARD_SEAM)} data-testid="home-venue-branch">
          <GitBranchIcon weight="bold" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono text-ui text-muted-foreground">
            detached
          </span>
          <LooseCount loose={loose} />
        </div>
      ) : (
        <VenueRow
          icon={GitBranchIcon}
          term="Branch"
          full={venue.venue.branch}
          value={venue.venue.branch}
          trailing={<LooseCount loose={loose} />}
          testId="home-venue-branch"
        />
      )}
    </>
  );
}

/**
 * One venue fact as a card row: glyph, the truncating value, whatever the row
 * trails.
 *
 * BOTH VALUES TRUNCATE AND BOTH HAVE A WAY OUT OF IT (VC-288). A rail is
 * narrow by construction and a worktree path is not, so the row shows the tail
 * and `ValueReveal` carries the whole of it — a focus stop that goes nowhere,
 * the untruncated value as its accessible name, a bubble on hover and on focus
 * alike. This is the rail a reader checks to see which tree they are about to
 * change something in; "hover to find out" is the wrong last word on that
 * question.
 */
function VenueRow({
  icon: Icon,
  term,
  full,
  value,
  trailing,
  testId,
}: {
  icon: React.ComponentType<{ className?: string; weight?: "bold" }>;
  term: string;
  full: string;
  value: string;
  trailing?: React.ReactNode;
  testId: string;
}) {
  return (
    <div className={cn(CARD_ROW, RAIL_CARD_SEAM)} data-testid={testId}>
      <ValueReveal
        term={term}
        full={full}
        side="left"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left font-mono text-ui text-muted-foreground"
      >
        <Icon weight="bold" className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{value}</span>
      </ValueReveal>
      {trailing}
    </div>
  );
}

/**
 * How much is loose in the tree — silent at zero, because a clean tree has
 * nothing to report and "0 loose" is a number where there is no news.
 */
function LooseCount({ loose }: { loose: number }) {
  if (loose === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex shrink-0 items-center gap-1 text-ui tabular-nums text-attention">
          <StatusDot state="waiting" />
          {loose}
        </span>
      </TooltipTrigger>
      <TooltipContent side="left">
        {loose} uncommitted {loose === 1 ? "file" : "files"}
      </TooltipContent>
    </Tooltip>
  );
}
