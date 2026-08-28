/**
 * The repository card's CI row (VC-182) — what GitHub Actions is saying about
 * this ticket's PR, drawn as a peer of the changes and branch rows and sitting
 * directly above the publish controls, which is where the question is asked:
 * did this pass before I merge it and call the ticket done.
 *
 * It is a THIRD ROW, not a fourth block, and not a badge on the PR button. The
 * card's rows already answer "what changed" and "where is it"; "did it build"
 * is the same kind of fact, read the same way, and giving it the row shape means
 * a reader learns one interaction (press for detail) rather than three. The
 * popover is the detail, exactly as the branch row's is.
 *
 * IT DRAWS NOTHING when there is no PR, no rollup, or no state yet
 * (`resolvePrChecks` answers `null`). That is the ticket's "optionally": a repo
 * with no Actions workflow has no checks to report, so the row is simply absent
 * — no setting, no empty state, no "CI not configured" line explaining a
 * negative. A row that appears the moment a project gains a pipeline is a
 * better answer than a switch nobody knew to turn on.
 *
 * SURFACING, NEVER GATING (decision #44). Nothing here disables the done-flow
 * primary or the wrap-up: a failing suite is stated plainly and the merge stays
 * the person's call, the same way the merge-conflict notice below it does.
 *
 * The data is the merge-watch's own poll — the same `gh pr view` body it has
 * always read, whose `statusCheckRollup` used to be reduced to a count of
 * failures and thrown away. No new subprocess, no new cadence, no second
 * network seam.
 *
 * NO SKELETON, AND IT COSTS SOMETHING. The watch holds its observations in
 * memory and polls candidates SEQUENTIALLY, one `gh` subprocess each, so on a
 * board of twenty tickets a late one has no observation for tens of seconds
 * after launch. Open it in that window and the row is absent, then appears —
 * pushing the publish controls below it down. The changes row solves its own
 * version of this with a `Skeleton`, and this one deliberately does not.
 *
 * The reason is that a skeleton here cannot be honest. "Checks are coming" is
 * not knowable before the first poll: the most we have is `prUrl`, and plenty
 * of repositories have pull requests and no pipeline. Drawing a placeholder on
 * that evidence would trade a settle for repositories WITH CI against a phantom
 * row on every ticket in a repository WITHOUT it — flashing a feature you do
 * not have, at the cost of the one property this design is built on: that it
 * costs nothing to a project that will never use it. The settle is paid by the
 * people the row is for, which is the right way round.
 */
import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CircleDashedIcon } from "@phosphor-icons/react/dist/csr/CircleDashed";
import { MinusCircleIcon } from "@phosphor-icons/react/dist/csr/MinusCircle";
import { XCircleIcon } from "@phosphor-icons/react/dist/csr/XCircle";

import type { PrCheck, PrCheckState, TicketRetentionState } from "../../../../ipc/contract";

import { resolvePrChecks, type PrChecksView } from "@renderer/components/ticket/pr-checks-model";
import { RAIL_CARD_ROW } from "@renderer/components/ticket/rail-panel-parts";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { cn } from "@renderer/lib/utils";

/**
 * One glyph and one ink per state, decided once so the row's verdict and every
 * line in its popover cannot disagree about what red means.
 *
 * `pending` is a DASHED CIRCLE, not a spinner. The rollup is refreshed by a
 * 60-second poll, so a spinning glyph would claim a liveness the surface does
 * not have — and `globals.css` already settled the general form of this call
 * for the session rings: a thing that spins is asking for attention it has not
 * earned, and amber is what asks for attention here. The dashed ring says
 * "unsettled" without pretending to animate the build.
 *
 * Outline throughout, per the icon convention; `fill` is reserved for the one
 * exceptional item and a check row is a list of peers.
 *
 * `word` is ONE check's state and is deliberately in a different tense from the
 * row's aggregate label: a single finished job "failed", while a suite with an
 * unresolved failure in it "is failing". The label counts an ongoing condition;
 * this names a settled outcome.
 */
const STATE_STYLE: Record<
  PrCheckState,
  { Icon: typeof CheckCircleIcon; ink: string; word: string }
> = {
  passing: { Icon: CheckCircleIcon, ink: "text-positive", word: "passed" },
  failing: { Icon: XCircleIcon, ink: "text-destructive", word: "failed" },
  pending: { Icon: CircleDashedIcon, ink: "text-attention", word: "running" },
  skipped: { Icon: MinusCircleIcon, ink: "text-muted-foreground", word: "skipped" },
};

function StateIcon({ state, className }: { state: PrCheckState; className?: string }) {
  const { Icon, ink } = STATE_STYLE[state];
  return <Icon aria-hidden className={cn("size-4 shrink-0", ink, className)} />;
}

/**
 * The app's one sanctioned external-open seam, the same one the card's View PR
 * uses: `window.open` of an http(s) target never opens a BrowserWindow — main's
 * `setWindowOpenHandler` denies it and hands the url to `shell.openExternal`.
 */
function openExternal(url: string) {
  window.open(url, "_blank", "noopener");
}

