/**
 * Chat activity presentation.
 *
 * One left edge. Every line in the transcript — the bundle summary, the rows it
 * counts, reasoning, an expanded payload — starts at the same x, and depth is
 * never spelled as indentation. Containment is said by the caret and by
 * adjacency; a row's disclosure opens *in line*, so opening something makes the
 * list longer rather than making it a tree. The only bordered shape is the
 * approval card, which is an object you act on rather than process you audit.
 *
 * Every row is the same primitive — `‹glyph› ‹Verb› ‹object›` left, `‹meta›`
 * right — and all variance lives in the per-kind presenters in `activity.ts`.
 * Two click targets: the row expands its detail, the mono object opens the real
 * artifact.
 */
import {
  ArrowBendUpLeftIcon,
  BrainIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  CircleIcon,
  CopyIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderIcon,
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

import { ReasoningBody, useElapsed } from "@ai-elements/reasoning";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";

import {
  bundleNeedsAttention,
  bundleSummary,
  describeActivity,
  detailText,
  reasoningBody,
  reasoningStatus,
  splitPath,
  type ActivityDetail,
  type ActivityRow,
  type ActivityStatus,
  type BundleRow,
  type SessionTodo,
  type SummarySegment,
  type SummaryTone,
} from "./activity";

/* ------------------------------------------------------------------- motion */

/**
 * One collapse constant for the whole transcript. Height runs the full 400ms on
 * the app's swift curve; opacity is shorter so it leads on open and clears on
 * close, which is what keeps text from being clipped mid-glyph.
 */
const COLLAPSE = "duration-[400ms] ease-swift motion-reduce:transition-none";
const COLLAPSE_FADE = "duration-[240ms] ease-swift motion-reduce:transition-none";

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
    // Two elements because the two transitions have different jobs: the wrapper
    // fades on hover at hover speed, the glyph rotates in lockstep with the
    // body it opens. Collapsed onto one node, `transition-opacity` would win the
    // merge and the rotation would snap.
    <span
      className={cn(
        // Zed's `visible_on_hover`. A caret on every row is a column of
        // permanent weight for something you only need when you reach for it.
        // An open row keeps its caret — the way back out is never hidden.
        "shrink-0 opacity-0 transition-opacity duration-150 ease-swift group-focus-within/row:opacity-100 group-hover/row:opacity-100 motion-reduce:transition-none",
        (open || pinned) && "opacity-100",
        hidden && "invisible",
        className,
      )}
    >
      <CaretRightIcon
        aria-hidden
        className={cn(
          "size-3 text-muted-foreground transition-transform",
          COLLAPSE,
          open && "rotate-90",
        )}
      />
    </span>
  );
}

/** Grid-rows collapse: no keyframes, so the duration and curve stay on-token. */
function Disclosure({ open, children }: React.PropsWithChildren<{ open: boolean }>) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows]",
        COLLAPSE,
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
    >
      <div
        className={cn(
          "min-h-0 overflow-hidden transition-opacity",
          COLLAPSE_FADE,
          open ? "opacity-100" : "opacity-0",
        )}
        aria-hidden={!open}
      >
        {children}
      </div>
    </div>
  );
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
  "group/row flex w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-left text-xs text-muted-foreground outline-none transition-colors";
const ROW_INTERACTIVE =
  "cursor-pointer hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring";

/** Click, Enter and Space open a row; dragging a selection across it does not. */
function useRowToggle(expandable: boolean) {
  const [open, setOpen] = React.useState(false);
  const toggle = () => {
    if (hasTextSelection() || !expandable) return;
    setOpen((value) => !value);
  };
  return {
    open,
    props: {
      role: expandable ? ("button" as const) : undefined,
      tabIndex: expandable ? 0 : undefined,
      "aria-expanded": expandable ? open : undefined,
      onClick: toggle,
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggle();
      },
    },
  };
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
  return <WrenchIcon aria-hidden className={GLYPH_CLASS} weight="fill" />;
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
  return <Icon aria-hidden className={GLYPH_CLASS} weight="fill" />;
}

