/**
 * The pieces the Calm Stack's pages share
 * (the retired ticket-right-sidebar lab scratch: `RowActions`, `PausedBanner`,
 * `ScenarioState`, `DiffTotals`).
 *
 * They live here rather than in one panel because the scratch draws each of
 * them once and uses it from several pages — a row's hover actions, a fault
 * banner and the +/− pair are facts about a rail page, not about changes or
 * files or the repository card in particular. A copy per caller is how one
 * surface silently keeps an old minus glyph after the other is fixed.
 */
import * as React from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CaretUpIcon } from "@phosphor-icons/react/dist/csr/CaretUp";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { FilePlusIcon } from "@phosphor-icons/react/dist/csr/FilePlus";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { Slot } from "radix-ui";

import { errorMessage, type DiffStat } from "@volli/shared";

import type { RailReadFeedback } from "@renderer/components/ticket/rail-read-feedback";
import { Button } from "@renderer/components/ui/button";
import { Notice } from "@renderer/components/ui/notice";
import { SECTION_HEADING, SectionHeading } from "@renderer/components/ui/section-heading";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { prefersReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";

/**
 * Every rail page insets to the column's edge, and tightens at the 240px floor.
 *
 * THE NARROW STEP IS 12px, and it is a recorded exception to the 0/4/8/16/24
 * spacing collapse. The step exists to buy content width back on a rail the user
 * has dragged narrow, so it has to be SMALLER than 16 and still be an inset; the
 * collapsed ladder's next rung down is 8, which halves the edge and reads as a
 * different surface rather than a tighter one. Run mechanically the sweep made
 * both halves 16 and the narrow variant became a no-op — the rail simply stopped
 * responding to its own width, silently. `ticket-sessions-panel-rows.test.tsx`
 * asserts the pair, which is how that was caught; keep it asserting.
 */
export const RAIL_PANEL_INSET = "px-4 group-data-[narrow=true]/rail:px-3";

/** The same inset expressed as a horizontal MARGIN, for blocks that float inside a page. */
export const RAIL_PANEL_MARGIN = "mx-4 group-data-[narrow=true]/rail:mx-3";

/**
 * A Now-page section's title line: the uppercase eyebrow at the left, whatever
 * the block offers at the right — Sessions' `+ Chat`, History's count,
 * Automations' door to its page. Inset by the rows' own `px-2` rather than the
 * section's edge, so the label sits over its list instead of hanging left of
 * it.
 *
 * `ui/section-heading.tsx` deliberately owns only the ink, because across the
 * app the row around it is drawn nine ways. Inside THIS rail it is drawn one
 * way, and the blocks that stack on the Now page have to be indistinguishable
 * as objects: a second copy of this row is how one block silently keeps an old
 * gap after its neighbour's control is retuned.
 */
export function RailSectionHeadingRow({
  label,
  status,
  children,
}: {
  label: string;
  /**
   * What the block's read is doing, as {@link RailHeadingReadStatus} draws it.
   * Beside the label rather than at the right edge: the right edge is the
   * control's, and a mark that swapped places with it as reads came and went
   * would move the control out from under the pointer.
   */
  status?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-1 flex items-center justify-between gap-2 px-2">
      <span className="flex min-w-0 items-center gap-1.5">
        <SectionHeading>{label}</SectionHeading>
        {status}
      </span>
      {children}
    </div>
  );
}

/**
 * The rail's ONE fold: what opens and closes in place on a rail page, and how
 * it moves (VC-406). Three things fold — the roster's record under the
 * Sessions eyebrow, the worktree body under its footer row, the cost breakdown
 * under its — and they are one object drawn three times, so the motion is
 * spelled once here.
 *
 * THE TRIGGER NEVER MOVES. A body that opens BELOW its trigger (the eyebrow's
 * record) grows downward into the scroller; a body that opens ABOVE its
 * trigger (a footer row's) grows upward into the space the scroller gives
 * back. Either way the thing the pointer is on stays under the pointer, and a
 * second press lands where the first did. The alternative for a footer —
 * header above body, the row rising by the body's height — was drawn and
 * rejected in the comparison scratch: it reads correctly and it moves the
 * target out from under the hand, which is worse.
 *
 * THE MOTION is a measured `height` TRANSITION — 200ms on the strong
 * `--ease-out`, the caret 150ms on the same curve — and it is a transition
 * rather than the `collapsible-down/up` keyframes `ui/accordion.tsx` runs on
 * for one reason: a fold is pressed twice in a second. Keyframes restart from
 * their own zero, so a close interrupted halfway jumped back to full height
 * and fell again. A transition retargets from the CURRENT computed height, so
 * a reversal continues from where the eye is. `height` is a layout property
 * and normally the wrong thing to animate, but a fold's whole effect is that
 * the surface around it resizes; the layout pass is the purpose, not the cost,
 * and 200ms bounds it. Nothing else animates: the rows inside do not fade or
 * slide, because they are data the reader came to read.
 *
 * NOT RADIX. Radix's `Collapsible` was what this was, and its `Presence` only
 * watches CSS ANIMATIONS (`animationName`), so a transition-driven close
 * unmounts the body on the first frame — and its content keeps its own
 * measurement effect, which zeroes `transitionDuration` on every state change.
 * The pieces it did give away are cheap to keep honest here: `useId` wires
 * `aria-controls`/`aria-expanded` to the body, `Slot` keeps `asChild`, and the
 * body still unmounts its children once closed rather than sitting mounted
 * under a clip.
 *
 * THE GATES ship with it. A toggle from the KEYBOARD (`event.detail === 0`,
 * how a browser reports Enter/Space on a button) and `prefers-reduced-motion`
 * — read at the moment of the toggle, so a setting changed mid-session lands
 * on the next press — both drop the height transition AND the caret's turn:
 * the state change is instant, not merely faster. The closing body is `inert`
 * from the first frame of the close, and if focus was inside it when the close
 * began it returns to the trigger rather than falling to the document.
 */
const FOLD_MS = 200;

type RailFoldContextValue = {
  open: boolean;
  /** Whether the CURRENT change runs with no motion at all. */
  instant: boolean;
  contentId: string;
  triggerRef: React.RefObject<HTMLElement | null>;
  toggle(instant: boolean): void;
};

const RailFoldContext = React.createContext<RailFoldContextValue | null>(null);

function useRailFold(part: string): RailFoldContextValue {
  const fold = React.useContext(RailFoldContext);
  if (fold === null) throw new Error(`${part} must be rendered inside a RailFold.`);
  return fold;
}

export function RailFold({
  open,
  defaultOpen = false,
  onOpenChange,
  asChild = false,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "onChange"> & {
  /** Controlled state. Omit it and the fold keeps its own. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?(open: boolean): void;
  asChild?: boolean;
}) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultOpen);
  // React state rather than a ref: the caret is a sibling of the body and has
  // to be drawn without its transition in the SAME commit the state flips in.
  const [instant, setInstant] = React.useState(false);
  const contentId = React.useId();
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const isOpen = open ?? uncontrolled;

  const value = React.useMemo<RailFoldContextValue>(
    () => ({
      open: isOpen,
      instant,
      contentId,
      triggerRef,
      toggle(keyboard) {
        setInstant(keyboard || prefersReducedMotion());
        if (open === undefined) setUncontrolled(!isOpen);
        onOpenChange?.(!isOpen);
      },
    }),
    [isOpen, instant, contentId, open, onOpenChange],
  );

  const Comp = asChild ? Slot.Root : "div";
  return (
    <RailFoldContext.Provider value={value}>
      <Comp
        data-slot="rail-fold"
        data-state={isOpen ? "open" : "closed"}
        className={className}
        {...props}
      >
        {children}
      </Comp>
    </RailFoldContext.Provider>
  );
}

/** The press. Carries the body's `aria-controls` pair and how the change moves. */
export function RailFoldTrigger({
  asChild = false,
  onClick,
  ref,
  ...props
}: React.ComponentProps<"button"> & { asChild?: boolean }) {
  const fold = useRailFold("RailFoldTrigger");
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      type="button"
      {...props}
      ref={(node: HTMLElement | null) => {
        fold.triggerRef.current = node;
        if (typeof ref === "function") ref(node as HTMLButtonElement | null);
        else if (ref) ref.current = node as HTMLButtonElement;
      }}
      data-slot="rail-fold-trigger"
      data-state={fold.open ? "open" : "closed"}
      aria-controls={fold.contentId}
      aria-expanded={fold.open}
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event);
        // `detail` is 0 for Enter/Space on a button and ≥1 for a real click:
        // the keyboard path is the one that must not animate.
        if (!event.defaultPrevented) fold.toggle(event.detail === 0);
      }}
    />
  );
}

