/**
 * Chat activity presentation.
 *
 * One left edge. Every line in the transcript — the bundle summary, the rows it
 * counts, reasoning, an expanded payload — starts at the same x, and depth is
 * never spelled as indentation. Containment is said by the caret and by
 * adjacency; a row's disclosure opens *in line*, so opening something makes the
 * list longer rather than making it a tree. Nothing here is bordered: this file
 * draws only process you audit, and the one object you act on — the card under
 * a gated call — is the interaction itself, mounted by the caller.
 *
 * Every row is the same primitive — `‹glyph› ‹Verb› ‹object›` left, `‹meta›`
 * right — and all variance lives in the per-kind presenters in `activity.ts`.
 * Two click targets: the row expands its detail, the mono object opens the real
 * artifact.
 */
import {
  CaretRightIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  CopyIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderIcon,
  GaugeIcon,
  GlobeSimpleIcon,
  HandPalmIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  ProhibitIcon,
  SpinnerGapIcon,
  TerminalWindowIcon,
  UsersThreeIcon,
  WrenchIcon,
  XCircleIcon,
  type Icon,
} from "@phosphor-icons/react";
import type { ActivityKind } from "@volli/shared";
import type { DynamicToolUIPart, ReasoningUIPart } from "ai";
import * as React from "react";

import { useStopFollowing } from "@renderer/components/ui/ai-elements/conversation";
import { ReasoningBody, useElapsed } from "@renderer/components/ui/ai-elements/reasoning";
import {
  bundleNeedsAttention,
  bundleSummary,
  describeActivity,
  reasoningBody,
  reasoningStatus,
  splitPath,
  type ActivityDetail,
  type ActivityRow,
  type ActivityStatus,
  type BundleRow,
  type SummarySegment,
  type SummaryTone,
} from "@renderer/chat/activity";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";

/* ------------------------------------------------------------------- motion */

/**
 * The disclosure does not animate, and the caret is the whole of what does.
 *
 * It used to tween `grid-template-rows` for 400ms, which is a layout property:
 * every frame of the open relaid and repainted the entire expanded body, and
 * that body is a 300-line diff often enough to matter — 300 `<div>`s measured
 * twenty-four times to show them once. The mirrored 400ms JS timer that held
 * the children mounted through the close was the same cost again, on a subtree
 * already on its way out of the DOM.
 *
 * Nothing replaced it, because nothing needed to. The height animation was
 * making a continuity argument — "this body came from that row" — and the caret
 * was already making it, adjacent to the label it opens and rotating in place.
 * What the reader wants from a transcript row is the output, and 400ms is a
 * long time to make someone wait to start reading it.
 *
 * 150ms, then, on the same curve as the caret's own hover fade: with the body
 * instant, the rotation IS the disclosure's motion, and a glyph still turning
 * long after the thing it discloses has arrived reads as lag.
 */
const CARET_SPIN = "duration-150 ease-swift motion-reduce:transition-none";

/**
 * The one caret, and it always sits against the label it opens.
 *
 * Three columns, three jobs: the left glyph says what happened, the caret hugs
 * the text it discloses, and the far right belongs to the number alone. Parked
 * at the right edge instead — as container rows and leaf rows each did in their
 * own way — the caret shares that edge with the meta, and durations come out on
 * as many different margins as there are row shapes. Perplexity's transcript
 * settles it the same way.
 *
 * Rotated, never swapped — a swapped glyph cannot animate, and reads as a
 * flicker. `hidden` keeps the slot so the meta column stays aligned across rows
 * that can and cannot expand.
 */
function Caret({
  open,
  hidden,
  pinned,
  className,
}: {
  open: boolean;
  hidden?: boolean;
  /** Always visible. A collapsed turn must advertise its own way back in. */
  pinned?: boolean;
  className?: string;
}) {
  return (
    // Two elements even though both now run at 150ms: the wrapper's fade is
    // keyed to hover and the glyph's rotation to open, and collapsed onto one
    // node `transition-opacity` would win the merge and the rotation would snap.
    <span
      className={cn(
        "shrink-0 transition-opacity duration-150 ease-swift motion-reduce:transition-none",
        // A disclosure is an available action, not hidden information: tool
        // calls keep their caret on screen so the way into their command and
        // output is visible before the row is reached. Non-disclosures retain
        // the slot invisibly, which keeps every row's right edge aligned.
        open || pinned
          ? "opacity-100"
          : "opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100",
        hidden && "invisible",
        className,
      )}
    >
      <CaretRightIcon
        aria-hidden
        className={cn(
          "size-3 text-muted-foreground transition-transform",
          CARET_SPIN,
          open && "rotate-90",
        )}
      />
    </span>
  );
}

