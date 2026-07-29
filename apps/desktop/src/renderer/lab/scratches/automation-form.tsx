/**
 * Authoring an Automation.
 *
 * ── WHAT THIS REPLACED, AND WHY ───────────────────────────────────────────
 * The previous pass built two layouts side by side — COMPOSER (an Automation is
 * a saved prompt, so author it like one) and SECTIONED (the four-part object
 * should be legible as four parts) — and let the owner pick. He picked
 * sectioned, and then said both were a 6/10. That verdict is the useful part,
 * and it was right for one reason: BOTH layouts treated Trigger and Runtime as
 * settings on a piece of writing, and both were wrong about that.
 *
 * An Automation fires unattended. The prompt decides what a run attempts;
 * the runtime decides what it costs, how long it takes, and whether it stalls
 * forever on an approval prompt nobody is watching. Those are not annotations.
 * So the shape here is a SPINE — one trigger, then one or more steps — and each
 * region is a real card with its own surface instead of a chip in a recessed
 * strip.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ── WHAT THE CATEGORY DOES, AND WHAT WE TOOK ──────────────────────────────
 * Surveyed: Cursor Rules, Lindy, Gumloop, Zapier, n8n, Raycast AI Commands,
 * Warp Workflows, Linear triage rules, Notion database automations, GitHub
 * Actions. Four things came back worth stealing and three worth refusing.
 *
 * TAKEN
 *  • Notion's shape — trigger and action as sibling zones that both grow by the
 *    same "add" affordance — rather than Zapier's trigger-as-privileged-header.
 *  • n8n's trigger geometry: a bolt where the input connector would be, and no
 *    line above the card. The geometry says nothing flows in, so no label has to.
 *  • Zapier's step outline over its own legacy accordion: a list of cards with
 *    no expand/collapse state to design survives step 2, 3 and N.
 *  • Raycast's conditional runtime fields — Reasoning Effort appears only for
 *    models that have it. Here that is `cursor-agent` having no effort flag and
 *    `pi` having no approval mode, and both rows are absent rather than greyed.
 *
 * REFUSED
 *  • The canvas. Lindy and Gumloop put every automation on a pannable node
 *    graph regardless of size, and Gumloop had to build a second object type
 *    (Interfaces) to hide it again. For one trigger and one action in a dense
 *    keyboard app a canvas costs pan, zoom, selection and hit-testing and
 *    returns nothing.
 *  • n8n's model-as-a-sub-node. Elegant on a graph, hostile everywhere else:
 *    "which model does this use" becomes unreadable without following an edge.
 *  • Zapier's forced Setup → Configure → Test tabs. Three tabs per step reads as
 *    thorough and behaves as three clicks and a lost scroll position per edit.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * WHAT IS ACTUALLY BEING TESTED HERE
 *  1. Does the runtime region read as first-class without an "advanced" hatch?
 *  2. Does the trigger picker still read well with five unbuilt kinds in it?
 *  3. Does a two-step automation ("Two-opinion review") look like a natural
 *     extension of a one-step one, or like a different feature?
 *  4. Does the command ribbon do the job a paragraph of description used to?
 *
 * Uses no stores and no bridge — all local state, so nothing here can lie about
 * persistence it doesn't have.
 */
import * as React from "react";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { FolderIcon } from "@phosphor-icons/react/dist/csr/Folder";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { TICKET_STATUS_LABELS, type TicketStatus } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { cn } from "@renderer/lib/utils";

import { HARNESS_ICONS, HarnessTrail, harnessLabelFor } from "../automation/harness-identity";
import { ENTER_CLASS, StepCard } from "../automation/step-card";
import { TriggerCard } from "../automation/trigger-card";
import {
  blankAutomation,
  blankStep,
  defaultRuntime,
  harnessTrail,
  LAB_HARNESS_IDS,
  SEEDED_AUTOMATIONS,
  triggerSummary,
  type Automation,
  type AutomationScope,
  type AutomationStep,
  type LabHarnessId,
  type StepJoin,
} from "../automation/model";

export const title = "Automation · form";
export const note = "Trigger, then steps — real CLI flags per harness (#79/#81/#82)";

/**
 * Never ship a blank name field. Shortcuts doesn't force one, and the documented
 * result is a junk drawer of "Untitled" automations — so a fresh Automation gets
 * a real, editable name the moment it exists, derived from the two things that
 * are already known: where it fires and what it says. It stays live until the
 * author types into the name field themselves.
 */
function suggestName(automation: Automation): string {
  const columns = automation.trigger.kind === "manual" ? [] : automation.trigger.columns;
  const where = columns.length === 1 ? TICKET_STATUS_LABELS[columns[0]] : null;
  const gist = firstLine(automation.steps[0].instructions);
  if (gist === "") return where === null ? "New automation" : `New automation in ${where}`;
  return where === null ? gist : `${gist} in ${where}`;
}

