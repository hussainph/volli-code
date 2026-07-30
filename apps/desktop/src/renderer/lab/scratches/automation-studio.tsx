/**
 * Automations: an index on the left, the file you are editing in the middle, and
 * a board you can flip to when the question is *where does this fire* — and, as
 * of this pass, *in what digit order*.
 *
 * ── WHY A RAIL AND NOT A DRILL-IN ─────────────────────────────────────────
 * Authoring is where the time goes. The list is a persistent rail; switching
 * automations is one click. The board is a second reading *and* the place you
 * drag to set 1–9 for the drag picker (shared with `automation-trigger` via
 * {@link useColumnOrder}). Arming a column's plain-drop default is a different
 * act, and it lives on the board canvas — not here.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ── THE SPINE IS ONE PARALLEL STAGE ───────────────────────────────────────
 * Volli cannot tell "the work is done" from a harness Stop hook. So this page
 * only authors launches that start together: one agent, or several alongside
 * each other. Sequencing across launches is a column move (or a schedule),
 * written as separate automations. The add control says that out loud —
 * `Add alongside` — rather than adding a step and then asking how it joins.
 *
 * Skills open inline on `/`. Rename is Linear-shaped. Runtime dials stay
 * decoupled — harness, model, a weighted effort slider — with the composed
 * launch on hover.
 * ──────────────────────────────────────────────────────────────────────────
 */
import * as React from "react";
import { ArrowsSplitIcon } from "@phosphor-icons/react/dist/csr/ArrowsSplit";
import { DotsSixVerticalIcon } from "@phosphor-icons/react/dist/csr/DotsSixVertical";
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

import {
  digitFor,
  forgetAutomation,
  getColumnOrder,
  offeredForColumn,
  reorderInColumn,
  useColumnOrder,
} from "../automation/column-order";
import { HarnessMark } from "../automation/harness-identity";
import { InlineTitle, StepIdField } from "../automation/inline-title";
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
  duplicateStep,
  freshStepId,
  harnessTrail,
  isOffBoardTrigger,
  removeStep,
  renameStep,
  replaceStep,
  SEEDED_AUTOMATIONS,
  triggerSummary,
  type Automation,
  type AutomationScope,
  type AutomationStep,
} from "../automation/model";

export const title = "Automation · studio";
export const note = "Parallel launches, / skills, board-ranked digits, decoupled runtime dials.";
export const viewport = "window" as const;

/* ------------------------------------------------------------ run state */

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

const LAB_PROJECT_SLUG = "volli-code";

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
        "active:scale-[0.99]",
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
                "hover:text-foreground active:scale-[0.97]",
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

      <p className="mt-auto px-2 pt-3 font-mono text-label break-words text-muted-foreground/60">
        {APP_DATA_DIR}
      </p>
    </nav>
  );
}

/* ------------------------------------------------------------- the board */

function BoardCard({
  automation,
  digit,
  dragging,
  onOpen,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  automation: Automation;
  digit: number | null;
  dragging: boolean;
  onOpen: () => void;
  onDragStart: () => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const state = runStateOf(automation.id);
  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", automation.id);
        onDragStart();
      }}
      onDragOver={onDragOver}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
      className={cn(
        "flex w-full flex-col gap-1.5 rounded-lg border bg-card px-2.5 py-2 text-left",
        "transition-[border-color,opacity,transform] duration-150 ease-out motion-reduce:transition-none",
        "outline-none",
        state.kind === "needs-you" ? "border-primary/50" : "border-border",
        state.kind === "off" && "opacity-55",
        dragging && "opacity-40 scale-[0.98]",
      )}
    >
      <div className="flex items-start gap-1.5">
        <span
          aria-hidden
          className="mt-0.5 cursor-grab text-muted-foreground/50 active:cursor-grabbing"
        >
          <DotsSixVerticalIcon weight="bold" className="size-3.5" />
        </span>
        {digit === null ? null : (
          <span
            className={cn(
              "grid size-5 shrink-0 place-items-center rounded-md font-mono text-label",
              digit === 1 ? "bg-primary/20 text-primary-text" : "bg-muted text-muted-foreground",
            )}
          >
            {digit}
          </span>
        )}
        <button
          type="button"
          onClick={onOpen}
          className={cn(
            "min-w-0 flex-1 cursor-pointer truncate text-left text-ui text-foreground",
            "outline-none focus-visible:underline",
          )}
        >
          {automation.name || "Untitled"}
        </button>
      </div>
      <span className="flex items-center justify-between gap-2 pl-5">
        <span className="flex items-center gap-1">
          {harnessTrail(automation).map((harnessId) => (
            <HarnessMark key={harnessId} harnessId={harnessId} labelled />
          ))}
        </span>
        <RunBadge state={state} />
      </span>
      {state.kind === "needs-you" ? (
        <span className="truncate pl-5 text-label text-muted-foreground">{state.why}</span>
      ) : null}
    </div>
  );
}

