/**
 * Automations, integrated: the board map as the index, the spine as the editor,
 * and a file underneath both.
 *
 * ── WHAT THIS REPLACES, AND WHY ───────────────────────────────────────────
 * Three scratches asked the same question three ways — a form (`automation-form`),
 * a board-shaped canvas of every automation (`automation-map`), and a React Flow
 * node builder (`automation-flow`). Research into the category settled it, and
 * the deciding fact was not about canvases at all: no shipping coding-agent
 * product lets you author repeated agent work on a node graph, and the ones with
 * real design budgets — Devin, Codex, Cursor, Copilot, Linear — all landed on the
 * same substitute, a checked-in text file. Devin calls it a Playbook, OpenAI
 * calls it AGENTS.md, GitHub calls it a custom agent. Frontmatter for the
 * parameters, prose for the prompt.
 *
 * The canvas lost on its own terms, too. At one step — which is what three of the
 * four seeded automations actually are — the flow canvas rendered as a trigger
 * card above a run card in a single column, i.e. exactly the form, plus a camera,
 * a zoom control and a Tidy button with nothing to do. A canvas whose typical
 * instance is two nodes is a form that charges rent.
 *
 * What the canvas DID earn is here: the collapsed step face, and the model fix.
 * See {@link AutomationStep.after}.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ── THE SPLIT ─────────────────────────────────────────────────────────────
 * The map's earlier draft put authoring in a slide-in inspector, which inverted
 * the priority: the thing you spend all your time on became a 30rem panel beside
 * the thing you glance at. So the two surfaces are not left and right, they are
 * before and after — the map is the index and answers *what fires where, and
 * what is running right now*; opening one gives the whole window to the spine.
 * Same relationship the board already has with a ticket.
 *
 * That also re-aims the map at the problem the research says is actually
 * unsolved. Every product in the survey authored fine and is now drowning in
 * review — teams shipping 98% more PRs and spending 91% longer reviewing them —
 * and not one of them shows agent state on the board itself. Linear puts it in
 * the issue's activity feed, a level down. Volli already knows what is running.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ── ONE OPEN AT A TIME ────────────────────────────────────────────────────
 * Every step is an agent run, so a step's face has to carry four facts that
 * differ between steps — harness, model, dials, the first line of the prompt —
 * and none of the icon-and-label faces the canvas products use would hold them.
 * But two open editors is 1000px of column and the shape is gone. So: two sizes,
 * exactly one open, and the last one you opened keeps an accent border so
 * collapsing does not lose your place.
 * ──────────────────────────────────────────────────────────────────────────
 */
import * as React from "react";
import { ArrowLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { FileCodeIcon } from "@phosphor-icons/react/dist/csr/FileCode";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { TrayArrowDownIcon } from "@phosphor-icons/react/dist/csr/TrayArrowDown";
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
  blankStep,
  childrenOf,
  firstLine,
  harnessTrail,
  HARNESS_ADAPTERS,
  SEEDED_AUTOMATIONS,
  type Automation,
  type AutomationStep,
} from "../automation/model";

export const title = "Automation · studio";
export const note = "Map to find it, spine to write it, a file underneath both.";
export const viewport = "window" as const;

/* ------------------------------------------------------------ run state */

/**
 * What an automation is doing right now.
 *
 * Lab fiction, and the only fiction here — everything else round-trips through
 * the real format. It exists because the map's whole claim is that it answers a
 * question the file cannot, and a map of five idle rectangles cannot demonstrate
 * that. `idle` renders as NOTHING: it is the common case, and a badge saying so
 * on every card would spend the silhouette the map exists to show.
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

/* -------------------------------------------------------------- step tree */

/** Renaming a step moves the heading its prose lives under, so children follow it. */
function renameStep(steps: AutomationStep[], from: string, to: string): AutomationStep[] {
  const renamed: AutomationStep[] = [];
  for (const step of steps) {
    if (step.id !== from && step.after !== from) {
      renamed.push(step);
      continue;
    }
    const next: AutomationStep = { ...step };
    if (next.id === from) next.id = to;
    if (next.after === from) next.after = to;
    renamed.push(next);
  }
  return renamed;
}

/**
 * Removing a step re-parents its children onto its own parent rather than
 * orphaning them. Dropping them instead would delete prose the author never
 * asked to delete, and leaving them pointing at a missing id would produce a
 * file that does not parse.
 */
