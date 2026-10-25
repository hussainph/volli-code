/**
 * Home's checkout footer — the Main checkout, pinned under EVERY Home page
 * (VC-406).
 *
 * WHY IT IS A FOOTER AND NOT A CARD. It was the bottom half of a card on the
 * Now page (`home-session-card.tsx`), which meant the one fact a reader needs
 * while they are looking at Files or at Search — which tree am I about to
 * change something in — was only ever on the page they were not on. The Ticket
 * rail settled this one scope up: the checkout is true of the whole surface, so
 * it is a row pinned under the rail rather than a block inside one page. Home
 * and a Ticket are the same panel at two scopes, so they wear the same footer,
 * from the same constants (`RAIL_CHECKOUT_ROW` and its two targets).
 *
 * TWO TARGETS, EDGE TO EDGE. The branch at the left opens the identity —
 * which kind of checkout this is, and its whole path; the fact at the right
 * opens the body. Each fills its half of the 42px row out to the rail's own
 * content gutter, so there is no dead band between them and no inset that
 * pretends to be alignment.
 *
 * THE BODY OPENS UPWARD, into the room the scroller gives back, because the
 * row is pinned at the bottom and the thing the pointer is on must not move
 * out from under it. Same fold, same preference key (`railFolds.worktree`) as
 * the Ticket rail's worktree body: a reader who keeps the checkout open keeps
 * it open at both scopes.
 *
 * IT READS THE WORKING COPY, and only the working copy. `stores/working-copy.ts` is the one place
 * this question is answered — the empty chat draws the same reading — so a
 * second git read here would be two answers about one tree on one frame. The
 * read is PULLED, so the footer's own Retry is the recovery, exactly as the
 * card's was.
 *
 * IT DRAWS TWO READ STATES, NOT FIVE, and that is the store's shape rather
 * than an omission. `rail-read-feedback.ts` distinguishes a refresh over rows
 * already on screen from a first read, because a list store keeps a `pending`
 * flag beside its last-good rows. The working copy store deliberately keeps no such
 * flag: only the FIRST read announces itself, and a later one leaves the
 * reading on screen until it is replaced, so "refreshing" is not a state this
 * surface can be in. What is left is the pair the store can actually be in —
 * a first read in flight, and a read that failed — and each takes the body,
 * which is the same placement the shared grammar gives them.
 */
import * as React from "react";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";

import { workingCopyLooseCount } from "@volli/shared";

import { workingCopyKindLabel } from "@renderer/components/chat/empty/working-copy-chips";
import { homeCheckoutGlance, workingCopyPathTail } from "@renderer/components/home/home-rail-model";
import {
  RAIL_CHECKOUT_FACT,
  RAIL_CHECKOUT_IDENTITY,
  RAIL_CHECKOUT_ROW,
  RAIL_FOOTER,
  RAIL_PANEL_INSET,
  RailFold,
  RailFoldBody,
  RailFoldCaret,
  RailFoldTrigger,
} from "@renderer/components/ticket/rail-panel-parts";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { StatusDot } from "@renderer/components/ui/status-dot";
import { ValueReveal } from "@renderer/components/ui/value-reveal";
import { cn } from "@renderer/lib/utils";
import { useUiStore } from "@renderer/stores/ui";
import {
  useWorkingCopyStore,
  workingCopyKey,
  type WorkingCopyEntry,
} from "@renderer/stores/working-copy";