/** The fold's body: measured, transitioned, clipped while it moves. */
export function RailFoldBody({ className, children, ...props }: React.ComponentProps<"div">) {
  const fold = useRailFold("RailFoldBody");
  const { open } = fold;
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  // Mounted while open AND through a close, so the body has something to
  // measure on the way down; dropped once it is shut.
  const [present, setPresent] = React.useState(open);
  const shown = React.useRef(open);
  const mounted = React.useRef(false);
  const focusInside = React.useRef(false);
  /** Detaches the in-flight run's listener and fallback timer. */
  const settle = React.useRef<(() => void) | null>(null);

  React.useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body === null) return;

    /**
     * A close pulls the ground out from under whatever was focused inside it.
     * `inert` lands in the same commit and blurs it to nothing, so the flag is
     * kept by the body's own focus events and a blur with no `relatedTarget`
     * — focus that went NOWHERE — does not clear it.
     */
    function returnFocus(node: HTMLElement): void {
      const active = document.activeElement;
      const lost = active === null || active === document.body || node.contains(active);
      if (focusInside.current && lost) fold.triggerRef.current?.focus();
      focusInside.current = false;
    }
    function rest(node: HTMLElement): void {
      node.style.transition = "";
      // `auto` while open, so the body tracks content that grows under it.
      node.style.height = open ? "auto" : "0px";
      if (!open) setPresent(false);
    }

    // The first frame is a resting state, never a movement: a rail that
    // unfolded everything it remembered on every mount would animate a layout
    // the reader never asked to change.
    if (!mounted.current) {
      mounted.current = true;
      body.style.height = open ? "auto" : "0px";
      return;
    }
    if (shown.current === open) return;
    // Opening: mount the children first, then measure them on the next pass.
    if (open && !present) {
      setPresent(true);
      return;
    }
    shown.current = open;
    // Detach only — the height stays where the interrupted run left it, which
    // is what the reversal transitions FROM.
    settle.current?.();
    if (!open) returnFocus(body);

    if (fold.instant || prefersReducedMotion()) {
      rest(body);
      return;
    }

    const from = body.getBoundingClientRect().height;
    const to = open ? (contentRef.current?.getBoundingClientRect().height ?? 0) : 0;
    body.style.transition = "none";
    body.style.height = `${from}px`;
    void body.offsetHeight; // commit the start height before the target lands
    body.style.transition = `height ${FOLD_MS}ms var(--ease-out)`;
    body.style.height = `${to}px`;

    function finish(): void {
      settle.current?.();
      // Re-checked because a closure loses the guard above, not because the
      // ref can empty: the run is detached before the body can unmount.
      if (body !== null) rest(body);
    }
    function onEnd(event: TransitionEvent): void {
      if (event.target === body && event.propertyName === "height") finish();
    }
    body.addEventListener("transitionend", onEnd);
    // A transition that never runs (a body that measures zero either way, a
    // display-less environment) still has to land the resting state.
    const timer = window.setTimeout(finish, FOLD_MS + 60);
    settle.current = () => {
      body.removeEventListener("transitionend", onEnd);
      window.clearTimeout(timer);
      settle.current = null;
    };
  }, [open, present, fold.instant, fold.triggerRef]);

  // Content that grows while the body is opening retargets the run in flight
  // (a read landing under a fold that is still moving). Never while closing:
  // the destination there is zero whatever the content does.
  React.useEffect(() => {
    const body = bodyRef.current;
    const content = contentRef.current;
    if (body === null || content === null || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => {
      if (settle.current === null || !shown.current) return;
      body.style.height = `${content.getBoundingClientRect().height}px`;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => () => settle.current?.(), []);

  return (
    <div
      ref={bodyRef}
      id={fold.contentId}
      data-slot="rail-fold-body"
      data-state={open ? "open" : "closed"}
      // Nothing inside a shutting body is reachable — by tab, by pointer or by
      // a screen reader — while it is still on screen.
      inert={!open}
      onFocus={() => {
        focusInside.current = true;
      }}
      onBlur={(event) => {
        if (event.relatedTarget !== null) focusInside.current = false;
      }}
      className={cn("overflow-hidden", !open && "h-0", className)}
      {...props}
    >
      {/* The measured child: its height is the fold's target, and what a
          ResizeObserver watches. The clip lives on the parent. */}
      <div ref={contentRef}>{present ? children : null}</div>
    </div>
  );
}

/**
 * The caret that says which way a fold opens, and whether it is open.
 *
 * An eyebrow's fold opens DOWN, under the label, so its caret points right
 * while closed and turns to point down: the file-browser idiom, read by
 * everyone. A footer row's fold opens UP, over the row, so its caret points
 * up while closed and turns to point down once the body is standing above
 * it — pointing at where the body went, and at what pressing again does.
 *
 * It turns with the body or not at all: the fold's instant gates reach the
 * caret through the context, so a keyboard press changes a still picture and
 * the CSS gate keeps covering a reduced-motion change that came from anywhere
 * else.
 */
export function RailFoldCaret({
  open,
  placement,
}: {
  open: boolean;
  placement: "eyebrow" | "footer";
}) {
  const Caret = placement === "eyebrow" ? CaretRightIcon : CaretUpIcon;
  const instant = React.useContext(RailFoldContext)?.instant ?? false;
  return (
    <Caret
      aria-hidden
      weight={placement === "eyebrow" ? "bold" : undefined}
      className={cn(
        "shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none",
        instant && "transition-none",
        placement === "eyebrow" ? "size-2.5" : "size-3",
        open && (placement === "eyebrow" ? "rotate-90" : "rotate-180"),
      )}
    />
  );
}

/**
 * A section eyebrow whose LABEL is a fold's trigger (the Sessions block, whose
 * record folds under its live rows). Same geometry as {@link RailSectionHeadingRow}
 * — the label at the left, at most one control at the right — with the label
 * drawn as a button carrying the caret. The caret follows the word rather
 * than leading it so the eyebrow column stays one straight line down the
 * page. Must sit inside a {@link RailFold}.
 *
 * `foldable` OFF draws a plain eyebrow: a roster with no record has nothing
 * to fold, and a caret that opens onto nothing is a lie about the block.
 */
export function RailFoldHeadingRow({
  label,
  open,
  foldable,
  triggerLabel,
  testId,
  status,
  children,
}: {
  label: string;
  open: boolean;
  foldable: boolean;
  /** The trigger's accessible name — what pressing it does, in the reader's terms. */
  triggerLabel: string;
  testId?: string;
  /** {@link RailSectionHeadingRow}'s read mark, in the foldable eyebrow. */
  status?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-1 flex items-center justify-between gap-2 px-2">
      <span className="flex min-w-0 items-center gap-1.5">
        {foldable ? (
          // Still a heading in the document — the button is INSIDE it, so the
          // outline keeps its section and the trigger keeps its name.
          <h2 className={SECTION_HEADING}>
            <RailFoldTrigger asChild>
              <button
                type="button"
                aria-label={triggerLabel}
                data-testid={testId}
                className="flex items-center gap-1 rounded-sm uppercase outline-none transition-colors duration-150 ease-out hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              >
                {label}
                <RailFoldCaret open={open} placement="eyebrow" />
              </button>
            </RailFoldTrigger>
          </h2>
        ) : (
          <SectionHeading>{label}</SectionHeading>
        )}
        {status}
      </span>
      {children}
    </div>
  );
}

/**
 * What a block's heading says about a read while rows are already on screen
 * (VC-406) — the drawing for `rail-read-feedback.ts`'s `heading` placement.
 *
 * IT RIDES THE ROW THE BLOCK ALREADY OWNS and never reserves one. The earlier
 * revision of this design gave every heading a fixed-height status strip
 * beneath it, blank at rest; that is 24px of nothing under every block on the
 * page, paid for a state most blocks are in for half a second a minute. The
 * eyebrow is 28px in every state, so the mark has to fit inside it — which is
 * also why the WORD is optional and off by default: a section eyebrow already
 * holds a label and one control, and a third thing there is what pushes the
 * control off the end of a 240px rail.
 *
 * THE SENTENCE ALWAYS REACHES THE READER even when the face is a bare glyph:
 * `detail` is the accessible name and the hover title, and the live region
 * announces it. A failed refresh additionally carries the block's own Retry,
 * because the rows under it are stale and the reader is the one who decides
 * whether that matters.
 *
 * The turning mark is the only motion on working data, and `motion-reduce`
 * stops it outright — the mark stays, so the state is still legible without
 * movement.
 */
export function RailHeadingReadStatus({
  feedback,
  onRetry,
  word = false,
  testId,
}: {
  feedback: RailReadFeedback;
  /** Re-runs the read this block owns. Local to the block, never app-wide. */
  onRetry(): void;
  /**
   * Draw the short face beside the mark. OFF inside a section eyebrow (label
   * plus one control is already the row's budget); ON for a page heading, where
   * it still yields to the rail's narrow step.
   */
  word?: boolean;
  testId?: string;
}) {
  if (feedback === null || feedback.place !== "heading") return null;
  const failed = feedback.kind === "refresh-failed";
  const Mark = failed ? WarningIcon : ArrowClockwiseIcon;
  return (
    <span
      role={failed ? "alert" : "status"}
      data-testid={testId}
      data-read-status={feedback.kind}
      title={feedback.detail}
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-1 text-label",
        failed ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <Mark
        aria-hidden
        weight="bold"
        className={cn(
          "size-3 shrink-0",
          !failed && "animate-spin [animation-duration:1.2s] motion-reduce:animate-none",
        )}
      />
      {/* The whole sentence, for a screen reader and for `getByText`, whether or
          not the face is drawn. */}
      <span className="sr-only">{feedback.detail}</span>
      {word ? (
        <span aria-hidden className="truncate group-data-[narrow=true]/rail:hidden">
          {feedback.face}
        </span>
      ) : null}
      {failed ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Retry — ${feedback.detail}`}
          onClick={onRetry}
        >
          <ArrowClockwiseIcon />
        </Button>
      ) : null}
    </span>
  );
}

/**
 * What a block's BODY says when a read has never landed — the drawing for
 * `rail-read-feedback.ts`'s `body` placement, minus the pending case, which
 * every caller already answers with its own skeleton.
 *
 * A refused first read is the case this exists for. The block has no rows, and
 * the two sentences it could draw — "nothing here" and "this could not be
 * read" — are opposite claims; production drew them together on two pages. The
 * failure wins, and it brings the one action that can change it.
 */
export function RailReadFaultBody({
  feedback,
  detail,
  onRetry,
  testId,
  className,
}: {
  feedback: RailReadFeedback;
  /** The transport's own words, for the hover title. Never onto the row. */
  detail?: string | null;
  onRetry(): void;
  testId?: string;
  className?: string;
}) {
  if (feedback === null || feedback.place !== "body" || feedback.kind !== "failed") return null;
  return (
    <div
      role="alert"
      data-testid={testId}
      data-read-status="failed"
      title={detail ?? undefined}
      className={cn(
        "flex items-center gap-2 rounded-lg border border-dashed border-sidebar-border px-2 py-2 text-ui text-muted-foreground",
        className,
      )}
    >
      <WarningIcon aria-hidden weight="bold" className="size-3.5 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1 truncate">{feedback.face}</span>
      <Button size="xs" variant="outline" onClick={onRetry}>
        <ArrowClockwiseIcon />
        Retry
      </Button>
    </div>
  );
}

/**
 * A rail footer's shell and its row: the top rule the pinned rows wear
 * (VC-406), and the row geometry every footer face shares — the mark at the
 * left where every rail row's mark sits, then the face, then the caret.
 */
export const RAIL_FOOTER = "shrink-0 border-t border-sidebar-border/70 bg-background/30";
export const RAIL_FOOTER_ROW = cn(
  "flex min-h-8 w-full items-center gap-2 py-2 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring",
  RAIL_PANEL_INSET,
);

/**
 * The checkout row: ONE row, TWO targets, and every pixel of it belongs to one
 * of them (VC-406, revision 05).
 *
 * The row answers two questions — which tree is this, and what is going on in
 * it — so it is two buttons rather than one with two jobs. What the review
 * caught was the geometry around them: the identity read as though it were
 * indented from the page titles above it, and the strip between the two targets
 * was a dead band that looked pressable and was not.
 *
 * So the rule is EDGE-ALIGNED TARGETS. The identity starts at the rail's own
 * content gutter, exactly where a page title starts (16px, 12px at the narrow
 * step — {@link RAIL_PANEL_INSET}'s pair, spelled here as the single side each
 * target owns); the fact ends at that same gutter on the right. They meet in
 * the middle with nothing between them, so the pointer is always on one or the
 * other, and the inner edges take the padding the two faces need to breathe
 * rather than an inset that pretends to be alignment.
 *
 * 42px, which is the row's own arithmetic rather than a number chosen for the
 * look of it: a `text-ui` line at 20px between 8px of padding a side, plus the
 * 2px the row's targets need to stay legible as targets at the rail's floor.
 * It is the tallest thing in the footer stack and the one the eye lands on
 * last, which is the trade the design accepts for a target a pointer can hit
 * without aiming.
 */
export const RAIL_CHECKOUT_ROW = "flex min-h-[42px] items-stretch";

/** The left target: the tree's identity, from the content gutter inward. */
export const RAIL_CHECKOUT_IDENTITY =
  "flex min-w-0 flex-1 items-center gap-2 py-2 pr-2 pl-4 text-left outline-none group-data-[narrow=true]/rail:pl-3 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring";

/** The right target: the one fact, and the fold's caret, out to the same gutter. */
export const RAIL_CHECKOUT_FACT =
  "flex shrink-0 items-center gap-2 py-2 pr-4 pl-2 text-left outline-none group-data-[narrow=true]/rail:pr-3 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring";

/**
 * One repository-card row's shared frame: full-width, quiet hover, seam above
 * every row but the first.
 *
 * NOT `ui/list-row.tsx`, and the difference is the card. These are edge-to-edge
 * rows inside a framed surface, separated by seams and inset to the card's own
 * 16 — a list row is a floating 12px-radius object inset to its list's 8, and
 * one drawn in here would sit a rounded rectangle inside a rounded rectangle
 * with two different insets. What they DID share was the omission: both were
 * `<button>`s with no `focus-visible` treatment at all, which is a keyboard
 * user with no idea which of the card's rows they are on. That is the
 * primitive's recipe, spelled here because the row is not.
 *
 * It lives out here, with the rail's other shared pieces, because the card is
 * no longer one file: the CI row (`pr-checks-row.tsx`) is a peer of the changes
 * and branch rows and has to be indistinguishable from them, and a second copy
 * of this string is how one row silently keeps an old hover after its
 * neighbours are fixed.
 */
export const RAIL_CARD_ROW =
  "flex w-full items-center gap-2 px-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The framed card those rows sit in, and the hairline between them.
 *
 * SPELLED HERE FOR THE REASON {@link RAIL_CARD_ROW} IS. The repository card
 * declared both inline; then the CI row took a copy of the seam; then the usage
 * card (VC-203) took a copy of both, in a file whose own comment said that a
 * second hand-typed copy of `border-sidebar-border/70` is how one surface
 * silently keeps an old border after the other is retuned. Three copies of a
 * recipe whose entire purpose is that two cards are INDISTINGUISHABLE as
 * objects is the drift path already open, not a hypothetical one.
 *
 * The frame carries no margin. A card floating in a rail page wants
 * {@link RAIL_PANEL_MARGIN}; one nested inside an already-inset block wants
 * nothing, and baking a margin in here would make the second case override the
 * first rather than compose with it.
 *
 * `shrink-0` because `overflow-hidden` is load-bearing twice over: it clips
 * rows to the rounded corners, and — per the flexbox spec — it also collapses
 * the item's automatic minimum size (`min-height: auto`) to ZERO. Flex items
 * shrink BEFORE a scroll container's scrollbar engages, so in the Now page's
 * `overflow-y-auto` column a long-enough sessions list handed all of its
 * compression to the one child with a zero floor: the repository card crushed
 * to a border-and-corners sliver in prod 0.1.2 while every text block around
 * it bottomed out at its content height. The card refuses to shrink; overflow
 * is the column scrollbar's job.
 */
export const RAIL_CARD_FRAME =
  "shrink-0 overflow-hidden rounded-xl border border-sidebar-border/70 bg-background/50 dark:bg-accent/50";

/** The seam above every card row but the first. */
export const RAIL_CARD_SEAM = "border-t border-sidebar-border/70";

/**
 * The one button recipe a rail page presses: an `outline` Button on the
 * rail's own border, a resting wash, and the raised tier's lift.
 *
 * Spelled here for the reason {@link RAIL_CARD_FRAME} is. The repository
 * card's publish row wrote it three times inline (the primary, its `⋯`, the
 * PR link), and the Automations block below it drew its own split button as a
 * `secondary` pill — flat, filled, full-width — so the two acts the Now page
 * offers wore two different costumes ten pixels apart, and a reader had to
 * work out from context which of them was a button (VC-406). One recipe,
 * composed by every act on the page, is what makes "this is a button" a
 * fact about the drawing rather than a thing to infer.
 *
 * Only the material is here. Size stays with the primitive (`sm` / `icon-sm`,
 * the toolbar rung), and width is the row's decision: the recipe must work for
 * a control that truncates its own label and for a bare icon beside it.
 */
export const RAIL_CONTROL = "border-sidebar-border bg-background/30 text-ui shadow-raised";

/**
 * Insertions and deletions as one pair — the repository card's changes row, the
 * Diffs header, and the commit gate all wear it.
 *
 * On the canvas's own semantics now, not raw palette. The old exception —
 * "added and removed are a fixed, universally-read pair, not a canvas-derived
 * surface" — had the first half right and drew the wrong conclusion from it:
 * `--positive` is hue-locked precisely so that green stays green on a cool
 * workspace, which is what makes the pair readable AND themed instead of one
 * or the other.
 */
export function DiffTotals({ diff }: { diff: DiffStat }) {
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono text-ui font-medium tabular-nums">
      <span className="text-positive">+{diff.insertions}</span>
      <span className="text-destructive">−{diff.deletions}</span>
    </span>
  );
}

/**
 * A row's hover affordances: copy the path, open it as a persistent tab. Hidden
 * until the row is hovered or something inside it takes focus, so a list of
 * twenty files is twenty filenames rather than forty buttons.
 *
 * The copy button swaps its glyph to a check for 900ms — the only feedback a
 * clipboard write can honestly give, since there is nothing on screen to show
 * for it.
 */
export function RailRowActions({
  path,
  onOpen,
  className,
}: {
  path: string;
  onOpen(path: string): void;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  // Held so the timer can be cleared if the row unmounts mid-flash (a refresh
  // can drop the file out of the list) — setting state on a gone component is
  // the one way this tiny affordance can throw.
  const timer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 900);
    } catch (error) {
      toastError(`Couldn't copy the path: ${errorMessage(error)}`);
    }
  }

  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-100 group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none",
        className,
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Copy ${path}`}
            onClick={(event) => {
              event.stopPropagation();
              void copy();
            }}
          >
            {copied ? <CheckCircleIcon /> : <CopyIcon />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{copied ? "Path copied" : "Copy path"}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Open ${path} in tab`}
            onClick={(event) => {
              event.stopPropagation();
              onOpen(path);
            }}
          >
            <ArrowSquareOutIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Open in tab</TooltipContent>
      </Tooltip>
    </span>
  );
}