/**
 * A closed body is not in the DOM. That is the whole of it.
 *
 * A transcript holding fifty closed tool rows was once emitting every one of
 * their payloads — a 300-line diff is 300 `<div>`s that nobody can see — and
 * rebuilding all of them on every streamed token. That invariant is unchanged
 * and is what this component exists for; what left is the machinery that used
 * to schedule it. There is no wrapper element either: with no track to animate
 * there is nothing for one to hold, and an always-mounted zero-height grid is a
 * node per closed row for no one.
 */
function Disclosure({ open, children }: React.PropsWithChildren<{ open: boolean }>) {
  return open ? <>{children}</> : null;
}

/** Selecting output text must not collapse the row under the pointer. */
function hasTextSelection(): boolean {
  return (window.getSelection()?.toString().length ?? 0) > 0;
}

/**
 * One row shell, one left edge.
 *
 * The summary, every row it counts, and the reasoning line beside them all use
 * this. Nothing in the transcript is indented to show containment — a bundle's
 * rows sit at exactly the summary's left edge and the caret is the only thing
 * that says one holds the other. Indentation would put the machine columns on
 * their own margin, which is the ragged left edge this design exists to remove.
 */
const ROW_CLASS =
  "group/row flex w-full min-w-0 items-center gap-1 rounded-md py-1 text-left text-ui text-muted-foreground outline-none transition-colors";
const ROW_INTERACTIVE = "cursor-pointer hover:bg-muted/30 hover:text-foreground";
/** Only for rows that are themselves a control — a tool row's ring is on its caret. */
const ROW_FOCUSABLE = "focus-visible:ring-1 focus-visible:ring-ring";

/**
 * Click opens a row; dragging a selection across it does not.
 *
 * The row itself is deliberately not a button. It used to be — `role="button"`,
 * `tabIndex`, and a keydown handler — and that made everything interactive
 * inside it (the mono object that opens the file, Copy) a control nested in a
 * control. That is invalid ARIA, and it was a live bug: Enter on the focused
 * file object bubbled to the row's handler, which called `preventDefault()`, and
 * cancelling that keydown cancels the click the browser was about to synthesize
 * on the button that had focus. The file never opened, the row toggled instead,
 * and a file was simply unreachable from the keyboard.
 *
 * So the div keeps `onClick` as a generous pointer target, and {@link RowDisclosure}
 * is the real focusable control that owns the caret. Three honest tab stops per
 * row — disclosure, object, Copy — in place of one that lied about the other two.
 */
function useRowToggle(expandable: boolean) {
  const [open, setOpen] = React.useState(false);
  const stopFollowing = useStopFollowing();
  const toggle = () => {
    if (hasTextSelection() || !expandable) return;
    // Opening grows the transcript above the reader's eye, so the autoscroll
    // must not chase it — see {@link useStopFollowing}. Only on the way open:
    // collapsing shrinks the column back and re-attaches on its own.
    if (!open) stopFollowing();
    setOpen(!open);
  };
  /** The row shell, for the pointer only. It carries no role: it holds controls. */
  return { open, toggle, rowProps: { onClick: toggle } };
}

/**
 * The disclosure as a real control.
 *
 * The caret is always drawn on an expandable row and its 20px target matches
 * the smallest control rung. The surrounding header keeps its generous pointer
 * target; this is the keyboard and precision-pointer route into the same
 * action. `stopPropagation` keeps it from toggling the row twice.
 */
function RowDisclosure({
  open,
  expandable,
  onToggle,
}: {
  open: boolean;
  expandable: boolean;
  onToggle(): void;
}) {
  if (!expandable) {
    return (
      <span aria-hidden className="flex size-5 shrink-0 items-center justify-center">
        <Caret open={false} hidden />
      </span>
    );
  }
  const label = open ? "Hide details" : "Show details";
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted/30 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Caret open={open} pinned />
    </button>
  );
}

/**
 * Whether a capped box is hiding content past its own bottom edge.
 *
 * Measured rather than assumed: painted unconditionally, the fade would dim the
 * last line of a three-line output and promise more that is not there. The
 * observer catches width changes, which re-wrap and can flip whether the same
 * content clips at all; `revision` catches content arriving as a tool streams.
 */
