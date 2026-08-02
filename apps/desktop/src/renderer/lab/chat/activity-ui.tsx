/**
 * Chat activity presentation.
 *
 * Three shapes, one rule: a caret means process you can audit, a border means an
 * object you can act on, bare text means the answer. Rows are borderless and
 * collapse; the attention card is bordered and never collapses.
 *
 * Every row is the same primitive — `‹status› ‹icon› ‹Verb› ‹object›` left,
 * `‹meta›` right — and all variance lives in the per-kind presenters in
 * `activity.ts`. Two click targets: the row expands its detail, the mono object
 * opens the real artifact.
 */
import {
  ArrowBendUpLeftIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CheckIcon,
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
import type { DynamicToolUIPart } from "ai";
import * as React from "react";

import { ReasoningBody, ReasoningLine, useElapsed } from "@ai-elements/reasoning";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";

import {
  activitySummary,
  activityToolItems,
  describeActivity,
  detailText,
  isActivityStreaming,
  isRowActive,
  reasoningBody,
  reasoningStatus,
  rollingTail,
  runSummary,
  splitPath,
  type ActivityDetail,
  type ActivityItem,
  type ActivityRow,
  type ActivityStatus,
  type SessionTodo,
  type SummarySegment,
  type SummaryTone,
  type ToolItem,
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
 * The one caret, and it always rides the right edge.
 *
 * The left column of every row means one thing — what happened: a check, a
 * cross, a spinner, a thought's dot. A caret there would put two meanings in
 * one column, which is exactly how this read as inconsistent when container
 * rows disclosed on the left and leaf rows on the right. Left is outcome, right
 * is "there is more".
 *
 * Rotated, never swapped — a swapped glyph cannot animate, and reads as a
 * flicker. `hidden` keeps the slot so the meta column stays aligned across rows
 * that can and cannot expand.
 */
function Caret({
  open,
  hidden,
  className,
}: {
  open: boolean;
  hidden?: boolean;
  className?: string;
}) {
  return (
    <CaretRightIcon
      aria-hidden
      className={cn(
        "size-3 shrink-0 text-muted-foreground transition-transform",
        COLLAPSE,
        open && "rotate-90",
        hidden && "invisible",
        className,
      )}
    />
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

/** Every folded header is the same row: the counted summary, then the caret. */
const TRIGGER_CLASS =
  "flex w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-left text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring";

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
      return <ProhibitIcon aria-hidden className={cn(className, "text-destructive")} />;
    default:
      return <CheckIcon aria-hidden className={cn(className, "text-muted-foreground")} />;
  }
}

const TONE_CLASS: Record<SummaryTone, string> = {
  neutral: "text-muted-foreground",
  muted: "text-muted-foreground/70",
  danger: "text-destructive",
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
  const [open, setOpen] = React.useState(false);
  const expandable = row.detail !== null;
  const Icon = KIND_ICONS[row.kind];

  const toggle = () => {
    if (hasTextSelection() || !expandable) return;
    setOpen((value) => !value);
  };

  return (
    <div className={cn("group/row not-prose", className)}>
      <div
        role={expandable ? "button" : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          toggle();
        }}
        className={cn(
          "flex min-w-0 items-center gap-1.5 rounded-md py-0.5 text-xs text-muted-foreground outline-none",
          expandable &&
            "cursor-pointer hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <StatusGlyph status={row.status} />
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="shrink-0">{row.verb}</span>
        {row.object ? <RowObject row={row} onOpenFile={onOpenFile} /> : null}
        <RowActions row={row} />
        {row.meta ? (
          <span
            className={cn("shrink-0 font-mono tabular-nums", TONE_CLASS[row.metaTone])}
            // Numerals are tabular so live counters do not jitter.
          >
            {row.meta}
          </span>
        ) : null}
        <Caret open={open} hidden={!expandable} />
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
  "mt-1 mb-1 ml-[0.4375rem] overflow-x-auto border-l border-border/70 pl-3 font-mono text-xs leading-5";

function ToolDetail({ detail }: { detail: ActivityDetail }) {
  switch (detail.view) {
    case "diff":
      return (
        <div className={DETAIL_FRAME}>
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
        </div>
      );
    case "numbered":
      return (
        <div className={DETAIL_FRAME}>
          {detail.lines.map((line) => (
            <div key={line.number} className="flex gap-3 whitespace-pre">
              <span className="w-8 shrink-0 text-right text-muted-foreground/50 tabular-nums">
                {line.number}
              </span>
              <span className="text-muted-foreground">{line.text || " "}</span>
            </div>
          ))}
        </div>
      );
    case "matches":
      return (
        <div className={cn(DETAIL_FRAME, "space-y-1.5")}>
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
        </div>
      );
    case "signature":
      return (
        <pre className={cn(DETAIL_FRAME, "whitespace-pre-wrap text-muted-foreground/70")}>
          {detail.text}
        </pre>
      );
    default:
      return (
        <pre className={cn(DETAIL_FRAME, "whitespace-pre-wrap text-muted-foreground")}>
          {detail.text}
        </pre>
      );
  }
}

/* --------------------------------------------------------------- tool runs */

/**
 * A run of first-class rows under a rolling tail: the active line is pinned at
 * the bottom, at most three completed rows sit above it, and everything older
 * is absorbed into a counted header that ticks. Turn height therefore stays
 * constant as tool calls accumulate.
 */
export function ToolRun({
  items,
  onOpenFile,
}: {
  items: readonly ToolItem[];
  onOpenFile?(path: string): void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const tail = rollingTail(items, (item) => isRowActive(item.part));
  const folded = tail.hidden > 0 && !expanded;
  const rows = folded ? tail.visible : items;

  return (
    <div className="not-prose">
      {tail.hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className={TRIGGER_CLASS}
        >
          <Summary segments={runSummary(items)} />
          <Caret open={expanded} className="ml-auto" />
        </button>
      ) : null}
      <div className="space-y-0.5">
        {rows.map((item) => (
          <ToolRow key={item.key} part={item.part} onOpenFile={onOpenFile} />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ activity group */

/**
 * Reasoning plus read-only exploration, folded into one row.
 *
 * Open state is derived — `userOpen ?? streaming` — rather than raced against a
 * timer, so the disclosure is interruptible by construction and never fights a
 * click that lands mid-collapse.
 */
export function ActivityGroup({
  items,
  working,
  onOpenFile,
}: {
  items: readonly ActivityItem[];
  working: boolean;
  onOpenFile?(path: string): void;
}) {
  const [userOpen, setUserOpen] = React.useState<boolean | null>(null);
  const tools = activityToolItems(items);
  const reasoning = items.find((item) => item.kind === "reasoning");
  const streaming =
    isActivityStreaming(items) ||
    (working && reasoning !== undefined && tools.length === 0 && reasoning.part.state !== "done");
  const open = userOpen ?? streaming;
  const summary = activitySummary(items, { streaming });
  const tail = rollingTail(tools, (item) => isRowActive(item.part));
  // Opened by hand means audit everything; opened by streaming means the
  // rolling tail, so a live turn's height never grows with the tool count.
  const rows = userOpen === true ? tools : open ? tail.visible : [];
  const body = reasoning ? reasoningBody(reasoning.part.text) : null;
  const toggle = () => {
    if (hasTextSelection()) return;
    setUserOpen(!open);
  };

  // One disclosure per group means one caret. It rides the tool header when
  // there are tools, and the reasoning line when reasoning is all there is.
  const reasoningLine = reasoning ? (
    <ReasoningStatus part={reasoning.part} streaming={streaming && tools.length === 0} />
  ) : null;

  return (
    <div className="not-prose">
      {summary.length > 0 ? (
        <button type="button" onClick={toggle} className={TRIGGER_CLASS}>
          <Summary segments={summary} />
          <Caret open={open} className="ml-auto" />
        </button>
      ) : null}
      {reasoningLine && summary.length === 0 && body !== null ? (
        <button type="button" onClick={toggle} className={TRIGGER_CLASS}>
          {reasoningLine}
          <Caret open={open} />
        </button>
      ) : (
        reasoningLine
      )}
      <div className="space-y-0.5">
        {rows.map((item) => (
          <ToolRow key={item.key} part={item.part} onOpenFile={onOpenFile} />
        ))}
      </div>
      {body !== null ? (
        <Disclosure open={userOpen === true}>
          <ReasoningBody className="ml-[0.4375rem] border-l border-border/70 py-1 pl-3">
            {body}
          </ReasoningBody>
        </Disclosure>
      ) : null}
    </div>
  );
}

function ReasoningStatus({
  part,
  streaming,
}: {
  part: Extract<ActivityItem, { kind: "reasoning" }>["part"];
  streaming: boolean;
}) {
  const elapsed = useElapsed(streaming);
  const status = reasoningStatus(part.text, { streaming, durationMs: elapsed });
  return <ReasoningLine verb={status.verb} meta={status.meta} streaming={streaming} />;
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
  const Icon = KIND_ICONS[row.kind];
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
        <StatusGlyph status={row.status} />
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
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
        <ProhibitIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
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
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="font-medium tabular-nums text-foreground">
          {done}/{todos.length}
        </span>
        {active ? (
          <span className="min-w-0 truncate text-muted-foreground">{active.content}</span>
        ) : null}
        <Caret open={open} className="ml-auto" />
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
