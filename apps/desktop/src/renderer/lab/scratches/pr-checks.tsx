/**
 * The repository card's CI row (VC-182), at every state it has to survive.
 *
 * The question this scratch answers: does the row stay READABLE and HONEST at
 * rail width? Almost the whole design is notation — one glyph and one ink per
 * state, one counted line, a breakdown that suppresses itself when it would
 * only repeat the line above — and notation only fails where it is cramped or
 * where a state is rare. So every row below is pinned to a real rail width
 * rather than laid out to fit the page, and the rare states (all-skipped, a
 * thirty-job matrix, a workflow name longer than the column) get the same room
 * as the common ones.
 *
 * Read it in this order:
 *   1. The verdicts — the four states, in the card frame they really wear.
 *   2. Narrow — the same four at the 240px floor, where labels truncate.
 *   3. The popover — where the detail lives, including the scroll cap.
 *   4. The absences — the three ways this row draws nothing at all.
 *
 * Every row is the SHIPPING component over the shipping resolver: the fixtures
 * below are `TicketRetentionState` values, exactly what `volli:retention-state`
 * returns, so what is on screen is what `resolvePrChecks` decides — never a
 * mock-up of it. (Section 4 depends on that: a hand-drawn "nothing" would
 * prove nothing about when the real row hides itself.)
 */
import * as React from "react";

import type { PrCheck, TicketRetentionState } from "../../../ipc/contract";

import { resolvePrChecks } from "@renderer/components/ticket/pr-checks-model";
import { ChecksDetail, PrChecksRow } from "@renderer/components/ticket/pr-checks-row";
import { SectionHeading } from "@renderer/components/ui/section-heading";

export const title = "PR checks row (VC-182)";
export const note = "CI status in the repository card — every verdict, at rail width";

/** The rail's two widths, from `stores/ui.ts`. */
const RAIL_DEFAULT = 300;
const RAIL_FLOOR = 240;

const PR_URL = "https://github.com/demo/voltaic/pull/482";

// ─── fixtures ───────────────────────────────────────────────────────────────

function check(name: string, state: PrCheck["state"], over: Partial<PrCheck> = {}): PrCheck {
  return {
    name,
    workflow: "CI",
    state,
    url: "https://github.com/demo/voltaic/actions/runs/1/job/1",
    ...over,
  };
}

/** A retention state carrying nothing but the rollup — all this row ever reads. */
function withChecks(checks: readonly PrCheck[], prUrl: string | null = PR_URL) {
  return {
    ticketId: "tkt-11",
    prUrl,
    prState: "open",
    hasConflicts: false,
    checks: [...checks],
    archiveReady: false,
    reason: null,
    keep: false,
    dismissed: false,
  } satisfies TicketRetentionState;
}

/** The common case a suite is in most of the time it is looked at. */
const RUNNING = withChecks([
  check("Check + Test", "pending"),
  check("Desktop smoke (manual)", "skipped"),
  check("CodeRabbit", "passing", { workflow: null, url: null }),
]);

/** The case the whole feature exists for: do not merge this yet. */
const FAILING = withChecks([
  check("Check + Test", "failing"),
  check("Typecheck", "passing"),
  check("Desktop smoke (manual)", "skipped"),
  check("CodeRabbit", "passing", { workflow: null, url: null }),
]);

/** The resting state — and the one whose label deliberately drops the count. */
const PASSING = withChecks([
  check("Check + Test", "passing"),
  check("Typecheck", "passing"),
  check("Desktop smoke (manual)", "skipped"),
]);

/**
 * A workflow filtered out entirely — a paths-ignore, a manual gate. The one
 * state where a green check would actually mislead, so it does not get one.
 */
const ALL_SKIPPED = withChecks([
  check("Check + Test", "skipped"),
  check("Desktop smoke (manual)", "skipped"),
]);

/** One check, to prove the singular reads as a sentence and not as "1 checks". */
const SINGLE = withChecks([check("build", "failing")]);

/** Names longer than the column, which is where truncation is judged. */
const LONG_NAMES = withChecks([
  check("Check + Test (macos-15, node 24, electron 43)", "failing", {
    workflow: "Continuous Integration / Pull request",
  }),
  check("deploy-preview/voltaic-desktop-nightly-channel", "pending", { workflow: null }),
]);

/** A matrix big enough to hit the popover's scroll cap. */
const BIG_MATRIX = withChecks([
  check("lint", "failing"),
  check("typecheck", "failing"),
  ...["18", "20", "22", "24"].flatMap((node) => [
    check(`test (ubuntu, node ${node})`, "passing"),
    check(`test (macos, node ${node})`, node === "24" ? "pending" : "passing"),
    check(`test (windows, node ${node})`, node === "18" ? "skipped" : "passing"),
  ]),
  check("build", "pending"),
  check("Desktop smoke (manual)", "skipped"),
  check("CodeRabbit", "passing", { workflow: null, url: null }),
]);

// ─── the scratch ────────────────────────────────────────────────────────────

