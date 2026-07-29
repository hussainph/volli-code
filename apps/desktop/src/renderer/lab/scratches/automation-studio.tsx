/**
 * Automations: an index on the left, the file you are editing in the middle, and
 * a board you can flip to when the question is *where does this fire*.
 *
 * ── WHY A RAIL AND NOT A DRILL-IN ─────────────────────────────────────────
 * The previous pass made the board the front door and the editor a place you
 * navigated to. That inverted the ratio of the work: authoring is where all the
 * time goes, and putting it behind a back button meant every comparison between
 * two automations — the reason you have five of them — cost two navigations.
 *
 * So the list is a persistent rail and switching automations is one click, the
 * same relationship a file tree has with an editor. The board becomes what it
 * actually is: a second READING of the same set, answering a question the rail
 * cannot ("what fires in Needs Review?"), reached from a toggle rather than
 * from the back of a stack.
 *
 * An automation that fires in two columns appears in both lanes of that board.
 * It is one file either way — showing it once would mean picking a lane to lie
 * about, and the duplication is the honest render of `columns: [backlog, todo]`.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ── STAGES, AND THE AMBIGUITY THEY KILL ───────────────────────────────────
 * The editor's spine used to be a tree of `after` pointers, drawn with an
 * indent rail. Two things were wrong with it and they were the same thing: an
 * indented child reads as a BRANCH, so the surface implied a conditional Volli
 * cannot evaluate — and even read charitably, a reader had to decode the rail
 * to learn whether two cards were sequential or simultaneous.
 *
 * Now the geometry carries it with no rail at all. Down the page is time and
 * the gutter numbers it; across the row is at-once. Two `+` affordances, in the
 * two places those two things live: `Stage` on the divider BETWEEN rows,
 * `Alongside` at the end of a row. You cannot click the wrong one by accident,
 * because they are not in the same place and they do not look alike.
 * See {@link Stage}.
 * ──────────────────────────────────────────────────────────────────────────
 */
import * as React from "react";
import { FileCodeIcon } from "@phosphor-icons/react/dist/csr/FileCode";
import { KanbanIcon } from "@phosphor-icons/react/dist/csr/Kanban";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { ListBulletsIcon } from "@phosphor-icons/react/dist/csr/ListBullets";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { TICKET_STATUS_LABELS, TICKET_STATUSES, type TicketStatus } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { cn } from "@renderer/lib/utils";

import { HarnessMark, harnessLabelFor } from "../automation/harness-identity";
import { StepCard } from "../automation/step-card";
import { TriggerCard } from "../automation/trigger-card";
import {
  automationFilePath,
  formatAutomationFile,
  parseAutomationFile,
  type FileDiagnostic,
} from "../automation/file";
import {
  addToStage,
  allSteps,
  blankStep,
  firstLine,
  freshStepId,
  harnessTrail,
  HARNESS_ADAPTERS,
  insertStage,
  removeStep,
  renameStep,
  replaceStep,
  SEEDED_AUTOMATIONS,
  triggerSummary,
  type Automation,
  type AutomationScope,
  type AutomationStep,
  type Stage,
} from "../automation/model";

export const title = "Automation · studio";
export const note = "A rail to pick one, a spine to write it, a board to see where it fires.";
export const viewport = "window" as const;

/* ------------------------------------------------------------ run state */

/**
 * What an automation is doing right now.
 *
 * Lab fiction, and the only fiction here — everything else round-trips through
 * the real format. It exists because the board's whole claim is that it answers
 * a question the file cannot, and a board of idle rectangles cannot demonstrate
 * that. `idle` renders as NOTHING: it is the common case, and a badge saying so
 * on every row would spend the silhouette these surfaces exist to show.
 */
type RunState =
  | { kind: "idle" }
  | { kind: "running"; ticket: string }
  | { kind: "needs-you"; ticket: string; why: string }
  | { kind: "off" };