/**
 * A read stopped landing, so what is on screen below is a frozen snapshot.
 * Inline rather than a replacement: the rows already drawn were accurate as of
 * the last refresh, and hiding them would throw away real information to report
 * a transport fault.
 *
 * ONE banner for every such fault in the rail — the Diffs watch, the repository
 * card's watch, and a directory read the Files page could not complete. Three
 * shapes for one sentence was how the rail ended up printing raw watcher text on
 * one page and not another.
 *
 * `label` is the sentence a person needs; the underlying error text goes to
 * `title` and never onto the row, because at the rail's width it pushes Retry
 * off the end.
 *
 * The drawing is `ui/notice.tsx` now — this is the rail's inset around it, plus
 * the two things a fault in a dragged-narrow column needs and a general notice
 * does not: `truncate`, so a long label can never grow the row past the width
 * the user chose, and the retry itself. Retry is a real `Button`; it used to be
 * a bare `<button>` with `hover:underline` and no focus ring, which is a
 * keyboard user who can reach the only recovery on the surface and cannot see
 * that they have.
 */
export function RailFaultBanner({
  label = "Updates paused",
  error,
  onRetry,
  inset = true,
  testId,
  className,
}: {
  /** What stopped, in the reader's terms. Defaults to the watch's own wording. */
  label?: string;
  error: string;
  onRetry(): void;
  /** OFF where the banner already sits inside a padded block (the repository card). */
  inset?: boolean;
  testId?: string;
  className?: string;
}) {
  return (
    <Notice
      announce
      truncate
      tone="error"
      icon={WarningIcon}
      title={label}
      hoverTitle={error}
      data-testid={testId}
      // The rail's own narrow step over the notice's 16, for the reason
      // RAIL_PANEL_INSET exists: at the 240px floor the label and Retry share
      // one line, and four pixels a side is the difference between a sentence
      // and an ellipsis.
      className={cn(RAIL_PANEL_INSET, inset && cn("mb-2 shrink-0", RAIL_PANEL_MARGIN), className)}
      actions={
        <Button size="xs" variant="outline" onClick={onRetry}>
          <ArrowClockwiseIcon />
          Retry
        </Button>
      }
    />
  );
}