/**
 * Rank the digits for the drag picker. Drag within a lane to set 1–9.
 * Arming (plain-drop default) is deliberately absent — that lives on the canvas.
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
  const [order, setOrder] = useColumnOrder();
  const [drag, setDrag] = React.useState<{ status: TicketStatus; index: number } | null>(null);
  const offBoard = automations.filter((automation) => isOffBoardTrigger(automation.trigger));

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="flex gap-4">
        <div className="flex w-44 shrink-0 flex-col gap-2 border-r border-dashed border-border pr-4">
          <p className="flex h-8 items-center text-label text-muted-foreground uppercase">
            Off board
          </p>
          {offBoard.map((automation) => (
            <button
              key={automation.id}
              type="button"
              onClick={() => onOpen(automation.id)}
              className={cn(
                "flex w-full cursor-pointer flex-col gap-1.5 rounded-lg border border-border bg-card px-2.5 py-2 text-left",
                "transition-[border-color] duration-150 ease-out hover:border-muted-foreground/40",
                "outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
                "active:scale-[0.99]",
              )}
            >
              <span className="truncate text-ui text-foreground">
                {automation.name || "Untitled"}
              </span>
              <span className="text-label text-muted-foreground">
                {triggerSummary(automation.trigger)}
              </span>
            </button>
          ))}
        </div>

        <div className="grid min-w-0 flex-1 grid-cols-5 gap-3">
          {TICKET_STATUSES.map((status) => {
            const inLane = offeredForColumn(automations, status, order);
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
                      "hover:text-foreground active:scale-[0.97]",
                      "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    )}
                  >
                    <PlusIcon weight="bold" className="size-3" />
                  </button>
                </div>
                {inLane.map((automation, index) => (
                  <BoardCard
                    key={`${status}-${automation.id}`}
                    automation={automation}
                    digit={digitFor(automations, status, order, automation.id)}
                    dragging={drag?.status === status && drag.index === index}
                    onOpen={() => onOpen(automation.id)}
                    onDragStart={() => setDrag({ status, index })}
                    onDragOver={(event) => {
                      if (drag === null || drag.status !== status) return;
                      event.preventDefault();
                      if (drag.index === index) return;
                      setOrder(reorderInColumn(automations, order, status, drag.index, index));
                      setDrag({ status, index });
                    }}
                    onDrop={() => setDrag(null)}
                    onDragEnd={() => setDrag(null)}
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

function AddAlongside({ onClick, empty }: { onClick: () => void; empty: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-xl border border-dashed border-border px-3 py-3 text-ui text-muted-foreground",
        "transition-[background-color,border-color,color,transform] duration-150 ease-out motion-reduce:transition-none",
        "hover:border-muted-foreground/50 hover:bg-accent/40 hover:text-foreground",
        "active:scale-[0.995]",
        "outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
      )}
    >
      {empty ? (
        <PlusIcon weight="bold" className="size-3.5 shrink-0" />
      ) : (
        <ArrowsSplitIcon weight="bold" className="size-3.5 shrink-0" />
      )}
      {empty ? "Add agent" : "Add alongside"}
    </button>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-0.5 text-label text-muted-foreground">{label}</h2>
      {children}
    </section>
  );
}

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
    if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return;
    fromSource.current = true;
    onChange({ ...parsed.automation, id: automation.id });
  }

  const steps = automation.steps;

  function patchSteps(next: AutomationStep[]) {
    onChange({ ...automation, steps: next });
  }

  const taken = new Set(steps.map((step) => step.id));
  const named = steps.length > 1;
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <InlineTitle
            value={automation.name}
            onChange={(name) => onChange({ ...automation, name })}
            placeholder="Name this automation"
            ariaLabel="Automation name"
          />
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

            <Section label={steps.length > 1 ? "Agents — launch together" : "Agent"}>
              <div className="flex flex-col gap-2">
                {steps.map((step) => (
                  <StepCard
                    key={step.id}
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
                    onDuplicate={() =>
                      patchSteps(
                        duplicateStep(steps, step.id, freshStepId(steps, step.runtime.harnessId)),
                      )
                    }
                    onRemove={
                      steps.length > 1 ? () => patchSteps(removeStep(steps, step.id)) : null
                    }
                  />
                ))}

                <AddAlongside
                  empty={steps.length === 0}
                  onClick={() => {
                    const harnessId = steps.at(-1)?.runtime.harnessId ?? "claude-code";
                    patchSteps(
                      appendStep(steps, blankStep(harnessId, freshStepId(steps, harnessId))),
                    );
                  }}
                />
              </div>
            </Section>
          </div>
        </div>
      </div>

      {sourceOpen ? (
        <aside className="flex w-[34rem] min-w-0 shrink-0 flex-col border-l border-border">
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
            "transition-[background-color,color,transform] duration-150 ease-out motion-reduce:transition-none",
            "hover:text-foreground active:scale-[0.97]",
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
  const [, setOrder] = useColumnOrder();

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
      steps: [blankStep("claude-code", freshStepId([], "claude-code"))],
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
                setOrder(forgetAutomation(getColumnOrder(), selected.id));
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
