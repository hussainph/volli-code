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
 * ── THE SPINE IS A LIST WITH LABELLED EDGES ───────────────────────────────
 * The version before this one grouped steps into rows and called the groups
 * STAGES, with a hover-revealed `+ Stage` between rows and a hover-revealed
 * `+ Alongside` inside one. Two invented nouns, and both buttons invisible
 * until the pointer happened to be over the right region — no signifier
 * anywhere that either existed.
 *
 * What made the node canvas easy was never the canvas. It was that every
 * affordance was permanently on screen and shaped like what it did. So:
 *
 *   • ONE add control, always visible, full width, at the end of the list —
 *     the same shape as Cursor's `+ Add Trigger` and `+ Add Tool or MCP`.
 *   • The relationship between two steps is a control ON the edge between
 *     them, always visible, reading `then` or `at the same time`. It is the
 *     `also: true` field of the file, spelled in the words a person would use.
 *
 * No nouns to learn, nothing hidden, and one list rather than a grid — a
 * simultaneous pair reads from the edge label instead of from a layout the
 * reader has to infer.
 * ──────────────────────────────────────────────────────────────────────────
 */
import * as React from "react";
import { ArrowDownIcon } from "@phosphor-icons/react/dist/csr/ArrowDown";
import { ArrowsSplitIcon } from "@phosphor-icons/react/dist/csr/ArrowsSplit";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { FileCodeIcon } from "@phosphor-icons/react/dist/csr/FileCode";
import { KanbanIcon } from "@phosphor-icons/react/dist/csr/Kanban";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { ListBulletsIcon } from "@phosphor-icons/react/dist/csr/ListBullets";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { TICKET_STATUS_LABELS, TICKET_STATUSES, type TicketStatus } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { cn } from "@renderer/lib/utils";

import { HarnessMark } from "../automation/harness-identity";
import { StepCard } from "../automation/step-card";
import { TriggerCard } from "../automation/trigger-card";
import {
  APP_DATA_DIR,
  automationFilePath,
  formatAutomationFile,
  parseAutomationFile,
  type FileDiagnostic,
} from "../automation/file";
import {
  appendStep,
  blankStep,
  freshStepId,
  harnessTrail,
  removeStep,
  renameStep,
  replaceStep,
  SEEDED_AUTOMATIONS,
  setJoin,
  triggerSummary,
  type Automation,
  type AutomationScope,
  type AutomationStep,
  type StepJoin,
} from "../automation/model";

export const title = "Automation · studio";
export const note = "A rail to pick one, a composer to write it, a board to see where it fires.";
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

/**
 * The project these seeds belong to. Lab fiction: the shipped surface reads it
 * off the Project record, which is also what keys the automations directory —
 * a ticket's worktree is a different PATH than its project root, so a
 * path-keyed store would lose every automation the moment one was created.
 */
const LAB_PROJECT_SLUG = "volli-code";

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

      {/* Named once, at the foot of the list the paths are relative to — rather
          than repeated in full on every automation's header. */}
      <p className="mt-auto px-2 pt-3 font-mono text-label break-words text-muted-foreground/60">
        {APP_DATA_DIR}
      </p>
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
      aria-label="Step name"
      aria-invalid={invalid}
      className={cn(
        "min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 font-mono text-label text-muted-foreground",
        "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:text-destructive",
      )}
    />
  );
}

/**
 * The edge between two steps, and the only control over when the lower one
 * starts.
 *
 * It sits ON the connector for the same reason a graph editor puts a label on
 * an edge: the relationship belongs to the gap, not to either card. It is
 * always visible — an affordance you have to discover by hovering is an
 * affordance most people never learn exists — and it says `then` or `at the
 * same time`, which are the words rather than a vocabulary.
 */