function useClipped<T extends HTMLElement>(revision: number) {
  const ref = React.useRef<T>(null);
  const [clipped, setClipped] = React.useState(false);

  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setClipped(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [revision]);

  return { ref, clipped };
}

/* -------------------------------------------------------------------- atoms */

const KIND_ICONS: Record<ActivityKind, Icon> = {
  "run-command": TerminalWindowIcon,
  "read-file": FileTextIcon,
  "edit-file": PencilSimpleIcon,
  "write-file": FilePlusIcon,
  search: MagnifyingGlassIcon,
  "list-directory": FolderIcon,
  "fetch-url": GlobeSimpleIcon,
  plan: ListChecksIcon,
  delegate: UsersThreeIcon,
  other: WrenchIcon,
};

/**
 * Every transcript line fills the same 14px glyph column — never reserves it
 * empty. Folded headers used to skip it while reasoning took one slot and tool
 * rows took two, so three kinds of line started their text at 0, 20 and 40px.
 * A bundle header left blank there read as a hole in the column, so it gets the
 * wrench: one universal mark for "this stands for tools", the same way each row
 * below it carries the mark for its own kind.
 */
function BundleGlyph() {
  return <WrenchIcon aria-hidden className={GLYPH_CLASS} />;
}

const GLYPH_CLASS = "size-3.5 shrink-0 text-muted-foreground";

/**
 * The one glyph a tool row gets.
 *
 * At rest it is the kind icon, which is there to be scanned rather than read —
 * the verb beside it already says `Ran`, `Read`, `Edited`. Anything that is not
 * a plain completion takes the slot instead, because a row that is waiting,
 * blocked or broken has exactly one thing to say. Dropping the permanent
 * checkmark column costs nothing: the meta on the right is the receipt, and a
 * settled row that says nothing else is a row that went fine.
 */
function RowGlyph({ kind, status }: { kind: ActivityKind; status: ActivityStatus }) {
  if (status !== "done") return <StatusGlyph status={status} />;
  const Icon = KIND_ICONS[kind];
  return <Icon aria-hidden className={GLYPH_CLASS} />;
}

/**
 * Outline is the baseline; fill is spent only on the rows that are the
 * exception. A transcript is a scannable list, and the scan works because the
 * routine rows are uniform — so the three states that stop a person (blocked,
 * failed, denied) are filled and everything else, the settled tick included, is
 * not. A muted filled CheckCircle covers half its box to say "this went fine",
 * which is the one thing a settled row should not say loudly.
 */
function StatusGlyph({ status }: { status: ActivityStatus }) {
  const className = "size-3.5 shrink-0";
  switch (status) {
    case "pending":
      return <CircleDashedIcon aria-hidden className={cn(className, "text-muted-foreground")} />;
    case "running":
      return <SpinnerGapIcon aria-hidden className={cn(className, "animate-spin text-primary")} />;
    // Approval never shares a glyph with running: the state that needs a human
    // must not look like the state that needs nothing.
    case "approval":
      return <HandPalmIcon aria-hidden className={cn(className, "text-primary")} weight="fill" />;
    case "failed":
      return (
        <XCircleIcon aria-hidden className={cn(className, "text-destructive")} weight="fill" />
      );
    case "denied":
      return (
        <ProhibitIcon aria-hidden className={cn(className, "text-destructive")} weight="fill" />
      );
    default:
      return <CheckCircleIcon aria-hidden className={cn(className, "text-muted-foreground")} />;
  }
}

const TONE_CLASS: Record<SummaryTone, string> = {
  neutral: "text-muted-foreground",
  muted: "text-muted-foreground/70",
  danger: "text-destructive",
  attention: "text-primary",
};

function Summary({ segments }: { segments: readonly SummarySegment[] }) {
  return (
    <span className="min-w-0 truncate">
      {segments.map((segment, index) => (
        <React.Fragment key={segment.text}>
          {index > 0 ? <span className="text-muted-foreground/50"> · </span> : null}
          <span className={segment.tone === "danger" ? TONE_CLASS.danger : undefined}>
            {segment.text}
          </span>
        </React.Fragment>
      ))}
    </span>
  );
}