export function HomeCheckoutFooter({ projectId }: { projectId: string }) {
  const workingCopy = useWorkingCopyStore(
    (state) => state.byScope[workingCopyKey(projectId, null)],
  );
  const open = useUiStore((state) => state.railFolds.worktree);
  React.useEffect(() => {
    void useWorkingCopyStore.getState().ensure(projectId, null);
  }, [projectId]);
  // `refresh`, not `ensure`: `ensure` answers from the cache, so a retry routed
  // through it would do nothing on exactly the surface that offers it.
  const retry = React.useCallback(
    () => void useWorkingCopyStore.getState().refresh(projectId, null),
    [projectId],
  );

  const snapshot = workingCopy?.status === "ready" ? workingCopy.workingCopy : null;
  const failed = workingCopy?.status === "error";
  const glance = homeCheckoutGlance({ workingCopy: snapshot, failed });
  // The branch is the identity, and a detached HEAD has none — the word is the
  // whole value then, exactly as the card said it.
  const branch = snapshot === null ? null : (snapshot.branch ?? "detached");

  return (
    <RailFold
      asChild
      open={open}
      onOpenChange={(next) => useUiStore.getState().setRailFold("worktree", next)}
    >
      <section data-testid="home-checkout-footer" className={RAIL_FOOTER}>
        {/* THE BODY COMES FIRST in the DOM: it unfolds ABOVE the row. */}
        <RailFoldBody>
          <div
            className={cn(
              "flex flex-col gap-2 border-b border-sidebar-border/70 pt-3 pb-3",
              RAIL_PANEL_INSET,
            )}
          >
            <CheckoutBody workingCopy={workingCopy} onRetry={retry} />
          </div>
        </RailFoldBody>
        <div className={RAIL_CHECKOUT_ROW}>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="home-checkout-identity"
                aria-label={branch === null ? "Main checkout" : `Main checkout on ${branch}`}
                className={RAIL_CHECKOUT_IDENTITY}
              >
                <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-ui text-sidebar-foreground">
                  {branch ?? "Main checkout"}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" side="top" className="flex w-72 flex-col gap-4 p-4">
              <div className="flex flex-col gap-1">
                <SectionHeading as="p">Checkout</SectionHeading>
                <span className="px-2 text-ui text-foreground">
                  {snapshot === null ? "Reading…" : workingCopyKindLabel(snapshot)}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <SectionHeading as="p">Path</SectionHeading>
                <span
                  title={snapshot?.path}
                  className="block truncate px-2 font-mono text-ui text-foreground"
                >
                  {snapshot?.path ?? <span className="text-muted-foreground">—</span>}
                </span>
              </div>
            </PopoverContent>
          </Popover>
          <RailFoldTrigger asChild>
            <button
              type="button"
              data-testid="home-checkout-fold"
              aria-label={`${glance === null ? "Main checkout" : `Main checkout: ${glance.phrase}`}. ${
                open ? "Hide" : "Show"
              } details`}
              className={RAIL_CHECKOUT_FACT}
            >
              {glance === null ? null : (
                <span
                  data-testid="home-checkout-glance"
                  className="flex shrink-0 items-center gap-1 text-label text-muted-foreground"
                >
                  <StatusDot state={glance.tone} />
                  {glance.phrase}
                </span>
              )}
              <RailFoldCaret open={open} placement="footer" />
            </button>
          </RailFoldTrigger>
        </div>
      </section>
    </RailFold>
  );
}

/**
 * What the fold holds: the tree's path, and how much is loose in it.
 *
 * The branch is on the row above, so it is not repeated here — the body's job
 * is what the row could not fit. A read that has never landed takes the body
 * whole (the shared grammar's `body` placement); a refresh over a reading
 * already drawn leaves the reading in place and says so on its own line, which
 * is the fold's version of the heading mark and what the fold re-measures
 * around.
 */
function CheckoutBody({
  workingCopy,
  onRetry,
}: {
  workingCopy: WorkingCopyEntry | undefined;
  onRetry(): void;
}) {
  if (
    workingCopy === undefined ||
    workingCopy.status === "loading" ||
    workingCopy.status === "resolving"
  ) {
    return (
      <div aria-hidden data-testid="home-checkout-loading" className="flex flex-col gap-2">
        {["w-3/5", "w-2/5"].map((width) => (
          <Skeleton key={width} className={cn("h-3", width)} />
        ))}
      </div>
    );
  }
  if (workingCopy.status === "error") {
    // The rail's fault rule: the sentence a person needs on the row, the
    // diagnostic on `title`, and the one action that fixes it beside them.
    return (
      <div
        role="alert"
        title={workingCopy.error}
        data-testid="home-checkout-error"
        className="flex items-center gap-2"
      >
        <span className="min-w-0 flex-1 truncate text-ui text-muted-foreground">
          Couldn&apos;t read the checkout
        </span>
        <Button size="xs" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  const loose = workingCopyLooseCount(workingCopy.workingCopy.files);
  return (
    <>
      <ValueReveal
        term={workingCopyKindLabel(workingCopy.workingCopy)}
        full={workingCopy.workingCopy.path}
        side="top"
        className="min-w-0 truncate rounded-sm text-left font-mono text-ui text-muted-foreground"
      >
        {workingCopyPathTail(workingCopy.workingCopy.path)}
      </ValueReveal>
      <div className="flex items-center justify-between gap-2 text-ui text-muted-foreground">
        <span>Working tree</span>
        <span className="tabular-nums">
          {loose === 0 ? "Clean" : `${loose} uncommitted ${loose === 1 ? "file" : "files"}`}
        </span>
      </div>
    </>
  );
}