function Connector({ join, onChange }: { join: StepJoin; onChange: (join: StepJoin) => void }) {
  const together = join === "with";
  return (
    <div className="relative flex h-9 items-center">
      {/* Drawn on `muted-foreground`, not `border`: the flow between two steps
          is the one thing this column exists to show, and on the border token it
          came out fainter than the outline of the cards it was joining. */}
      <span aria-hidden className="absolute left-4 h-full w-px bg-muted-foreground/25" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            className={cn(
              "relative ml-7 gap-1.5 border bg-background",
              together
                ? "border-primary/40 text-primary-text"
                : "border-border text-muted-foreground",
            )}
          >
            {together ? <ArrowsSplitIcon weight="bold" /> : <ArrowDownIcon weight="bold" />}
            {together ? "at the same time" : "then"}
            <CaretDownIcon weight="bold" className="size-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuRadioGroup
            value={join}
            onValueChange={(value) => onChange(value as StepJoin)}
          >
            <DropdownMenuRadioItem value="then">then</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="with">at the same time</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * Always on screen, full width, and shaped like the thing it makes.
 *
 * Lifted from Cursor's automation page, where `+ Add Trigger` and `+ Add Tool
 * or MCP` are permanent dashed rows rather than hover-revealed marks. The whole
 * reason a node canvas felt easy was that its handles were always there.
 */
function AddStep({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-xl border border-dashed border-border px-3 py-3 text-ui text-muted-foreground",
        "transition-[background-color,border-color,color] duration-150 ease-out motion-reduce:transition-none",
        "hover:border-muted-foreground/50 hover:bg-accent/40 hover:text-foreground",
        "outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
      )}
    >
      <PlusIcon weight="bold" className="size-3.5 shrink-0" />
      Add step
    </button>
  );
}

/** A muted heading over each block, so the page reads as a form rather than a canvas. */
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-0.5 text-label text-muted-foreground">{label}</h2>
      {children}
    </section>
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

  const steps = automation.steps;

  function patchSteps(next: AutomationStep[]) {
    onChange({ ...automation, steps: next });
  }

  const taken = new Set(steps.map((step) => step.id));
  // Ids only reach the file as `## headings` once there is more than one step to
  // head. Showing the field on a one-step automation would be offering to name
  // something nothing will ever print.
  const named = steps.length > 1;
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;

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
          {/* Relative to {@link APP_DATA_DIR}, which is named once above the
              rail rather than repeated on every automation — the shipped
              version would put a Reveal in Finder action here instead. */}
          <span className="shrink-0 font-mono text-label text-muted-foreground">
            {automationFilePath(automation, LAB_PROJECT_SLUG)}
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
          <div className="mx-auto flex w-full max-w-[42rem] flex-col gap-6 p-6">
            <Section label="Trigger">
              <TriggerCard
                trigger={automation.trigger}
                onChange={(trigger) => onChange({ ...automation, trigger })}
              />
            </Section>

            <Section label="Steps">
              {steps.map((step, index) => (
                <React.Fragment key={step.id}>
                  {index === 0 ? null : (
                    <Connector
                      join={step.join}
                      onChange={(join) => patchSteps(setJoin(steps, step.id, join))}
                    />
                  )}
                  <StepCard
                    step={step}
                    name={
                      named ? (
                        <StepIdField
                          id={step.id}
                          taken={taken}
                          onCommit={(next) => patchSteps(renameStep(steps, step.id, next))}
                        />
                      ) : null
                    }
                    onChange={(next) => patchSteps(replaceStep(steps, next))}
                    onDuplicate={() => {
                      const copy = {
                        ...step,
                        id: freshStepId(steps, step.runtime.harnessId),
                        join: "then" as const,
                      };
                      patchSteps([...steps, copy]);
                    }}
                    onRemove={
                      steps.length > 1 ? () => patchSteps(removeStep(steps, step.id)) : null
                    }
                  />
                </React.Fragment>
              ))}

              <AddStep
                onClick={() => {
                  // The harness of the step above, because the overwhelmingly
                  // common second step is "the same agent, next instruction".
                  const harnessId = steps.at(-1)?.runtime.harnessId ?? "claude-code";
                  patchSteps(
                    appendStep(steps, blankStep(harnessId, freshStepId(steps, harnessId))),
                  );
                }}
              />
            </Section>
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
      steps: [blankStep("claude-code", "claude-code")],
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