/**
 * Filled weights throughout — the outline set reads thin and unresolved beside
 * the app's type. The two exceptions are the states whose meaning *is* the
 * outline: a filled spinner-gap is a disc with no gap to rotate, and a filled
 * dashed circle is a disc with no dashes.
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
      return (
        <CheckCircleIcon
          aria-hidden
          className={cn(className, "text-muted-foreground")}
          weight="fill"
        />
      );
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

export function ToolRow({
  part,
  onOpenFile,
  className,
}: {
  part: DynamicToolUIPart;
  onOpenFile?(path: string): void;
  className?: string;
}) {
  const row = describeActivity(part);
  const expandable = row.detail !== null;
  const { open, props } = useRowToggle(expandable);

  return (
    <div className={cn("group/row not-prose", className)}>
      <div {...props} className={cn(ROW_CLASS, expandable && ROW_INTERACTIVE)}>
        <RowGlyph kind={row.kind} status={row.status} />
        <span className="shrink-0">{row.verb}</span>
        {row.object ? <RowObject row={row} onOpenFile={onOpenFile} /> : null}
        <Caret open={open} hidden={!expandable} />
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
      {row.detail ? (
        <Disclosure open={open}>
          <ToolDetail detail={row.detail} />
        </Disclosure>
      ) : null}
    </div>
  );
}

/**
 * The second click target. The object opens the real artifact; the row around it
 * only expands the inline detail.
 */
function RowObject({ row, onOpenFile }: { row: ActivityRow; onOpenFile?(path: string): void }) {
  const object = row.object ?? "";
  const openPath = row.openPath;
  if (!openPath || !onOpenFile) {
    return (
      <code className="min-w-0 truncate font-mono text-xs text-foreground">
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
      className="min-w-0 truncate rounded font-mono text-xs text-foreground underline decoration-transparent decoration-dotted underline-offset-[3px] transition-colors hover:decoration-primary hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <ObjectText value={object} />
    </button>
  );
}

/** Revealed on hover or keyboard focus, never occupying resting space. */
function RowActions({ row }: { row: ActivityRow }) {
  if (!row.object) return <span className="ml-auto" />;
  return (
    <span className="ml-auto flex shrink-0 items-center opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Copy"
        onClick={(event) => {
          event.stopPropagation();
          void navigator.clipboard.writeText(row.object ?? "");
        }}
      >
        <CopyIcon className="size-3" />
      </Button>
    </span>
  );
}

/* -------------------------------------------------------------------- detail */

const DETAIL_FRAME =
  "max-h-72 overflow-auto overscroll-contain rounded-md border border-border/60 bg-muted/25 p-2 font-mono text-xs leading-5";

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
        <div className="pointer-events-none absolute inset-x-px bottom-px h-8 rounded-b-md bg-gradient-to-t from-card to-transparent" />
      ) : null}
    </div>
  );
}