/** Dim directory, bright basename — long paths stay scannable under truncation. */
function ObjectText({ value }: { value: string }) {
  const { directory, basename } = splitPath(value);
  if (!directory) return <>{value}</>;
  return (
    <>
      <span className="text-muted-foreground/70">{directory}</span>
      {basename}
    </>
  );
}

/* ----------------------------------------------------------------- tool row */

/**
 * Memoized on the part, which is the one thing that says the row changed.
 *
 * The transcript re-segments from scratch on every render — `segmentTurn` hands
 * back fresh arrays of fresh row wrappers — but the parts inside them are the
 * same immutable objects, so this is where re-rendering actually stops. Every
 * settled row above the live one skips entirely while a turn streams.
 */
export const ToolRow = React.memo(function ToolRow({
  part,
  onOpenFile,
  className,
}: {
  part: DynamicToolUIPart;
  onOpenFile?(path: string): void;
  className?: string;
}) {
  const row = describeActivity(part);
  // A bash command always earns its own disclosure: the header is one line by
  // design, while the body is the untruncated command beside whatever it
  // printed. Other rows only need a disclosure when their presenter has detail.
  const expandable = row.detail !== null || row.command !== null;
  const { open, toggle, rowProps } = useRowToggle(expandable);

  return (
    <div className={cn("group/row not-prose", className)}>
      <div {...rowProps} className={cn(ROW_CLASS, expandable && ROW_INTERACTIVE)}>
        <RowGlyph kind={row.kind} status={row.status} />
        <span className="shrink-0">{row.verb}</span>
        {row.object ? <RowObject row={row} onOpenFile={onOpenFile} /> : null}
        <RowDisclosure open={open} expandable={expandable} onToggle={toggle} />
        <RowActions row={row} />
        {row.meta ? (
          <span
            className={cn("shrink-0 font-mono tabular-nums", TONE_CLASS[row.metaTone])}
            // Numerals are tabular so live counters do not jitter.
          >
            {row.meta}
          </span>
        ) : null}
      </div>
      {expandable ? (
        <Disclosure open={open}>
          <ToolDetail command={row.command} detail={row.detail} />
        </Disclosure>
      ) : null}
    </div>
  );
});

/**
 * The second click target. The object opens the real artifact; the row around it
 * only expands the inline detail.
 */
function RowObject({ row, onOpenFile }: { row: ActivityRow; onOpenFile?(path: string): void }) {
  const object = row.object ?? "";
  const openPath = row.openPath;
  if (!openPath || !onOpenFile) {
    return (
      <code
        className="min-w-0 truncate font-mono text-ui text-foreground"
        title={row.kind === "run-command" ? object : undefined}
      >
        <ObjectText value={object} />
      </code>
    );
  }
  return (
    <button
      type="button"
      title={openPath}
      onClick={(event) => {
        event.stopPropagation();
        onOpenFile(openPath);
      }}
      className="min-w-0 truncate rounded-sm font-mono text-ui text-foreground underline decoration-transparent decoration-dotted underline-offset-[3px] transition-colors hover:decoration-primary hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <ObjectText value={object} />
    </button>
  );
}

/** How long the copy button holds its verdict before going back to offering. */
const COPY_FEEDBACK_MS = 1200;

type ClipboardWriter = Pick<Clipboard, "writeText">;

/**
 * The browser boundary for copying an activity object.
 *
 * Clipboard access can reject for ordinary runtime conditions (permission,
 * focus, or insecure context). Return the result the control must show rather
 * than leaving its caller to guess whether a rejected promise was success.
 */
export async function copyActivityObject(
  value: string,
  clipboard: ClipboardWriter | undefined = navigator.clipboard,
): Promise<"copied" | "failed"> {
  try {
    if (!clipboard) return "failed";
    await clipboard.writeText(value);
    return "copied";
  } catch {
    return "failed";
  }
}