const RUN_STATE: Record<string, RunState> = {
  "atm-implement": { kind: "running", ticket: "VLT-14" },
  "atm-review": { kind: "needs-you", ticket: "VLT-9", why: "Codex found 3 blockers" },
  "atm-wrapup": { kind: "off" },
};

function runStateOf(id: string): RunState {
  return RUN_STATE[id] ?? { kind: "idle" };
}

/** Only the running one pulses — two moving states means neither reads as urgent. */
function RunDot({ state }: { state: RunState }) {
  const reducedMotion = useReducedMotion();
  if (state.kind === "idle") return null;
  if (state.kind === "off") {
    return <span aria-hidden className="size-1.5 shrink-0 rounded-full border border-border" />;
  }
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        state.kind === "needs-you" ? "bg-primary" : "bg-muted-foreground",
        state.kind === "running" && !reducedMotion && "animate-pulse",
      )}
    />
  );
}

function RunBadge({ state }: { state: RunState }) {
  if (state.kind === "idle") return null;
  if (state.kind === "off") return <span className="text-label text-muted-foreground">Off</span>;
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-label",
        state.kind === "needs-you" ? "text-primary-text" : "text-muted-foreground",
      )}
    >
      <RunDot state={state} />
      <span className="truncate font-mono">{state.ticket}</span>
    </span>
  );
}

/* ------------------------------------------------------------- the rail */

function IndexRow({
  automation,
  selected,
  onSelect,
}: {
  automation: Automation;
  selected: boolean;
  onSelect: () => void;
}) {
  const state = runStateOf(automation.id);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left",
        "transition-[background-color] duration-150 ease-out motion-reduce:transition-none",
        "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        selected ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      <span className="flex items-center gap-2">
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-ui",
            selected ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {automation.name || "Untitled"}
        </span>
        <RunDot state={state} />
      </span>
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-label text-muted-foreground">
          {triggerSummary(automation.trigger)}
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          {harnessTrail(automation).map((harnessId) => (
            <HarnessMark key={harnessId} harnessId={harnessId} />
          ))}
        </span>
      </span>
    </button>
  );
}

/**
 * Grouped by scope, because scope is the one property of an automation that is
 * not visible anywhere on its own row — a global automation and a project one
 * look identical, and the difference is which repos it fires in.
 */
function IndexRail({
  automations,
  selectedId,
  onSelect,
  onCreate,
}: {
  automations: Automation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: (scope: AutomationScope) => void;
}) {
  const groups: Array<{ scope: AutomationScope; label: string }> = [
    { scope: "project", label: "This project" },
    { scope: "global", label: "Global" },
  ];

  return (
    <nav className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-border p-2">
      {groups.map((group) => (
        <div key={group.scope} className="group/group flex flex-col gap-0.5 pb-3">
          <div className="flex h-7 items-center gap-2 px-2">
            <h2 className="text-label text-muted-foreground uppercase">{group.label}</h2>
            <button
              type="button"
              onClick={() => onCreate(group.scope)}
              aria-label={`New ${group.label} automation`}
              className={cn(
                "ml-auto grid size-5 shrink-0 cursor-pointer place-items-center rounded text-muted-foreground",
                "opacity-0 group-focus-within/group:opacity-100 group-hover/group:opacity-100 focus-visible:opacity-100",
                "transition-[opacity,color] duration-150 ease-out motion-reduce:transition-none",
                "hover:text-foreground",
                "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              )}
            >
              <PlusIcon weight="bold" className="size-3" />
            </button>
          </div>
          {automations
            .filter((automation) => automation.scope === group.scope)
            .map((automation) => (
              <IndexRow
                key={automation.id}
                automation={automation}
                selected={automation.id === selectedId}
                onSelect={() => onSelect(automation.id)}
              />
            ))}
        </div>
      ))}
    </nav>
  );
}

/* ------------------------------------------------------------- the board */

function BoardCard({ automation, onOpen }: { automation: Automation; onOpen: () => void }) {
  const state = runStateOf(automation.id);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-1.5 rounded-lg border bg-card px-2.5 py-2 text-left",
        "transition-[border-color,opacity] duration-150 ease-out motion-reduce:transition-none",
        "hover:border-muted-foreground/40",
        "outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        state.kind === "needs-you" ? "border-primary/50" : "border-border",
        state.kind === "off" && "opacity-55",
      )}
    >
      <span className="truncate text-ui text-foreground">{automation.name || "Untitled"}</span>
      <span className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1">
          {harnessTrail(automation).map((harnessId) => (
            <HarnessMark key={harnessId} harnessId={harnessId} labelled />
          ))}
        </span>
        <RunBadge state={state} />
      </span>
      {state.kind === "needs-you" ? (
        <span className="truncate text-label text-muted-foreground">{state.why}</span>
      ) : null}
    </button>
  );
}