export default function PrChecksScratch() {
  return (
    <div className="flex flex-col gap-8">
      <Intro />

      <Group heading="1 · The four verdicts, in the card frame">
        <div className="flex flex-wrap gap-4">
          <Card label="Failing" state={FAILING} />
          <Card label="Running" state={RUNNING} />
          <Card label="Passed" state={PASSING} />
          <Card label="Skipped" state={ALL_SKIPPED} />
        </div>
        <Caption>
          Click any row — the popover is the detail, exactly as the branch row above it works. One
          failure outranks every pass, and anything still running outranks a clean partial result: a
          suite three-quarters green is not green yet. The passed row drops its count on purpose
          (&ldquo;All checks passed&rdquo;, not &ldquo;2 checks passed&rdquo;) because the number is
          not the news; the failing and running rows keep theirs because it is.
        </Caption>
      </Group>

      <Group heading="2 · The floor (240px), where labels truncate">
        <div className="flex flex-wrap gap-4">
          <Card label="Single check" state={SINGLE} width={RAIL_FLOOR} narrow />
          <Card label="Long names" state={LONG_NAMES} width={RAIL_FLOOR} narrow />
          <Card label="Failing" state={FAILING} width={RAIL_FLOOR} narrow />
        </div>
        <Caption>
          The row&rsquo;s own line is short by construction, so the floor is really a test of the
          POPOVER: open &ldquo;Long names&rdquo; and check that a workflow longer than the column
          truncates instead of widening it. The singular is the other thing to read here — &ldquo;1
          check failing&rdquo;, never &ldquo;1 checks&rdquo;.
        </Caption>
      </Group>

      <Group heading="3 · The popover, inline">
        <div className="flex flex-wrap items-start gap-4">
          <Popover label="Mixed suite" state={FAILING} />
          <Popover label="30-job matrix" state={BIG_MATRIX} />
        </div>
        <Caption>
          Drawn inline at the popover&rsquo;s real width so the two can be compared side by side —
          in the app this is portalled, one at a time. Read three things: failing rows come first
          (the reason anyone opened it), the workflow leads each job muted in GitHub&rsquo;s own
          &ldquo;CI / Check + Test&rdquo; shape, and the matrix scrolls at its cap rather than
          growing a popover as tall as the window. CodeRabbit is the row with no link: a legacy
          status context that published no target is a line of text, not a button that goes nowhere.
        </Caption>
      </Group>

      <Group heading="4 · The absences">
        <div className="flex flex-wrap gap-4">
          <Card label="No pipeline" state={withChecks([])} note="empty rollup" />
          <Card label="No PR yet" state={withChecks([check("build", "passing")], null)} />
          <Card label="Not loaded" state={null} note="retention state null" />
        </div>
        <Caption>
          All three draw nothing, and the first one is the feature. A project with no GitHub Actions
          workflow has no checks on its PRs, so the row is simply absent — no setting, no empty
          state, no &ldquo;CI not configured&rdquo; line explaining a negative. That is what makes
          this surface cost nothing to a repo that will never use it.
        </Caption>
      </Group>
    </div>
  );
}

function Intro() {
  return (
    <div className="flex flex-col gap-2">
      <SectionHeading as="h2">What this is for</SectionHeading>
      <p className="max-w-content text-ui leading-prose text-muted-foreground">
        The repository card&rsquo;s third row: whether CI is happy with this ticket&rsquo;s PR,
        between the branch it is on and the button that publishes it. It surfaces and never gates —
        nothing here disables the done-flow primary, the same way the merge-conflict notice below it
        does not. Every row is <code className="font-mono text-ui">PrChecksRow</code> over a real{" "}
        <code className="font-mono text-ui">TicketRetentionState</code>, so the verdicts and the
        ordering are the shipping resolver&rsquo;s, not a mock-up&rsquo;s.
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
 * The row inside the repository card's own frame, on the rail's backdrop.
 *
 * `group/rail` plus `data-narrow` is the real contract — `rail-panel-parts.tsx`
 * drives its narrow inset off exactly this — and the section wrapper repeats
 * the card's own classes from `ticket-repository-summary.tsx` so the seam above
 * the row is the seam it will really sit under. The stand-in rows above and
 * below are what make that seam visible at all: a row drawn alone has no
 * neighbours to be flush with, which is the one thing this scratch exists to
 * check.
 */
function Card({
  label,
  state,
  note: cardNote,
  width = RAIL_DEFAULT,
  narrow = false,
}: {
  label: string;
  state: TicketRetentionState | null;
  note?: string;
  width?: number;
  narrow?: boolean;
}) {
  const draws = resolvePrChecks(state) !== null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-label font-medium uppercase text-muted-foreground">{label}</p>
      <div
        className="group/rail flex shrink-0 flex-col"
        data-narrow={narrow ? "true" : "false"}
        style={{ width }}
      >
        <section className="overflow-hidden rounded-xl border border-sidebar-border/70 bg-background/50 dark:bg-accent/50">
          <StandInRow>3 changes</StandInRow>
          <PrChecksRow retention={state} />
          <div className="border-t border-sidebar-border/70 px-4 py-2 text-ui text-muted-foreground">
            (publish controls)
          </div>
        </section>
      </div>
      {draws ? null : (
        <p className="text-ui text-muted-foreground">
          renders nothing{cardNote === undefined ? "" : ` — ${cardNote}`}
        </p>
      )}
    </div>
  );
}

/** The card's first row, so the CI row's seam has something to be flush against. */
function StandInRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex w-full items-center gap-2 px-4 pt-4 pb-2 text-ui font-medium text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * The popover's contents at the surface's real width, drawn inline.
 *
 * `ChecksDetail` rather than the popover itself: Radix portals its content to
 * the body one at a time, so two open popovers cannot be compared side by side
 * — and comparison is the whole point of this section. The frame repeats
 * `PopoverContent`'s own width and padding so what is measured here is what
 * ships.
 */
function Popover({ label, state }: { label: string; state: TicketRetentionState }) {
  const view = resolvePrChecks(state);
  if (view === null) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-label font-medium uppercase text-muted-foreground">{label}</p>
      <div className="flex w-80 flex-col gap-1 rounded-container border border-border bg-popover p-1 shadow-overlay">
        <ChecksDetail view={view} />
      </div>
    </div>
  );
}