/** Revealed on hover or keyboard focus, never occupying resting space. */
function RowActions({ row }: { row: ActivityRow }) {
  // The clipboard write can be refused — denied permission, an insecure
  // context, a document that does not have focus — and it refuses by rejecting,
  // so a bare `void` leaves a button that did nothing looking exactly like a
  // button that worked. This is not a mutation worth a toast; it is a control
  // that owes an answer, so it gives one on itself and then forgets it. The
  // row keeps focus after the click, which is what holds the answer on screen
  // once the pointer has moved on.
  const [copyState, setCopyState] = React.useState<"idle" | "copied" | "failed">("idle");
  React.useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  if (!row.object) return <span className="ml-auto" />;
  const CopyStateIcon =
    copyState === "copied" ? CheckCircleIcon : copyState === "failed" ? XCircleIcon : CopyIcon;
  return (
    <span className="ml-auto flex shrink-0 items-center opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={
          copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"
        }
        onClick={(event) => {
          event.stopPropagation();
          void copyActivityObject(row.object ?? "").then(setCopyState);
        }}
      >
        <CopyStateIcon className={cn("size-3", copyState === "failed" && "text-destructive")} />
      </Button>
    </span>
  );
}

/* -------------------------------------------------------------------- detail */

const DETAIL_FRAME =
  "max-h-72 overflow-auto overscroll-contain rounded-md border border-border/50 bg-muted/30 p-2 font-mono text-ui leading-5";

/**
 * The detail is a window, not a dump — and it is flush, not indented.
 *
 * An expanded row used to paste its whole output into the feed, up to the 400
 * line parse budget, which shoves everything below it off screen and destroys
 * the reader's place. It is capped and scrolls instead; the full artifact is one
 * click away on the mono object, which is the row's other click target.
 *
 * The frame is a card at the row's own left edge rather than a rule hanging off
 * a margin. A left border plus padding reads as a second column, and a
 * transcript that indents its payloads ends up with as many left edges as it has
 * kinds of disclosure.
 *
 * It also keeps the row rhythm rather than inventing a gap: the transcript has
 * two spacing values, 12px between segments and 2px between rows, and a payload
 * belongs to the row that opened it.
 *
 * The clip fade ramps to the frame's own fill, which is a mix and not a rung:
 * the frame is `--muted` at 25% over the transcript's `--background`, so it sits
 * *between* the two named surfaces. A scrim off either one lands a band across
 * the bottom of every clipped payload — measured at 2.5/255 dark and 5/255 light
 * from `--card`, and the same distance the other way from `--background`. Mixing
 * it the way the frame mixes it is the only value that leaves no edge, which is
 * why {@link DETAIL_FRAME}'s fill and this ramp must be changed together.
 */
function DetailFrame({
  revision,
  className,
  children,
}: React.PropsWithChildren<{ revision: number; className?: string }>) {
  const { ref, clipped } = useClipped<HTMLDivElement>(revision);
  return (
    <div className="relative my-1">
      <div ref={ref} className={cn(DETAIL_FRAME, className)}>
        {children}
      </div>
      {clipped ? (
        <div className="pointer-events-none absolute inset-x-px bottom-px h-8 rounded-b-md bg-[linear-gradient(to_top,color-mix(in_oklab,var(--muted)_25%,var(--background))_0,transparent_100%)]" />
      ) : null}
    </div>
  );
}

function ToolDetail({
  command,
  detail,
}: {
  command: string | null;
  detail: ActivityDetail | null;
}) {
  return (
    <>
      {command !== null ? (
        <DetailFrame revision={command.length} className="whitespace-pre-wrap text-foreground">
          {command}
        </DetailFrame>
      ) : null}
      {detail !== null ? <ActivityOutputDetail detail={detail} /> : null}
    </>
  );
}

function ActivityOutputDetail({ detail }: { detail: ActivityDetail }) {
  switch (detail.view) {
    case "diff":
      return (
        <DetailFrame revision={detail.lines.length}>
          {detail.lines.map((line) => (
            <div
              key={line.id}
              className={cn(
                "whitespace-pre",
                line.kind === "add" && "text-primary-text",
                line.kind === "remove" && "text-destructive",
                line.kind === "hunk" && "text-muted-foreground/50",
                line.kind === "context" && "text-muted-foreground",
              )}
            >
              {line.text || " "}
            </div>
          ))}
        </DetailFrame>
      );
    case "numbered":
      return (
        <DetailFrame revision={detail.lines.length}>
          {detail.lines.map((line) => (
            <div key={line.number} className="flex gap-4 whitespace-pre">
              <span className="w-8 shrink-0 text-right text-muted-foreground/50 tabular-nums">
                {line.number}
              </span>
              <span className="text-muted-foreground">{line.text || " "}</span>
            </div>
          ))}
        </DetailFrame>
      );
    case "matches":
      return (
        <DetailFrame revision={detail.groups.length} className="space-y-1">
          {detail.groups.map((group) => (
            <div key={group.file}>
              <div className="truncate text-foreground">
                <ObjectText value={group.file} />
              </div>
              {group.lines.map((line) => (
                <div key={line} className="truncate pl-4 text-muted-foreground">
                  {line}
                </div>
              ))}
              {group.hidden > 0 ? (
                <div className="pl-4 text-muted-foreground/50">+{group.hidden}</div>
              ) : null}
            </div>
          ))}
        </DetailFrame>
      );
    case "signature":
      return (
        <DetailFrame
          revision={detail.text.length}
          className="whitespace-pre-wrap text-muted-foreground/70"
        >
          {detail.text}
        </DetailFrame>
      );
    default:
      return (
        <DetailFrame
          revision={detail.text.length}
          className="whitespace-pre-wrap text-muted-foreground"
        >
          {detail.text}
        </DetailFrame>
      );
  }
}