/**
 * The same set, read by column instead of by name.
 *
 * A card appears in every lane its trigger names. That is not a rendering
 * shortcut — `enters-column: [backlog, todo]` really does fire in two places,
 * and a board that deduplicated would be answering "what fires here?" with a
 * maybe.
 */
function BoardView({
  automations,
  onOpen,
  onCreate,
}: {
  automations: Automation[];
  onOpen: (id: string) => void;
  onCreate: (column: TicketStatus) => void;
}) {
  const offBoard = automations.filter((automation) => automation.trigger.kind === "manual");

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="flex gap-4">
        {/*
         * Everything that fires without a column. Beside the lanes rather than
         * in them because these are the triggers whose job may be to CREATE a
         * ticket — a scheduled automation does not react to a column, it enters
         * the board — so a lane would claim they fire somewhere on it.
         */}
        <div className="flex w-44 shrink-0 flex-col gap-2 border-r border-dashed border-border pr-4">
          <p className="flex h-8 items-center text-label text-muted-foreground uppercase">
            Off board
          </p>
          {offBoard.map((automation) => (
            <BoardCard
              key={automation.id}
              automation={automation}
              onOpen={() => onOpen(automation.id)}
            />
          ))}
        </div>

        <div className="grid min-w-0 flex-1 grid-cols-5 gap-3">
          {TICKET_STATUSES.map((status) => {
            const inLane = automations.filter(
              (automation) =>
                automation.trigger.kind !== "manual" && automation.trigger.columns.includes(status),
            );
            return (
              <div key={status} className="group/lane flex min-w-0 flex-col gap-2">
                <div className="flex h-8 items-center gap-2 text-label text-muted-foreground uppercase">
                  {TICKET_STATUS_LABELS[status]}
                  <span className="tabular-nums">{inLane.length || ""}</span>
                  <button
                    type="button"
                    onClick={() => onCreate(status)}
                    aria-label={`New automation in ${TICKET_STATUS_LABELS[status]}`}
                    className={cn(
                      "ml-auto grid size-5 shrink-0 cursor-pointer place-items-center rounded",
                      "opacity-0 group-focus-within/lane:opacity-100 group-hover/lane:opacity-100 focus-visible:opacity-100",
                      "transition-[opacity,color] duration-150 ease-out motion-reduce:transition-none",
                      "hover:text-foreground",
                      "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    )}
                  >
                    <PlusIcon weight="bold" className="size-3" />
                  </button>
                </div>
                {inLane.map((automation) => (
                  <BoardCard
                    key={automation.id}
                    automation={automation}
                    onOpen={() => onOpen(automation.id)}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- the spine */

/** The collapsed face: everything that differs between two steps, and nothing else. */
function StepChip({
  step,
  selected,
  onOpen,
}: {
  step: AutomationStep;
  selected: boolean;
  onOpen: () => void;
}) {
  const { runtime } = step;
  const adapter = HARNESS_ADAPTERS[runtime.harnessId];
  const dials = [
    adapter.effort === null ? null : runtime.effort,
    adapter.approvals === null ? null : runtime.approvals,
  ].filter((value): value is string => value !== null && value !== "");

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-expanded={selected}
      className={cn(
        "flex min-w-0 flex-1 basis-56 cursor-pointer flex-col gap-0.5 rounded-lg border bg-card px-3 py-2.5 text-left",
        "transition-[border-color] duration-150 ease-out motion-reduce:transition-none",
        "hover:border-muted-foreground/40",
        "outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        selected ? "border-primary/50" : "border-border",
      )}
    >
      <span className="flex items-baseline gap-1.5 overflow-hidden">
        <HarnessMark harnessId={runtime.harnessId} className="translate-y-0.5" />
        <span className="shrink-0 text-ui text-foreground">
          {harnessLabelFor(runtime.harnessId)}
        </span>
        <span className="truncate font-mono text-label text-muted-foreground">{runtime.model}</span>
      </span>
      {/* Its own line rather than trailing the model, because the model name is
          long and variable and would push the safety-relevant half of the
          runtime off the end of exactly the steps that need watching. */}
      <span className="truncate font-mono text-label text-muted-foreground">
        {dials.join(" · ")}
      </span>
      <span className="truncate text-label text-muted-foreground">
        {firstLine(step.instructions) || "No instructions"}
      </span>
    </button>
  );
}

/**
 * The step id, committed on blur or Enter rather than per keystroke.
 *
 * Per-keystroke was the rename bug: the id is this step's React key and its
 * `## heading`, so every character re-keyed the row, remounted the input and put
 * the caret at the end — you could type `tri` and get `t`, `r`, `i` as three
 * separate one-character renames. A draft makes the intermediate states local
 * and lets an invalid one (empty, or already taken) simply revert.
 */
function StepIdField({
  id,
  taken,
  onCommit,
}: {
  id: string;
  taken: Set<string>;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = React.useState(id);
  React.useEffect(() => setDraft(id), [id]);

  const trimmed = draft.trim();
  const invalid = trimmed === "" || (trimmed !== id && taken.has(trimmed));

  function commit() {
    if (invalid) {
      setDraft(id);
      return;
    }
    if (trimmed !== id) onCommit(trimmed);
  }

  return (
    <input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(id);
          event.currentTarget.blur();
        }
      }}
      spellCheck={false}
      aria-label="Step id"
      aria-invalid={invalid}
      className={cn(
        "min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 font-mono text-label text-muted-foreground",
        "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:text-destructive",
      )}
    />
  );
}

function StepEditor({
  step,
  taken,
  showId,
  onChange,
  onRename,
  onRemove,
  onCollapse,
}: {
  step: AutomationStep;
  taken: Set<string>;
  /** The id is only a name you will ever read when the file writes `## headings` at all. */
  showId: boolean;
  onChange: (step: AutomationStep) => void;
  onRename: (next: string) => void;
  onRemove: (() => void) | null;
  onCollapse: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {showId || onRemove !== null ? (
        <div className="flex items-center gap-2 px-0.5">
          {showId ? <StepIdField id={step.id} taken={taken} onCommit={onRename} /> : <span />}
          {onRemove === null ? null : (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${step.id}`}
              onClick={onRemove}
            >
              <TrashIcon />
            </Button>
          )}
          <Button variant="ghost" size="xs" onClick={onCollapse}>
            Done
          </Button>
        </div>
      ) : null}
      <StepCard step={step} onChange={onChange} onDuplicate={null} onRemove={null} />
    </div>
  );
}

/**
 * The divider between two stages, and the only place a new stage can be made.
 *
 * The connector runs through it at full height so the spine stays continuous
 * whether or not you are hovering — the line is structure, the button is an
 * affordance, and only the button hides.
 */
function StageGap({ onInsert }: { onInsert: () => void }) {
  return (
    <div className="group/gap relative flex h-7 items-center">
      <span aria-hidden className="absolute left-2 h-full w-px bg-muted-foreground/30" />
      <button
        type="button"
        onClick={onInsert}
        className={cn(
          "ml-6 flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-label text-muted-foreground",
          "opacity-0 group-hover/gap:opacity-100 focus-visible:opacity-100",
          "transition-[opacity,color] duration-150 ease-out motion-reduce:transition-none",
          "hover:text-primary-text",
          "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        )}
      >
        <PlusIcon weight="bold" className="size-3" />
        Stage
      </button>
    </div>
  );
}

/**
 * One stage: its steps side by side, its number in the gutter, and its open
 * step's editor beneath it.
 *
 * The editor is a full-width row under the chips rather than an expansion of
 * the chip itself, because a stage of two would otherwise have to choose
 * between a 20rem editor and a layout that jumps when you open one.
 */
function StageRow({
  stage,
  index,
  openId,
  taken,
  showIds,
  removable,
  onOpen,
  onCollapse,
  onChange,
  onRename,
  onRemove,
  onAlongside,
}: {
  stage: Stage;
  index: number;
  openId: string | null;
  taken: Set<string>;
  showIds: boolean;
  removable: boolean;
  onOpen: (id: string) => void;
  onCollapse: () => void;
  onChange: (step: AutomationStep) => void;
  onRename: (from: string, to: string) => void;
  onRemove: (id: string) => void;
  onAlongside: () => void;
}) {
  const open = stage.find((step) => step.id === openId) ?? null;

  return (
    <div className="group/stage flex gap-2">
      <span
        aria-hidden
        className="w-4 shrink-0 pt-2.5 text-center font-mono text-label tabular-nums text-muted-foreground"
      >
        {index + 1}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-stretch gap-2">
          {stage.map((step) => (
            <StepChip
              key={step.id}
              step={step}
              selected={step.id === openId}
              onOpen={() => (step.id === openId ? onCollapse() : onOpen(step.id))}
            />
          ))}
          {/* Dashed, inside the row, and the same height as the chips it sits
              beside — the shape says "another one of these, here", where the
              Stage button below says "another row". */}
          <button
            type="button"
            onClick={onAlongside}
            className={cn(
              "flex shrink-0 cursor-pointer items-center gap-1 self-stretch rounded-lg border border-dashed border-border px-2.5 text-label text-muted-foreground",
              "opacity-0 group-focus-within/stage:opacity-100 group-hover/stage:opacity-100 focus-visible:opacity-100",
              "transition-[opacity,color,border-color] duration-150 ease-out motion-reduce:transition-none",
              "hover:border-muted-foreground/50 hover:text-foreground",
              "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            )}
          >
            <PlusIcon weight="bold" className="size-3" />
            Alongside
          </button>
        </div>

        {open === null ? null : (
          <StepEditor
            key={open.id}
            step={open}
            taken={taken}
            showId={showIds}
            onChange={onChange}
            onRename={(next) => onRename(open.id, next)}
            onRemove={removable ? () => onRemove(open.id) : null}
            onCollapse={onCollapse}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ the source */

function Diagnostics({ diagnostics }: { diagnostics: FileDiagnostic[] }) {
  if (diagnostics.length === 0) return null;
  return (
    <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto border-t border-border px-3 py-2">
      {diagnostics.map((diagnostic) => (
        <li
          key={`${diagnostic.line ?? "file"}:${diagnostic.severity}:${diagnostic.message}`}
          className={cn(
            "flex items-start gap-1.5 text-label",
            diagnostic.severity === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          <WarningIcon weight="fill" aria-hidden className="mt-0.5 size-3 shrink-0" />
          <span className="font-mono tabular-nums opacity-70">
            {diagnostic.line === null ? "—" : diagnostic.line}
          </span>
          <span className="min-w-0">{diagnostic.message}</span>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------ the editor */

function Editor({
  automation,
  onChange,
  onDelete,
}: {
  automation: Automation;
  onChange: (automation: Automation) => void;
  onDelete: () => void;
}) {
  const steps = allSteps(automation);
  const [openId, setOpenId] = React.useState<string | null>(steps[0]?.id ?? null);
  const [sourceOpen, setSourceOpen] = React.useState(false);
  const [source, setSource] = React.useState(() => formatAutomationFile(automation));
  const [diagnostics, setDiagnostics] = React.useState<FileDiagnostic[]>([]);

  // Which side spoke last. Without it, regenerating the file from the model on
  // every keystroke would rewrite the textarea you are typing into and put the
  // caret back at the end of it.
  const fromSource = React.useRef(false);

  React.useEffect(() => {
    if (fromSource.current) {
      fromSource.current = false;
      return;
    }
    setSource(formatAutomationFile(automation));
    setDiagnostics([]);
  }, [automation]);

  function editSource(text: string) {
    setSource(text);
    const parsed = parseAutomationFile(text, automation.name);
    setDiagnostics(parsed.diagnostics);
    fromSource.current = true;
    // The id is the automation's identity in this session, not something the
    // file names — keeping it means editing the name in the textarea renames the
    // automation rather than replacing it with a stranger.
    onChange({ ...parsed.automation, id: automation.id });
  }

  function patchStages(stages: Stage[]) {
    onChange({ ...automation, stages });
  }

  const taken = new Set(steps.map((step) => step.id));
  // Ids only reach the file as `## headings` once there is more than one step to
  // head. Showing the field on a one-step automation would be offering to name
  // something nothing will ever print.
  const showIds = steps.length > 1;
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;

  function addStage(at: number) {
    const harnessId = steps.at(-1)?.runtime.harnessId ?? "claude-code";
    const step = blankStep(harnessId, freshStepId(automation.stages, harnessId));
    patchStages(insertStage(automation.stages, at, step));
    setOpenId(step.id);
  }

  function addAlongside(at: number) {
    const harnessId = automation.stages[at][0].runtime.harnessId;
    const step = blankStep(harnessId, freshStepId(automation.stages, harnessId));
    patchStages(addToStage(automation.stages, at, step));
    setOpenId(step.id);
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <input
            value={automation.name}
            onChange={(event) => onChange({ ...automation, name: event.target.value })}
            placeholder="Name"
            aria-label="Automation name"
            className={cn(
              "min-w-0 flex-1 rounded bg-transparent px-1.5 py-0.5 text-ui text-foreground",
              "outline-none placeholder:text-muted-foreground",
              "focus-visible:ring-[3px] focus-visible:ring-ring/50",
            )}
          />
          <span className="shrink-0 font-mono text-label text-muted-foreground">
            {automationFilePath(automation)}
          </span>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setSourceOpen((open) => !open)}
            aria-pressed={sourceOpen}
            className="aria-pressed:bg-primary/15 aria-pressed:text-primary-text"
          >
            <FileCodeIcon />
            Source
            {errors > 0 ? <span className="text-destructive">{errors}</span> : null}
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Delete automation" onClick={onDelete}>
            <TrashIcon />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[44rem] flex-col p-4">
            <TriggerCard
              trigger={automation.trigger}
              onChange={(trigger) => onChange({ ...automation, trigger })}
            />

            {automation.stages.map((stage, index) => (
              <React.Fragment key={stage[0].id}>
                <StageGap onInsert={() => addStage(index)} />
                <StageRow
                  stage={stage}
                  index={index}
                  openId={openId}
                  taken={taken}
                  showIds={showIds}
                  removable={steps.length > 1}
                  onOpen={setOpenId}
                  onCollapse={() => setOpenId(null)}
                  onChange={(next) => patchStages(replaceStep(automation.stages, next))}
                  onRename={(from, to) => {
                    patchStages(renameStep(automation.stages, from, to));
                    setOpenId((current) => (current === from ? to : current));
                  }}
                  onRemove={(id) => {
                    patchStages(removeStep(automation.stages, id));
                    setOpenId((current) => (current === id ? null : current));
                  }}
                  onAlongside={() => addAlongside(index)}
                />
              </React.Fragment>
            ))}

            <StageGap onInsert={() => addStage(automation.stages.length)} />
          </div>
        </div>
      </div>

      {sourceOpen ? (
        <aside className="flex w-[34rem] min-w-0 shrink-0 flex-col border-l border-border">
          {/* Editable, and that is the point: the file is what an Automation IS,
              so a source panel you can only read would be asserting the opposite
              — that the file is a report the UI prints. */}
          <textarea
            value={source}
            onChange={(event) => editSource(event.target.value)}
            spellCheck={false}
            aria-label="Automation file"
            className={cn(
              "min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-xs leading-relaxed text-foreground",
              "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset",
            )}
          />
          <Diagnostics diagnostics={diagnostics} />
        </aside>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- scratch */

type View = "list" | "board";

function ViewToggle({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  const options: Array<{ value: View; label: string; Icon: typeof ListBulletsIcon }> = [
    { value: "list", label: "List", Icon: ListBulletsIcon },
    { value: "board", label: "Board", Icon: KanbanIcon },
  ];

  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
      {options.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          aria-pressed={view === value}
          className={cn(
            "flex cursor-pointer items-center gap-1.5 rounded px-2 py-0.5 text-label text-muted-foreground",
            "transition-[background-color,color] duration-150 ease-out motion-reduce:transition-none",
            "hover:text-foreground",
            "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            "aria-pressed:bg-accent aria-pressed:text-foreground",
          )}
        >
          <Icon weight="fill" aria-hidden className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}

export default function AutomationStudioScratch() {
  const [automations, setAutomations] = React.useState<Automation[]>(SEEDED_AUTOMATIONS);
  const [selectedId, setSelectedId] = React.useState<string | null>(SEEDED_AUTOMATIONS[0].id);
  const [view, setView] = React.useState<View>("list");

  const selected = automations.find((automation) => automation.id === selectedId) ?? null;
  const nextId = React.useRef(1);

  function create(scope: AutomationScope, column: TicketStatus | null) {
    const id = `atm-new-${nextId.current}`;
    nextId.current += 1;
    const fresh: Automation = {
      id,
      scope,
      name: "",
      trigger: { kind: "enters-column", columns: column === null ? [] : [column] },
      stages: [[blankStep("claude-code", "claude-code")]],
    };
    setAutomations((current) => [...current, fresh]);
    setSelectedId(id);
    setView("list");
  }

  function open(id: string) {
    setSelectedId(id);
    setView("list");
  }

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <LightningIcon weight="fill" aria-hidden className="size-3.5 text-muted-foreground" />
        <h1 className="text-ui text-foreground">Automations</h1>
        <div className="ml-auto flex items-center gap-2">
          <ViewToggle view={view} onChange={setView} />
          <Button variant="ghost" size="xs" onClick={() => create("project", null)}>
            <PlusIcon />
            New
          </Button>
        </div>
      </header>

      {view === "board" ? (
        <BoardView
          automations={automations}
          onOpen={open}
          onCreate={(column) => create("project", column)}
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <IndexRail
            automations={automations}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onCreate={(scope) => create(scope, null)}
          />
          {selected === null ? (
            <div className="grid flex-1 place-items-center text-ui text-muted-foreground">
              No automation selected
            </div>
          ) : (
            <Editor
              key={selected.id}
              automation={selected}
              onChange={(next) =>
                setAutomations((current) =>
                  current.map((automation) => (automation.id === next.id ? next : automation)),
                )
              }
              onDelete={() => {
                setAutomations((current) =>
                  current.filter((automation) => automation.id !== selected.id),
                );
                setSelectedId(null);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