function removeStep(steps: AutomationStep[], id: string): AutomationStep[] {
  const parent = steps.find((step) => step.id === id)?.after ?? null;
  const kept: AutomationStep[] = [];
  for (const step of steps) {
    if (step.id === id) continue;
    kept.push(step.after === id ? { ...step, after: parent } : step);
  }
  return kept;
}

/* ------------------------------------------------------------- map cards */

function RunBadge({ state }: { state: RunState }) {
  const reducedMotion = useReducedMotion();
  if (state.kind === "idle") return null;

  if (state.kind === "off") {
    return <span className="text-label text-muted-foreground">Off</span>;
  }

  const needsYou = state.kind === "needs-you";
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-label",
        needsYou ? "text-primary-text" : "text-muted-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          needsYou ? "bg-primary" : "bg-muted-foreground",
          // Only the running one pulses. A board where two different states both
          // move is a board where neither reads as the urgent one.
          state.kind === "running" && !reducedMotion && "animate-pulse",
        )}
      />
      <span className="truncate font-mono">{state.ticket}</span>
    </span>
  );
}

function MapCard({
  automation,
  state,
  onOpen,
}: {
  automation: Automation;
  state: RunState;
  onOpen: () => void;
}) {
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
      <span className="truncate text-ui text-foreground">{automation.name}</span>
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

/* --------------------------------------------------------------- the map */

function MapView({
  automations,
  onOpen,
  onCreate,
}: {
  automations: Automation[];
  onOpen: (id: string) => void;
  onCreate: (column: TicketStatus | null) => void;
}) {
  const lanes = TICKET_STATUSES.map((status) => ({
    status,
    automations: automations.filter(
      (automation) =>
        automation.trigger.kind !== "manual" && automation.trigger.columns.includes(status),
    ),
  }));
  const offBoard = automations.filter((automation) => automation.trigger.kind === "manual");

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="flex gap-4">
        {/*
         * Everything that fires without a column. Beside the lanes rather than
         * in them because these are the triggers whose job may be to CREATE a
         * ticket — a scheduled automation does not react to a column, it enters
         * the board — so a lane would claim they fire somewhere on the spine.
         */}
        <div className="flex w-44 shrink-0 flex-col gap-2 border-r border-dashed border-border pr-4">
          <p className="flex h-8 items-center text-label text-muted-foreground uppercase">
            Off board
          </p>
          {offBoard.map((automation) => (
            <MapCard
              key={automation.id}
              automation={automation}
              state={runStateOf(automation.id)}
              onOpen={() => onOpen(automation.id)}
            />
          ))}
          {[
            { icon: ClockIcon, label: "Schedule" },
            { icon: TrayArrowDownIcon, label: "Inbound event" },
          ].map(({ icon: RowIcon, label }) => (
            <div
              key={label}
              className="flex items-center gap-2 rounded-lg border border-dashed border-border px-2.5 py-2.5 text-ui text-muted-foreground"
            >
              <RowIcon aria-hidden className="size-3.5 shrink-0" />
              {label}
            </div>
          ))}
        </div>

        <div className="grid min-w-0 flex-1 grid-cols-5 gap-3">
          {lanes.map((lane) => (
            <div key={lane.status} className="group/lane flex min-w-0 flex-col gap-2">
              <div className="flex h-8 items-center gap-2 text-label text-muted-foreground uppercase">
                {TICKET_STATUS_LABELS[lane.status]}
                <span className="tabular-nums">{lane.automations.length || ""}</span>
                <button
                  type="button"
                  onClick={() => onCreate(lane.status)}
                  aria-label={`New automation in ${TICKET_STATUS_LABELS[lane.status]}`}
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
              {lane.automations.map((automation) => (
                <MapCard
                  key={automation.id}
                  automation={automation}
                  state={runStateOf(automation.id)}
                  onOpen={() => onOpen(automation.id)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- the spine */

function CollapsedStep({
  step,
  wasOpen,
  onOpen,
}: {
  step: AutomationStep;
  wasOpen: boolean;
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
      aria-current={wasOpen ? "true" : undefined}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-0.5 rounded-lg border bg-card px-3 py-2.5 text-left",
        "transition-[border-color] duration-150 ease-out motion-reduce:transition-none",
        "hover:border-muted-foreground/40",
        "outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        wasOpen ? "border-primary/50" : "border-border",
      )}
    >
      <span className="flex items-baseline gap-1.5 overflow-hidden">
        <HarnessMark harnessId={runtime.harnessId} className="translate-y-0.5" />
        <span className="shrink-0 text-ui text-foreground">
          {harnessLabelFor(runtime.harnessId)}
        </span>
        <span className="truncate font-mono text-label text-muted-foreground">{runtime.model}</span>
        <span className="ml-auto shrink-0 font-mono text-label text-muted-foreground">
          {step.id}
        </span>
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

function ExpandedStep({
  step,
  steps,
  onChange,
  onRename,
  onRemove,
  onCollapse,
}: {
  step: AutomationStep;
  steps: AutomationStep[];
  onChange: (step: AutomationStep) => void;
  onRename: (id: string) => void;
  onRemove: (() => void) | null;
  onCollapse: () => void;
}) {
  const taken = new Set(steps.filter((other) => other.id !== step.id).map((other) => other.id));

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 px-0.5">
        {/* The id is the `## heading` its prose lives under in the file, which
            makes it the one identifier here a person will read outside this UI.
            Hiding it would mean the file has a name for this step that the
            editor never showed you. */}
        <input
          value={step.id}
          onChange={(event) => onRename(event.target.value.trim())}
          aria-label="Step id"
          aria-invalid={taken.has(step.id) || step.id === ""}
          className={cn(
            "min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 font-mono text-label text-muted-foreground",
            "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            "aria-invalid:text-destructive",
          )}
        />
        {onRemove === null ? null : (
          <Button variant="ghost" size="icon-xs" aria-label="Remove step" onClick={onRemove}>
            <TrashIcon />
          </Button>
        )}
        <Button variant="ghost" size="xs" onClick={onCollapse}>
          Done
        </Button>
      </div>
      <StepCard step={step} onChange={onChange} onDuplicate={null} onRemove={null} />
    </div>
  );
}

/**
 * One generation of steps, and its children beneath it.
 *
 * Siblings share a left rail with a tick into each card, which is the whole
 * statement that they start together — a caption saying "at the same time"
 * would be prose doing a job the geometry already does. A lone child gets a
 * plain connector, because a rail bracketing one item brackets nothing.
 */
function StepBranch({
  steps,
  parent,
  openId,
  lastOpenId,
  onOpen,
  onCollapse,
  onChange,
  onRename,
  onRemove,
  onAddAfter,
}: {
  steps: AutomationStep[];
  parent: string | null;
  openId: string | null;
  lastOpenId: string | null;
  onOpen: (id: string) => void;
  onCollapse: () => void;
  onChange: (step: AutomationStep) => void;
  onRename: (from: string, to: string) => void;
  onRemove: (id: string) => void;
  onAddAfter: (parent: string | null) => void;
}) {
  const generation = childrenOf(steps, parent);
  if (generation.length === 0) return null;
  const forked = generation.length > 1;

  return (
    <div className={cn("flex flex-col gap-3", forked && "border-l border-border pl-4")}>
      {generation.map((step) => (
        <div key={step.id} className="relative flex flex-col gap-3">
          {forked ? (
            <span aria-hidden className="absolute top-6 -left-4 w-4 border-t border-border" />
          ) : null}

          {step.id === openId ? (
            <ExpandedStep
              step={step}
              steps={steps}
              onChange={onChange}
              onRename={(to) => onRename(step.id, to)}
              onRemove={steps.length > 1 ? () => onRemove(step.id) : null}
              onCollapse={onCollapse}
            />
          ) : (
            <CollapsedStep
              step={step}
              wasOpen={step.id === lastOpenId}
              onOpen={() => onOpen(step.id)}
            />
          )}

          <StepBranch
            steps={steps}
            parent={step.id}
            openId={openId}
            lastOpenId={lastOpenId}
            onOpen={onOpen}
            onCollapse={onCollapse}
            onChange={onChange}
            onRename={onRename}
            onRemove={onRemove}
            onAddAfter={onAddAfter}
          />

          <AddStep label={`Add a step after ${step.id}`} onClick={() => onAddAfter(step.id)} />
        </div>
      ))}
    </div>
  );
}

/** Reveals on hover or focus. Always-on `+`s outnumber the steps they add to. */
function AddStep({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 self-start rounded px-1 py-0.5 text-label text-muted-foreground",
        "opacity-0 focus-visible:opacity-100 hover:opacity-100 [:hover>&]:opacity-100",
        "transition-[opacity,color] duration-150 ease-out motion-reduce:transition-none",
        "hover:text-primary-text",
        "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
      )}
    >
      <PlusIcon weight="bold" className="size-3" />
      Step
    </button>
  );
}

/* ------------------------------------------------------------ the source */

function Diagnostics({ diagnostics }: { diagnostics: FileDiagnostic[] }) {
  if (diagnostics.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 border-t border-border px-3 py-2">
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

/* ------------------------------------------------------------ the detail */

function DetailView({
  automation,
  onChange,
  onBack,
}: {
  automation: Automation;
  onChange: (automation: Automation) => void;
  onBack: () => void;
}) {
  const [openId, setOpenId] = React.useState<string | null>(automation.steps[0]?.id ?? null);
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

  const lastOpenRef = React.useRef<string | null>(null);
  if (openId !== null) lastOpenRef.current = openId;

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

  function patchSteps(steps: AutomationStep[]) {
    onChange({ ...automation, steps });
  }

  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <Button variant="ghost" size="xs" onClick={onBack}>
            <ArrowLeftIcon />
            Automations
          </Button>
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
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[42rem] flex-col gap-3 p-4">
            <TriggerCard
              trigger={automation.trigger}
              onChange={(trigger) => onChange({ ...automation, trigger })}
            />

            <StepBranch
              steps={automation.steps}
              parent={null}
              openId={openId}
              lastOpenId={lastOpenRef.current === openId ? null : lastOpenRef.current}
              onOpen={setOpenId}
              onCollapse={() => setOpenId(null)}
              onChange={(next) =>
                patchSteps(automation.steps.map((step) => (step.id === next.id ? next : step)))
              }
              onRename={(from, to) => {
                if (to === "") return;
                patchSteps(renameStep(automation.steps, from, to));
                setOpenId((current) => (current === from ? to : current));
              }}
              onRemove={(id) => {
                patchSteps(removeStep(automation.steps, id));
                setOpenId((current) => (current === id ? null : current));
              }}
              onAddAfter={(parent) => {
                const seed = automation.steps.find((step) => step.id === parent);
                const next = blankStep(seed?.runtime.harnessId ?? "claude-code", parent);
                patchSteps([...automation.steps, next]);
                setOpenId(next.id);
              }}
            />

            {/* The trigger's own fork: a step that hangs off nothing runs the
                moment the automation fires, in parallel with its siblings. */}
            <AddStep
              label="Add a step on the trigger"
              onClick={() => {
                const next = blankStep(
                  automation.steps[0]?.runtime.harnessId ?? "claude-code",
                  null,
                );
                patchSteps([...automation.steps, next]);
                setOpenId(next.id);
              }}
            />
          </div>
        </div>
      </div>

      {sourceOpen ? (
        <aside className="flex w-[34rem] min-w-0 shrink-0 flex-col border-l border-border">
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
            <span className="font-mono text-label text-muted-foreground">
              {automationFilePath(automation)}
            </span>
            {errors > 0 ? (
              <span className="ml-auto text-label text-destructive">
                {errors === 1 ? "1 error" : `${errors} errors`}
              </span>
            ) : null}
          </div>
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

export default function AutomationStudioScratch() {
  const [automations, setAutomations] = React.useState<Automation[]>(SEEDED_AUTOMATIONS);
  const [openId, setOpenId] = React.useState<string | null>(null);

  const open = automations.find((automation) => automation.id === openId) ?? null;

  function create(column: TicketStatus | null) {
    const fresh: Automation = {
      id: `atm-new-${automations.length + 1}`,
      scope: "project",
      name: "",
      trigger: { kind: "enters-column", columns: column === null ? [] : [column] },
      steps: [blankStep("claude-code")],
    };
    setAutomations((current) => [...current, fresh]);
    setOpenId(fresh.id);
  }

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      {open === null ? (
        <>
          <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
            <LightningIcon weight="fill" aria-hidden className="size-3.5 text-muted-foreground" />
            <h1 className="text-ui text-foreground">Automations</h1>
            <Button variant="ghost" size="xs" className="ml-auto" onClick={() => create(null)}>
              <PlusIcon />
              New
            </Button>
          </header>
          <MapView automations={automations} onOpen={setOpenId} onCreate={create} />
        </>
      ) : (
        <DetailView
          key={open.id}
          automation={open}
          onChange={(next) =>
            setAutomations((current) =>
              current.map((automation) => (automation.id === next.id ? next : automation)),
            )
          }
          onBack={() => setOpenId(null)}
        />
      )}
    </div>
  );
}