/* ------------------------------------------------------------------ bundle */

/**
 * How tall an open bundle may get before it scrolls inside itself.
 *
 * Expanding must not cost the reader their place. Without a cap, opening a run
 * of thirty rows — or one row holding a 300-line diff — pushes everything below
 * it off screen, and the feed you were reading becomes a feed you have to find
 * again. Capped, the bundle stays the size of a paragraph no matter what is
 * inside it, and the overflow is the bundle's problem rather than the page's.
 */
const BUNDLE_CAP = "max-h-96";

/**
 * Everything the agent did between two things it said, behind one line.
 *
 * At rest this is a single row — `Read 4 files, ran 3 commands, edited
 * activity.ts` — and that row carries the whole load while the turn is live,
 * ticking its counts in place rather than expanding. Opening it reveals the rows
 * *at the same left edge*: no indent, no rule, no second column. The list simply
 * got longer, and the caret is what says why.
 *
 * Open state is derived — `userOpen ?? needsAttention` — so restoring a session
 * fires no transitions at boot, and a bundle holding a failure is open before
 * anyone asks. A pending approval never reaches here; it left the bundle
 * upstream, because the one thing that blocks the reader must not be behind a
 * disclosure at all.
 */
export const ActivityBundle = React.memo(
  function ActivityBundle({
    rows,
    onOpenFile,
  }: {
    rows: readonly BundleRow[];
    onOpenFile?(path: string): void;
  }) {
    const [userOpen, setUserOpen] = React.useState<boolean | null>(null);
    const summary = React.useMemo(() => bundleSummary(rows), [rows]);
    const open = userOpen ?? bundleNeedsAttention(rows);
    const { ref, clipped } = useClipped<HTMLDivElement>(rows.length);
    // Wired to the click and not to `open`, which is derived: a bundle that
    // opens itself because a row inside it failed is not a reader reaching for
    // anything, and must not detach them from a live stream.
    const stopFollowing = useStopFollowing();

    const list = (
      <div className="space-y-1">
        {rows.map((row) => (
          <BundleRowView key={row.key} row={row} onOpenFile={onOpenFile} />
        ))}
      </div>
    );

    // Reasoning alone has nothing to count, so the row *is* the summary. A
    // header above it would be the same sentence twice, on two different lines.
    if (summary.length === 0) return <div className="not-prose">{list}</div>;

    const toggle = () => {
      if (hasTextSelection()) return;
      if (!open) stopFollowing();
      setUserOpen(!open);
    };

    return (
      <div className="not-prose">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className={cn(ROW_CLASS, ROW_INTERACTIVE, ROW_FOCUSABLE)}
        >
          <BundleGlyph />
          <Summary segments={summary} />
          <Caret open={open} pinned />
        </button>
        <Disclosure open={open}>
          <div className="relative">
            <div ref={ref} className={cn(BUNDLE_CAP, "overflow-auto overscroll-contain")}>
              {list}
            </div>
            {clipped ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background to-transparent" />
            ) : null}
          </div>
        </Disclosure>
      </div>
    );
  },
  (previous, next) =>
    previous.onOpenFile === next.onOpenFile && sameBundleRows(previous.rows, next.rows),
);

/**
 * Whether two segmentations describe the same bundle.
 *
 * A shallow prop compare cannot answer this: the caller re-segments the turn on
 * every render, so `rows` is a new array of new wrappers each time and the
 * default memo would never hit. What is stable is what the wrappers point at —
 * the parts — and `streaming`, which is the projection's own verdict rather than
 * anything the part carries. Compare those two and the whole bundle, summary
 * included, stops re-rendering while some other turn streams.
 */