/** The first non-blank line of Instructions, capped — a title, not a quote. */
function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  const trimmed = line.trim();
  return trimmed.length > 48 ? `${trimmed.slice(0, 45)}…` : trimmed;
}

/** Suggested names are worth replacing outright, not editing around. */
function selectOnFocus(event: React.FocusEvent<HTMLInputElement>) {
  event.target.select();
}

let cloneSeq = 0;

function cloneSteps(steps: AutomationStep[], harnessId: LabHarnessId | null): AutomationStep[] {
  return steps.map((step) => {
    cloneSeq += 1;
    return {
      ...step,
      id: `${step.id}-copy-${cloneSeq}`,
      // "Same prompt, different harness" is the one duplication the owner named
      // by name, and it cannot carry the runtime across: model, effort and
      // approval vocabularies are all adapter-local. The prompt survives; the
      // dialect is reset.
      runtime: harnessId === null ? step.runtime : defaultRuntime(harnessId),
    };
  });
}

/* --------------------------------------------------------------------- spine */

/**
 * The line between two cards, and — between steps — the control for what that
 * line MEANS.
 *
 * v1 only ever produces `with`, so this reads as decoration on every automation
 * anyone can currently build. It is here because the two things most likely to
 * be asked for next are both this control: "review it with Codex and with Cursor"
 * is `with`, and "when this is done, do that" is `after`. Finding out now whether
 * a joined pair reads as one automation or as two costs a button.
 */