function ToolDetail({ detail }: { detail: ActivityDetail }) {
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
                line.kind === "hunk" && "text-muted-foreground/60",
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
            <div key={line.number} className="flex gap-3 whitespace-pre">
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
        <DetailFrame revision={detail.groups.length} className="space-y-1.5">
          {detail.groups.map((group) => (
            <div key={group.file}>
              <div className="truncate text-foreground">
                <ObjectText value={group.file} />
              </div>
              {group.lines.map((line) => (
                <div key={line} className="truncate pl-3 text-muted-foreground">
                  {line}
                </div>
              ))}
              {group.hidden > 0 ? (
                <div className="pl-3 text-muted-foreground/50">+{group.hidden}</div>
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
export function ActivityBundle({
  rows,
  onOpenFile,
}: {
  rows: readonly BundleRow[];
  onOpenFile?(path: string): void;
}) {
  const [userOpen, setUserOpen] = React.useState<boolean | null>(null);
  const summary = bundleSummary(rows);
  const open = userOpen ?? bundleNeedsAttention(rows);
  const { ref, clipped } = useClipped<HTMLDivElement>(rows.length);

  const list = (
    <div className="space-y-0.5">
      {rows.map((row) => (
        <BundleRowView key={row.key} row={row} onOpenFile={onOpenFile} />
      ))}
    </div>
  );

  // Reasoning alone has nothing to count, so the row *is* the summary. A header
  // above it would be the same sentence twice, on two different lines.
  if (summary.length === 0) return <div className="not-prose">{list}</div>;

  const toggle = () => {
    if (hasTextSelection()) return;
    setUserOpen(!open);
  };

  return (
    <div className="not-prose">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={cn(ROW_CLASS, ROW_INTERACTIVE)}
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
}

function BundleRowView({ row, onOpenFile }: { row: BundleRow; onOpenFile?(path: string): void }) {
  if (row.kind === "reasoning") {
    return <ReasoningRow part={row.part} streaming={row.streaming} />;
  }
  return <ToolRow part={row.part} onOpenFile={onOpenFile} />;
}

/**
 * Reasoning as an ordinary row.
 *
 * Same shell, same gutter, same caret as a tool call — the only difference is
 * the glyph. Cursor and t3code both render thinking through the identical row
 * component, and the reason is structural rather than aesthetic: a bespoke
 * reasoning block is a second kind of line in the same column, and two kinds of
 * line cannot share one left edge for long.
 */
function ReasoningRow({ part, streaming }: { part: ReasoningUIPart; streaming: boolean }) {
  const elapsed = useElapsed(streaming);
  const status = reasoningStatus(part.text, { streaming, durationMs: elapsed });
  const body = reasoningBody(part.text);
  const expandable = body !== null;
  const { open, props } = useRowToggle(expandable);

  return (
    <div className="group/row not-prose">
      <div {...props} className={cn(ROW_CLASS, expandable && ROW_INTERACTIVE)}>
        {streaming ? (
          <SpinnerGapIcon aria-hidden className="size-3.5 shrink-0 animate-spin text-primary" />
        ) : (
          <BrainIcon aria-hidden className={GLYPH_CLASS} weight="fill" />
        )}
        <span className="min-w-0 truncate">{status.verb}</span>
        <Caret open={open} hidden={!expandable} />
        <span className="ml-auto" />
        {status.meta ? (
          <span className="shrink-0 font-mono tabular-nums text-muted-foreground/70">
            {status.meta}
          </span>
        ) : null}
      </div>
      {body !== null ? (
        <Disclosure open={open}>
          <ReasoningBody className="my-1 rounded-md border border-border/60 bg-muted/25 p-2 text-xs leading-5">
            {body}
          </ReasoningBody>
        </Disclosure>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- attention */

export type AttentionDecision = "allow" | "deny" | "steer";

/**
 * Errors, denials and approval requests are always full-width and never fold —
 * a pending question gets a card with an action, a resolved one leaves a
 * one-line receipt so the transcript stays an honest record of what was
 * authorized.
 */
export function AttentionBlock({
  part,
  onOpenFile,
  onDecide,
}: {
  part: DynamicToolUIPart;
  onOpenFile?(path: string): void;
  onDecide?(decision: AttentionDecision): void;
}) {
  if (part.state === "output-denied") return <AttentionReceipt part={part} />;
  return <AttentionCard part={part} onOpenFile={onOpenFile} onDecide={onDecide} />;
}

export function AttentionCard({
  part,
  onOpenFile,
  onDecide,
}: {
  part: DynamicToolUIPart;
  onOpenFile?(path: string): void;
  onDecide?(decision: AttentionDecision): void;
}) {
  const row = describeActivity(part);
  const pending = row.status === "approval";
  const body = row.errorText ?? detailText(row.detail);

  return (
    <div
      className={cn(
        "not-prose w-full rounded-lg border bg-card p-3 shadow-[var(--shadow-raised)]",
        pending ? "border-primary/40" : "border-destructive/40",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <RowGlyph kind={row.kind} status={row.status} />
        <span className="shrink-0 text-muted-foreground">{row.verb}</span>
        {row.object ? <RowObject row={row} onOpenFile={onOpenFile} /> : null}
      </div>
      {body ? (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 text-muted-foreground">
          {body}
        </pre>
      ) : null}
      {pending && onDecide ? (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => onDecide("steer")}>
            <ArrowBendUpLeftIcon className="size-3.5" />
            No, and tell it what to do differently
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onDecide("deny")}>
            Deny
          </Button>
          <Button size="sm" onClick={() => onDecide("allow")}>
            Allow
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The scrollback receipt an approval leaves behind once it resolves. */
export function AttentionReceipt({ part }: { part: DynamicToolUIPart }) {
  const row = describeActivity(part);
  const approved = row.status !== "denied";
  return (
    <div className="not-prose flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {approved ? (
        <CheckCircleIcon aria-hidden className="size-3.5 shrink-0 text-primary" weight="fill" />
      ) : (
        <ProhibitIcon aria-hidden className={GLYPH_CLASS} weight="fill" />
      )}
      <span className="shrink-0">You {approved ? "allowed" : "denied"}</span>
      {row.object ? (
        <code className="min-w-0 truncate font-mono text-xs text-foreground">{row.object}</code>
      ) : null}
      <span className="shrink-0">this time</span>
    </div>
  );
}

/* -------------------------------------------------------------------- todos */

export function SessionTodoDock({ todos }: { todos: readonly SessionTodo[] }) {
  const [open, setOpen] = React.useState(true);
  const done = todos.filter(
    (todo) => todo.status === "completed" || todo.status === "cancelled",
  ).length;
  const active =
    todos.find((todo) => todo.status === "in_progress") ??
    todos.find((todo) => todo.status === "pending") ??
    todos[todos.length - 1];

  return (
    <div className="pointer-events-auto mb-2 rounded-xl border border-border bg-card shadow-[var(--shadow-raised)]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="group/row flex w-full items-center gap-2 px-3 py-2 text-left text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="font-medium tabular-nums text-foreground">
          {done}/{todos.length}
        </span>
        {active ? (
          <span className="min-w-0 truncate text-muted-foreground">{active.content}</span>
        ) : null}
        <Caret open={open} />
      </button>
      <Disclosure open={open}>
        <ul className="space-y-1 border-t border-border/70 px-3 py-2">
          {todos.map((todo) => (
            <TodoRow key={todo.id} todo={todo} />
          ))}
        </ul>
      </Disclosure>
    </div>
  );
}

export function SessionTodoList({ todos }: { todos: readonly SessionTodo[] }) {
  return (
    <ul className="space-y-1.5">
      {todos.map((todo) => (
        <TodoRow key={todo.id} todo={todo} />
      ))}
    </ul>
  );
}

function TodoRow({ todo }: { todo: SessionTodo }) {
  return (
    <li className="flex items-start gap-2 text-xs">
      <TodoGlyph status={todo.status} />
      <span
        className={cn(
          "min-w-0 flex-1 leading-5",
          (todo.status === "completed" || todo.status === "cancelled") &&
            "text-muted-foreground line-through",
        )}
      >
        {todo.content}
      </span>
    </li>
  );
}

function TodoGlyph({ status }: { status: SessionTodo["status"] }) {
  if (status === "completed") {
    return <CheckCircleIcon className="mt-0.5 size-3.5 shrink-0 text-primary" weight="fill" />;
  }
  if (status === "cancelled") {
    return <XCircleIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" weight="fill" />;
  }
  if (status === "in_progress") {
    return (
      <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center">
        <span className="size-2 animate-pulse rounded-full bg-primary" />
      </span>
    );
  }
  return <CircleIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />;
}