function sameBundleRows(previous: readonly BundleRow[], next: readonly BundleRow[]): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  return previous.every((row, index) => {
    const other = next[index];
    if (other === undefined || other.kind !== row.kind || other.key !== row.key) return false;
    if (row.kind === "reasoning") {
      return (
        other.kind === "reasoning" && other.part === row.part && other.streaming === row.streaming
      );
    }
    return other.part === row.part;
  });
}

const BundleRowView = React.memo(function BundleRowView({
  row,
  onOpenFile,
}: {
  row: BundleRow;
  onOpenFile?(path: string): void;
}) {
  if (row.kind === "reasoning") {
    return <ReasoningRow part={row.part} streaming={row.streaming} />;
  }
  return <ToolRow part={row.part} onOpenFile={onOpenFile} />;
});

/**
 * Reasoning as an ordinary row.
 *
 * Same shell, same gutter, same caret as a tool call — the only difference is
 * the glyph. Cursor and t3code both render thinking through the identical row
 * component, and the reason is structural rather than aesthetic: a bespoke
 * reasoning block is a second kind of line in the same column, and two kinds of
 * line cannot share one left edge for long.
 *
 * The glyph is a Gauge, and it is the same one the composer's effort chip
 * wears. Reasoning has one vocabulary in this app now: the dial you set before
 * the turn and the row that reports what it bought are the same object seen
 * from two ends. (It was a Brain, which said "thinking" and nothing else — no
 * magnitude, and a lumpy drawing at 14px.)
 */
const ReasoningRow = React.memo(function ReasoningRow({
  part,
  streaming,
}: {
  part: ReasoningUIPart;
  streaming: boolean;
}) {
  const elapsed = useElapsed(streaming);
  const status = reasoningStatus(part.text, { streaming, durationMs: elapsed });
  const body = reasoningBody(part.text);
  const expandable = body !== null;
  const { open, toggle, rowProps } = useRowToggle(expandable);

  return (
    <div className="group/row not-prose">
      <div {...rowProps} className={cn(ROW_CLASS, expandable && ROW_INTERACTIVE)}>
        {streaming ? (
          <SpinnerGapIcon aria-hidden className="size-3.5 shrink-0 animate-spin text-primary" />
        ) : (
          <GaugeIcon aria-hidden className={GLYPH_CLASS} />
        )}
        <span className="min-w-0 truncate">{status.verb}</span>
        <RowDisclosure open={open} expandable={expandable} onToggle={toggle} />
        <span className="ml-auto" />
        {status.meta ? (
          <span className="shrink-0 font-mono tabular-nums text-muted-foreground/70">
            {status.meta}
          </span>
        ) : null}
      </div>
      {body !== null ? (
        <Disclosure open={open}>
          <ReasoningBody className="my-1 rounded-md border border-border/50 bg-muted/30 p-2 text-ui leading-5">
            {body}
          </ReasoningBody>
        </Disclosure>
      ) : null}
    </div>
  );
});

/* ---------------------------------------------------------------- attention */

/**
 * The scrollback receipt a harness's own denial verdict leaves on a row.
 *
 * Distinct from the receipt an *answer* leaves, which is written from the
 * durable resolution at the point in the transcript where it was given. This
 * one is the harness reporting that the call itself was refused, which a
 * harness may say without any interaction of ours having been open.
 */
export function AttentionReceipt({ part }: { part: DynamicToolUIPart }) {
  const row = describeActivity(part);
  const approved = row.status !== "denied";
  return (
    <div className="not-prose flex min-w-0 items-center gap-1 text-ui text-muted-foreground">
      {/* Outline, even for the denial. The row this receipt hangs under already
          carries the filled destructive Prohibit that says the call was refused;
          the receipt is the settled record of what you did about it, and a
          second filled mark on the same fact is the same bit twice. */}
      {approved ? (
        <CheckCircleIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
      ) : (
        <ProhibitIcon aria-hidden className={GLYPH_CLASS} />
      )}
      <span className="shrink-0">You {approved ? "allowed" : "denied"}</span>
      {row.object ? (
        <code className="min-w-0 truncate font-mono text-ui text-foreground">{row.object}</code>
      ) : null}
      <span className="shrink-0">this time</span>
    </div>
  );
}