function Joint({
  join,
  onChange,
}: {
  join: StepJoin | null;
  onChange: ((join: StepJoin) => void) | null;
}) {
  return (
    // A COLUMN: the spine runs vertically and the pill interrupts it. Laid out
    // as a row it renders as two ticks either side of a pill, which reads as a
    // strikethrough rather than as a join.
    <div className="flex flex-col items-center justify-center self-center">
      <span aria-hidden className="h-2.5 w-px bg-border" />
      {join === null || onChange === null ? null : (
        <>
          <button
            type="button"
            onClick={() => onChange(join === "with" ? "after" : "with")}
            className="rounded-full border border-border bg-background px-2 py-0.5 text-label text-muted-foreground transition-colors hover:text-foreground"
          >
            {join === "with" ? "together" : "then"}
          </button>
          <span aria-hidden className="h-2.5 w-px bg-border" />
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------- index */

/**
 * The Automations page's left half: the scope switcher and the list.
 *
 * Both scopes behind one switcher rather than two nav items, because "is this
 * mine or this repo's?" is a property of an automation, not a different place to
 * go. The pair is "This project | Global" — both sides naming a property of the
 * things in the list, not a place — because "All projects" read as "you are
 * looking at every project's automations", which is backwards.
 *
 * The row's context menu is where duplication and re-scoping live, following
 * Gumloop's "⋯ → Move to Team" and Raycast's ⌘D. `Duplicate for →` is a harness
 * submenu rather than a plain copy because the owner's actual case is "the same
 * prompt, run by a different agent", and that is one gesture here instead of
 * copy-then-open-then-repick.
 */
function AutomationIndex({
  automations,
  scope,
  onScopeChange,
  selectedId,
  onSelect,
  onCreate,
  onDuplicate,
  onSetScope,
  onDelete,
}: {
  automations: Automation[];
  scope: AutomationScope;
  onScopeChange: (scope: AutomationScope) => void;
  selectedId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDuplicate: (id: string, harnessId: LabHarnessId | null) => void;
  onSetScope: (id: string, scope: AutomationScope) => void;
  onDelete: (id: string) => void;
}) {
  const visible = automations.filter((automation) => automation.scope === scope);

  return (
    <div className="flex w-64 shrink-0 flex-col gap-2 border-r border-border p-3">
      <div className="flex items-center gap-1 rounded-full bg-muted p-0.5">
        {(["project", "global"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onScopeChange(option)}
            aria-pressed={option === scope}
            className="flex-1 rounded-full px-2 py-0.5 text-xs text-muted-foreground transition-[background-color,color] duration-150 ease-out hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground motion-reduce:transition-none"
          >
            {option === "project" ? "This project" : "Global"}
          </button>
        ))}
      </div>

      {/* Keyed on scope so the rows enter together when the filter changes. */}
      <div key={scope} className={cn("flex flex-col gap-px", ENTER_CLASS)}>
        {visible.map((automation) => (
          <ContextMenu key={automation.id}>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                onClick={() => onSelect(automation.id)}
                aria-current={automation.id === selectedId ? "true" : undefined}
                className="relative flex flex-col gap-0.5 rounded-md py-1.5 pr-2 pl-3 text-left transition-[background-color] duration-150 ease-out hover:bg-accent aria-[current]:bg-accent motion-reduce:transition-none"
              >
                {/* The selection marker is a mounted element rather than a border
                    that switches colour, which is what buys it an entrance: it
                    exists only on the selected row, so `starting:` fires each
                    time selection moves. */}
                {automation.id === selectedId ? (
                  <span
                    aria-hidden
                    className="absolute inset-y-1.5 left-1 w-0.5 rounded-full bg-primary transition-[opacity,transform,translate,scale] duration-200 ease-out starting:scale-y-0 starting:opacity-0 motion-reduce:transition-none motion-reduce:starting:scale-y-100"
                  />
                ) : null}
                <span className="truncate text-ui text-foreground">
                  {automation.name === "" ? "Untitled" : automation.name}
                </span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <HarnessTrail harnessIds={harnessTrail(automation)} />
                  <span className="truncate">{triggerSummary(automation.trigger)}</span>
                </span>
              </button>
            </ContextMenuTrigger>

            <ContextMenuContent className="w-52">
              <ContextMenuItem icon={CopyIcon} onSelect={() => onDuplicate(automation.id, null)}>
                Duplicate
              </ContextMenuItem>
              <ContextMenuSub>
                <ContextMenuSubTrigger icon={CopyIcon}>Duplicate for</ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  {LAB_HARNESS_IDS.map((id) => (
                    <ContextMenuItem
                      key={id}
                      icon={HARNESS_ICONS[id]}
                      onSelect={() => onDuplicate(automation.id, id)}
                    >
                      {harnessLabelFor(id)}
                    </ContextMenuItem>
                  ))}
                </ContextMenuSubContent>
              </ContextMenuSub>
              <ContextMenuSeparator />
              {automation.scope === "project" ? (
                <ContextMenuItem
                  icon={GlobeIcon}
                  onSelect={() => onSetScope(automation.id, "global")}
                >
                  Make global
                </ContextMenuItem>
              ) : (
                <ContextMenuItem
                  icon={FolderIcon}
                  onSelect={() => onSetScope(automation.id, "project")}
                >
                  Move to this project
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem
                icon={TrashIcon}
                variant="destructive"
                onSelect={() => onDelete(automation.id)}
              >
                Delete
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={onCreate}
        className="justify-start text-muted-foreground"
      >
        <PlusIcon />
        New automation
      </Button>
    </div>
  );
}

/**
 * Scope as a field on the form, following Raycast — re-scoping is editing one
 * select, not a migration flow. The index's filter follows it (see `setScope`
 * in the scratch below) so changing this never makes the thing you are editing
 * vanish out of the list beside it.
 */
function ScopePicker({
  scope,
  onChange,
}: {
  scope: AutomationScope;
  onChange: (scope: AutomationScope) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" className="shrink-0 gap-1.5 text-muted-foreground">
          {scope === "global" ? <GlobeIcon weight="fill" /> : <FolderIcon weight="fill" />}
          {scope === "global" ? "Global" : "This project"}
          <CaretDownIcon weight="bold" className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={scope}
          onValueChange={(value) => onChange(value as AutomationScope)}
        >
          <DropdownMenuRadioItem value="project">This project</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="global">Global</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* -------------------------------------------------------------------- scratch */

export default function AutomationFormScratch() {
  const [automations, setAutomations] = React.useState<Automation[]>(SEEDED_AUTOMATIONS);
  const [scope, setScope] = React.useState<AutomationScope>("project");
  const [selectedId, setSelectedId] = React.useState(SEEDED_AUTOMATIONS[0].id);
  // Automations whose name is still the auto-suggestion rather than something
  // the author typed. Seeded automations start out of this set; they have names.
  const [untouchedNameIds, setUntouchedNameIds] = React.useState<Set<string>>(new Set());

  const selected = automations.find((automation) => automation.id === selectedId) ?? automations[0];

  const update = React.useCallback(
    (patch: Partial<Automation>) => {
      // A direct edit to the name field is the one thing that ends the
      // auto-suggestion — from here the author owns the title.
      if ("name" in patch) {
        setUntouchedNameIds((ids) => {
          if (!ids.has(selected.id)) return ids;
          const next = new Set(ids);
          next.delete(selected.id);
          return next;
        });
      }
      setAutomations((current) =>
        current.map((automation) => {
          if (automation.id !== selected.id) return automation;
          const next = { ...automation, ...patch };
          // Anything else changing keeps the name in sync for as long as it is
          // still the auto-suggestion.
          if (!("name" in patch) && untouchedNameIds.has(automation.id)) {
            next.name = suggestName(next);
          }
          return next;
        }),
      );
    },
    [selected.id, untouchedNameIds],
  );

  function patchStep(index: number, step: AutomationStep) {
    update({ steps: selected.steps.map((current, at) => (at === index ? step : current)) });
  }

  function addStep() {
    update({ steps: [...selected.steps, blankStep(selected.steps[0].runtime.harnessId)] });
  }

  function duplicateStep(index: number) {
    const copy = cloneSteps([selected.steps[index]], null)[0];
    update({ steps: selected.steps.toSpliced(index + 1, 0, copy) });
  }

  function removeStep(index: number) {
    update({ steps: selected.steps.filter((_, at) => at !== index) });
  }

  function create() {
    // Trigger arrives pre-specified where possible — Notion puts "new
    // automation" in the database toolbar, so the trigger is half-filled before
    // the form opens. This lab has no board to invoke it FROM, so it models the
    // same entry point: the button behaves as though it were clicked from Todo.
    const enteredFromColumn: TicketStatus = "todo";
    const fresh: Automation = {
      ...blankAutomation(scope, enteredFromColumn),
      id: `atm-${automations.length + 1}`,
    };
    fresh.name = suggestName(fresh);
    setUntouchedNameIds((ids) => new Set(ids).add(fresh.id));
    setAutomations((current) => [...current, fresh]);
    setSelectedId(fresh.id);
  }

  function duplicate(id: string, harnessId: LabHarnessId | null) {
    const source = automations.find((automation) => automation.id === id);
    if (source === undefined) return;
    cloneSeq += 1;
    const copy: Automation = {
      ...source,
      id: `${id}-copy-${cloneSeq}`,
      name:
        harnessId === null
          ? `${source.name} copy`
          : `${source.name} · ${harnessLabelFor(harnessId)}`,
      steps: cloneSteps(source.steps, harnessId),
    };
    setAutomations((current) => [...current, copy]);
    setSelectedId(copy.id);
  }

  function setAutomationScope(id: string, next: AutomationScope) {
    setAutomations((current) =>
      current.map((automation) =>
        automation.id === id ? { ...automation, scope: next } : automation,
      ),
    );
    // Follow it, so re-scoping the thing you are editing doesn't drop you onto a
    // different automation.
    setScope(next);
  }

  function remove(id: string) {
    const remaining = automations.filter((automation) => automation.id !== id);
    setAutomations(remaining);
    if (id !== selectedId) return;
    const fallback = remaining.find((automation) => automation.scope === scope) ?? remaining[0];
    if (fallback !== undefined) setSelectedId(fallback.id);
  }

  function changeScopeFilter(next: AutomationScope) {
    setScope(next);
    const first = automations.find((automation) => automation.scope === next);
    if (first !== undefined) setSelectedId(first.id);
  }

  return (
    <div className="flex overflow-hidden rounded-xl border border-border bg-background">
      <AutomationIndex
        automations={automations}
        scope={scope}
        onScopeChange={changeScopeFilter}
        selectedId={selected.id}
        onSelect={setSelectedId}
        onCreate={create}
        onDuplicate={duplicate}
        onSetScope={setAutomationScope}
        onDelete={remove}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-0 p-5">
        <div className="flex items-center gap-2 pb-3">
          <input
            value={selected.name}
            onChange={(event) => update({ name: event.target.value })}
            onFocus={selectOnFocus}
            placeholder="Automation name"
            aria-label="Automation name"
            className="min-w-0 flex-1 border-none bg-transparent text-heading font-medium text-foreground outline-none placeholder:text-muted-foreground"
          />
          <ScopePicker
            scope={selected.scope}
            onChange={(next) => setAutomationScope(selected.id, next)}
          />
        </div>

        <TriggerCard trigger={selected.trigger} onChange={(trigger) => update({ trigger })} />

        {selected.steps.map((step, index) => (
          <React.Fragment key={step.id}>
            <Joint
              join={index === 0 ? null : step.join}
              onChange={
                index === 0 ? null : (join) => patchStep(index, { ...selected.steps[index], join })
              }
            />
            <StepCard
              step={step}
              onChange={(next) => patchStep(index, next)}
              onDuplicate={selected.steps.length > 1 ? () => duplicateStep(index) : null}
              onRemove={selected.steps.length > 1 ? () => removeStep(index) : null}
            />
          </React.Fragment>
        ))}

        <Joint join={null} onChange={null} />
        <Button
          variant="ghost"
          size="sm"
          onClick={addStep}
          className="w-fit self-center border border-dashed border-border text-muted-foreground"
        >
          <PlusIcon />
          Add step
        </Button>
      </div>
    </div>
  );
}