/**
 * The first-load placeholder: three pulsing bars at row height, rather than a
 * centred "Loading…" line. A rail page is a list, so the honest shape of the
 * wait is a list — and it holds the column's width steady instead of collapsing
 * to a sentence and snapping back.
 */
export function RailPanelSkeleton({ label, testId }: { label: string; testId: string }) {
  return (
    <div className="flex flex-col gap-2 p-4" data-testid={testId} aria-label={`Loading ${label}`}>
      {["w-4/5", "w-3/5", "w-full"].map((width) => (
        <Skeleton key={width} className={cn("h-8", width)} />
      ))}
    </div>
  );
}

/**
 * New File, in the navigator header, at BOTH scopes (VC-191).
 *
 * Beside Filter rather than on a row, for the reason Attach is there: it acts
 * on the FOLDER the navigator is standing in, not on whatever is under the
 * cursor — and it is the only door to creating a file in an EMPTY folder, where
 * there is no row to right-click. New Folder… deliberately has no twin here:
 * the header is a place for the one gesture a person reaches for constantly,
 * the row menu carries the rest, and two adjacent plus-glyphs read as one
 * control that someone drew twice.
 */
export function NewFileRailAction({
  disabled = false,
  onNewFile,
}: {
  /** Read-only (VC-576): the project's host cannot take a new file. */
  disabled?: boolean;
  onNewFile(): void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="New file"
          disabled={disabled}
          onClick={onNewFile}
        >
          <FilePlusIcon />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">New file</TooltipContent>
    </Tooltip>
  );
}

/**
 * What a navigator's filter matches: the whole project-relative path, not just
 * the basename.
 *
 * Spelled once because the two panels had answered it differently — one
 * matched `relPath`, the other the bare name — which made the same magnifier,
 * with the same placeholder, mean two things. The path is the useful answer:
 * typing `renderer` in a repository root should find the folder, and typing
 * `home-rail` inside a folder should still match a row named for its path.
 */
export function railNavigatorMatch(query: string, relPath: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === "" || relPath.toLowerCase().includes(needle);
}