/**
 * One check in the popover. A check with a `detailsUrl` is a button into its
 * log; one without is a plain row rather than a button that would go nowhere —
 * a legacy status context often publishes no target, and a control that looks
 * pressable and does nothing is worse than a line of text.
 *
 * The workflow name leads, muted, in GitHub's own "CI / Check + Test" shape:
 * a matrix suite repeats job names across workflows, and the workflow is what
 * tells two identically-named rows apart.
 */
function CheckLine({ check }: { check: PrCheck }) {
  const { word } = STATE_STYLE[check.state];
  const label = check.workflow === null ? check.name : `${check.workflow} / ${check.name}`;
  // Read out of the object before the branch below: narrowing a PROPERTY does
  // not survive into the click handler's closure, so the guard would prove
  // nothing where it is actually needed.
  const { url } = check;

  const body = (
    <>
      <StateIcon state={check.state} />
      <span className="min-w-0 flex-1 truncate">
        {check.workflow === null ? null : (
          <span className="text-muted-foreground">{check.workflow} / </span>
        )}
        {check.name}
      </span>
    </>
  );

  if (url === null) {
    return (
      <div
        title={`${label} · ${word}`}
        className="flex w-full items-center gap-2 rounded-control px-2 py-1 text-ui text-foreground"
      >
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => openExternal(url)}
      title={`${label} · ${word}`}
      aria-label={`${label}, ${word}. Open the run on GitHub`}
      className="group/check flex w-full items-center gap-2 rounded-control px-2 py-1 text-left text-ui text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/45"
    >
      {body}
      <ArrowSquareOutIcon
        aria-hidden
        className="size-3 shrink-0 text-muted-foreground opacity-0 group-focus-visible/check:opacity-100 group-hover/check:opacity-100"
      />
    </button>
  );
}

/**
 * The popover's contents: the breakdown, every check, and the way out to
 * GitHub.
 *
 * Exported for the rail suite, on the same grounds as
 * `WorktreeDestinationControl` next door — this is where the feature's actual
 * information lives, and a popover portals out of a static render, so a test
 * that only mounted the row would assert the one line and none of the detail.
 * Separate from {@link ChecksPopoverContent} because a bare `PopoverContent`
 * has no Radix context to render into.
 */
export function ChecksDetail({ view }: { view: PrChecksView }) {
  return (
    <>
      <div className="flex items-center justify-between gap-2 px-2 pt-1">
        <SectionHeading as="p">Checks</SectionHeading>
        {view.summary === null ? null : (
          <span className="truncate text-ui text-muted-foreground">{view.summary}</span>
        )}
      </div>
      {/* Capped and scrollable: a monorepo's matrix can publish thirty rows,
          and a popover as tall as the window is a panel that happens to float.
          The `Checks` line above is a `<p>` (the card's popovers all are), so it
          names nothing on its own — the list says what it is for a reader who
          arrives inside it. */}
      <ul
        aria-label="Checks on this pull request"
        className="flex max-h-64 flex-col overflow-y-auto"
      >
        {/* Workflow + name IS the check's identity — GitHub makes a job name
            unique within its workflow, and a matrix leg carries its axis in the
            name ("test (20)"). Not the url: a re-run mints a fresh `detailsUrl`
            for the same job, which would remount every row on every retry. */}
        {view.checks.map((check) => (
          <li key={`${check.workflow ?? ""}/${check.name}`}>
            <CheckLine check={check} />
          </li>
        ))}
      </ul>
      <div className="border-t border-border pt-1">
        <button
          type="button"
          onClick={() => openExternal(view.checksUrl)}
          className="flex w-full items-center gap-2 rounded-control px-2 py-1 text-left text-ui text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/45"
        >
          <ArrowSquareOutIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          All checks on GitHub
        </button>
      </div>
    </>
  );
}

/** {@link ChecksDetail} in the popover surface the row's trigger opens. */
function ChecksPopoverContent({ view }: { view: PrChecksView }) {
  return (
    <PopoverContent align="start" className="flex w-80 flex-col gap-1 p-1">
      <ChecksDetail view={view} />
    </PopoverContent>
  );
}

/**
 * The card's CI row. Takes the ticket's retention state (the merge-watch's last
 * poll) and renders nothing at all unless there is a rollup to report — see the
 * module header for why that absence IS the feature.
 */
export function PrChecksRow({ retention }: { retention: TicketRetentionState | null }) {
  const view = React.useMemo(() => resolvePrChecks(retention), [retention]);
  if (view === null) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="ticket-repository-checks"
          title={view.summary ?? view.label}
          // The breakdown goes in BOTH, because `aria-label` overrides the
          // accessible name outright: with only `title` carrying it, a mouse
          // user hovering got "1 failing · 3 passed" and a screen-reader user
          // got the one-line verdict and no way to reach the rest without
          // opening the popover. Same information, both ways in.
          aria-label={`${view.label}${view.summary === null ? "" : `, ${view.summary}`}. Show checks`}
          className={cn(
            RAIL_CARD_ROW,
            "min-h-8 border-t border-sidebar-border/70 py-2 hover:bg-accent/50",
          )}
        >
          <StateIcon state={view.verdict} />
          <span className="min-w-0 flex-1 truncate text-ui font-medium">{view.label}</span>
          <CaretDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <ChecksPopoverContent view={view} />
    </Popover>
  );
}
