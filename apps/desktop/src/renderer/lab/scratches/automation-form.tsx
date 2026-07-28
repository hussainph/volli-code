/**
 * Authoring an Automation — the surface the plan left as an open question
 * ("The Automations page layout — same, better designed than debated").
 *
 * Two layouts are built side by side rather than argued about, because the
 * disagreement is about emphasis and emphasis is only visible at size:
 *
 *   • COMPOSER re-uses the shape the New-ticket composer already ships: one
 *     title, one dominant body, one quiet chip row underneath. Its claim is that
 *     an Automation IS a saved prompt, so it should be authored like one — and
 *     that Trigger and Runtime are settings on a piece of writing, not four
 *     co-equal things.
 *   • SECTIONED gives Trigger · Instructions · Runtime · Outcome a heading each.
 *     Its claim is that #79's four-part object should be legible as four parts,
 *     especially to someone editing a seeded Automation they didn't write.
 *
 * Both render the SAME state and the same controls, so switching is a pure
 * emphasis comparison. Judge them on a seeded automation (pick "Code review" —
 * it is the one whose Instructions demote the body, so it stresses the layout
 * most), then on a blank one via New.
 *
 * WHAT CHANGED AFTER THE FIRST CRITIQUE. The first pass drew all four parts at
 * the same weight and shipped a separate "what gets sent" preview panel. Both
 * were the same mistake in different clothes: an Automation is a piece of
 * WRITING, and the form was treating the writing as one field among four while
 * outsourcing the job of showing what the writing means to a panel below it.
 * So the preview is gone — {@link ChipEditor} paints chips and commands in
 * place, which is what the preview was standing in for — and Instructions now
 * owns the surface in both layouts while Trigger/Runtime/Outcome sit in a quiet
 * settings strip. Even in SECTIONED, which exists to argue for four visible
 * parts, "four parts" now means four labelled parts, not four equal ones; the
 * reading order is unchanged so the layouts still differ only in emphasis.
 *
 * What this scratch is genuinely testing, beneath the layout:
 *   1. Does the seeded template read like something a person wrote (#88)?
 *   2. Does the effort dial's ABSENCE on opencode read as correct rather than
 *      broken (#81)? Switch the harness to opencode and watch it go.
 *   3. Do the `/` command tiers explain themselves without a legend (#82)?
 *   4. Is Outcome's presence-but-emptiness honest, or just confusing (#84)?
 *
 * Uses no stores and no bridge — all local state, so nothing here can lie about
 * persistence it doesn't have.
 */
import * as React from "react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import {
  HARNESS_IDS,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  type HarnessId,
  type TicketStatus,
} from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { cn } from "@renderer/lib/utils";

import { ChipEditor, type ChipEditorHandle } from "../automation/chip-editor";
import { HarnessTag } from "../automation/harness-identity";
import {
  blankAutomation,
  CONTEXT_CHIPS,
  HARNESS_ADAPTERS,
  SEEDED_AUTOMATIONS,
  SLASH_COMMANDS,
  tokenizeInstructions,
  type Automation,
  type AutomationScope,
} from "../automation/model";

export const title = "Automation · form";
export const note = "Authoring one Automation — two layouts, same state (#79/#81/#82)";

type Layout = "composer" | "sectioned";

/** The demo project. Named once so the scope switcher and its footnote agree. */
const PROJECT_NAME = "Voltaic";

/**
 * The chip row's idiom, lifted from `composer-chips.tsx`. `w-fit` is the one
 * addition: the sectioned layout stacks its fields in a flex column, which
 * stretches a pill to the full width of the form and stops it reading as a chip.
 */
function chipClass() {
  return "w-fit gap-1.5 border border-border px-2.5 text-xs text-muted-foreground";
}

/**
 * The house entrance transition, in one place because it is used on three
 * different state changes and they should not drift apart. It only fires on
 * mount, so every caller earns it by keying the element on the state that
 * changed — which is also what stops it firing while you type.
 *
 * The transform is what `motion-reduce` drops; the fade stays, because a
 * cross-fade is not the kind of motion that causes trouble and losing it would
 * make the change of state read as a flicker instead.
 */
const ENTER_CLASS =
  "transition-[opacity,transform,translate,scale] duration-200 ease-out starting:opacity-0 motion-reduce:transition-none";

function scopeSummary(columnScope: Automation["columnScope"]): string {
  if (columnScope === "any") return "Any column";
  if (columnScope.length === 0) return "No columns";
  if (columnScope.length === 1) return TICKET_STATUS_LABELS[columnScope[0]];
  return `${columnScope.length} columns`;
}

/* ------------------------------------------------------------------ controls */

/**
 * Which columns this Automation is OFFERED in — not where it fires. Firing is
 * arming, which lives on the column (#80), and the distinction is the single
 * most confusable thing on this form: a user who reads this as "runs here" will
 * expect a drop to start work and be wrong. Hence the explicit footnote rather
 * than a tooltip.
 */
function TriggerControl({
  columnScope,
  onChange,
}: {
  columnScope: Automation["columnScope"];
  onChange: (columnScope: Automation["columnScope"]) => void;
}) {
  const selected = columnScope === "any" ? [] : columnScope;

  function toggle(status: TicketStatus, checked: boolean) {
    const next = checked ? [...selected, status] : selected.filter((item) => item !== status);
    onChange(next.length === TICKET_STATUSES.length ? "any" : next);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className={chipClass()}>
          {scopeSummary(columnScope)}
          <CaretDownIcon weight="bold" className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Offered in</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onChange("any")}>
          Any column
          {columnScope === "any" ? <CheckIcon weight="bold" className="ml-auto size-3.5" /> : null}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {TICKET_STATUSES.map((status) => (
          <DropdownMenuCheckboxItem
            key={status}
            checked={columnScope === "any" || selected.includes(status)}
            onCheckedChange={(checked) => toggle(status, checked)}
            onSelect={(event) => event.preventDefault()}
          >
            {TICKET_STATUS_LABELS[status]}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Harness · model · effort (#81).
 *
 * The model control is an INPUT with suggestions, never a closed enum — model
 * names churn far faster than app releases, and a picker that can't express
 * this week's slug is a picker you route around. The effort control renders only
 * when the adapter declares a scale; opencode declares none, and the correct
 * behaviour is for the dial to be absent rather than disabled, because there is
 * nothing there to enable.
 *
 * The harness is the one field here that is a category rather than a value, so
 * it carries its mark ({@link HarnessTag}) instead of being a fourth run of grey
 * words — this row is otherwise all grey words, and which agent runs is the part
 * you should be able to check without reading.
 */
function RuntimeControl({
  automation,
  onChange,
  layout,
}: {
  automation: Automation;
  onChange: (runtime: Automation["runtime"]) => void;
  layout: Layout;
}) {
  const { runtime } = automation;
  const adapter = HARNESS_ADAPTERS[runtime.harnessId];
  const [modelOpen, setModelOpen] = React.useState(false);

  function pickHarness(harnessId: HarnessId) {
    const next = HARNESS_ADAPTERS[harnessId];
    // Switching harness cannot carry the old model or effort across — they are
    // expressed in the previous adapter's dialect. Resetting to that adapter's
    // own first suggestion is the only honest move; the plan's answer to
    // "same prompt, different model" is duplication, not a cross-harness field.
    onChange({
      harnessId,
      model: next.models[0],
      effort: next.effortScale.length > 0 ? next.effortScale[0] : null,
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className={chipClass()}>
            <HarnessTag harnessId={runtime.harnessId} />
            <CaretDownIcon weight="bold" className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup
            value={runtime.harnessId}
            onValueChange={(value) => pickHarness(value as HarnessId)}
          >
            {HARNESS_IDS.map((id) => (
              <DropdownMenuRadioItem key={id} value={id}>
                <HarnessTag harnessId={id} muted={false} />
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Combobox, not a select: the suggestion list is a shortcut, the text is the truth. */}
      <div className="relative">
        <input
          value={runtime.model}
          onChange={(event) => onChange({ ...runtime, model: event.target.value })}
          onFocus={() => setModelOpen(true)}
          // Blur is deferred a frame so a click on a suggestion lands before the
          // list unmounts underneath the pointer.
          onBlur={() => window.setTimeout(() => setModelOpen(false), 120)}
          spellCheck={false}
          aria-label="Model"
          className="h-5 w-56 rounded-full border border-border bg-transparent px-2.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring"
        />
        {modelOpen ? (
          <ul className="absolute top-6 left-0 z-20 w-56 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-md">
            {adapter.models.map((model) => (
              <li key={model}>
                <button
                  type="button"
                  onMouseDown={() => onChange({ ...runtime, model })}
                  className="w-full px-2.5 py-1 text-left font-mono text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {model}
                </button>
              </li>
            ))}
            <li className="border-t border-border px-2.5 pt-1 pb-0.5 text-xs text-muted-foreground">
              or type any slug
            </li>
          </ul>
        ) : null}
      </div>

      {adapter.effortScale.length > 0 ? (
        <div className="flex items-center gap-1 rounded-full border border-border px-1 py-0.5">
          {adapter.effortScale.map((stop) => (
            <button
              key={stop}
              type="button"
              onClick={() => onChange({ ...runtime, effort: stop })}
              aria-pressed={runtime.effort === stop}
              className="rounded-full px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
            >
              {stop}
            </button>
          ))}
        </div>
      ) : null}

      {/* The dialect note is the part that keeps the row honest — without it the
          three stops above look like a portable scale, which is exactly the
          normalised cross-harness enum #81 rejected. Keyed on the harness so it
          fades in rather than swapping mid-sentence when the harness changes. */}
      <span
        key={runtime.harnessId}
        className={cn(
          "text-xs text-muted-foreground",
          ENTER_CLASS,
          layout === "composer" && "w-full",
        )}
      >
        {adapter.effortNote}
      </span>
    </div>
  );
}

/**
 * The Instructions editor: {@link ChipEditor} plus the two insert affordances.
 *
 * There is no preview panel any more and no "show what gets sent" toggle. The
 * editor paints chips and commands where they sit, so a second rendering of the
 * same text below it would be showing the same thing twice — and a toggle that
 * reveals what the field means is an admission the field does not.
 *
 * What survives from the preview is the one thing the paint layer states quietly
 * rather than says: a command this harness does not know is underlined, not
 * explained. That underline is deliberately cheap (#82 — never blocked, only
 * marked), so the count gets one line underneath, and only when there is
 * something to count.
 *
 * The command list still opens from a button rather than on typing `/`. The real
 * picker is `/`-triggered; what is being judged here is the TIER structure —
 * that a compiled-in `/code-review` and a scanned `/tdd` are both offered and
 * visibly different in origin — and that survives the cheaper trigger.
 *
 * `heightClass` rather than `rows`: the editor is two stacked layers inside a
 * bordered box, so its height is the box's, not a textarea attribute's. Callers
 * still make the same call they used to — how much room does this layout give
 * the writing — they just make it in the units the box understands.
 */
function InstructionsEditor({
  automation,
  onChange,
  heightClass,
}: {
  automation: Automation;
  onChange: (instructions: string) => void;
  heightClass: string;
}) {
  const editorRef = React.useRef<ChipEditorHandle>(null);
  const harnessId = automation.runtime.harnessId;
  const commands = SLASH_COMMANDS[harnessId];
  const unverified = tokenizeInstructions(automation.instructions, harnessId).filter(
    (token) => token.kind === "command" && !token.known,
  ).length;

  function insert(snippet: string) {
    editorRef.current?.insert(snippet);
  }

  return (
    <div className="flex flex-col gap-2">
      <ChipEditor
        ref={editorRef}
        value={automation.instructions}
        onChange={onChange}
        harnessId={harnessId}
        placeholder="What should the agent do?"
        // A min and a max, never a fixed height: the editor grows with what you
        // write and then scrolls inside itself rather than pushing the settings
        // strip off the page — the same bounded-growth rule the New-ticket
        // composer's body already follows.
        className={heightClass}
      />

      <div className="flex flex-wrap items-center gap-1.5">
        {CONTEXT_CHIPS.map((chip) => (
          <button
            key={chip.token}
            type="button"
            title={`Resolves to ${chip.resolves}`}
            onClick={() => insert(`{{${chip.token}}}`)}
            className="rounded-full border border-dashed border-border px-2 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:border-solid hover:text-foreground"
          >
            {chip.label}
          </button>
        ))}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="xs" className="text-muted-foreground">
              /<span>Command</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuLabel className="flex items-center gap-1">
              Built in to <HarnessTag harnessId={harnessId} muted={false} />
            </DropdownMenuLabel>
            {commands
              .filter((command) => command.tier === "builtin")
              .map((command) => (
                <DropdownMenuItem
                  key={command.name}
                  onSelect={() => insert(command.name)}
                  className="justify-between gap-6"
                >
                  <span className="font-mono">{command.name}</span>
                  <span className="text-xs text-muted-foreground">{command.detail}</span>
                </DropdownMenuItem>
              ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Found in this project</DropdownMenuLabel>
            {commands
              .filter((command) => command.tier === "scanned")
              .map((command) => (
                <DropdownMenuItem
                  key={command.name}
                  onSelect={() => insert(command.name)}
                  className="justify-between gap-6"
                >
                  <span className="font-mono">{command.name}</span>
                  <span className="text-xs text-muted-foreground">{command.detail}</span>
                </DropdownMenuItem>
              ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="font-normal text-muted-foreground">
              Anything else you type is kept, and marked unverified.
            </DropdownMenuLabel>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Last, not between the editor and its toolbar: appearing and disappearing
          as you type must not shift the buttons you are aiming at. */}
      {unverified > 0 ? (
        <p className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", ENTER_CLASS)}>
          <WarningIcon className="size-3.5 shrink-0" />
          {unverified === 1 ? "1 command isn't" : `${unverified} commands aren't`} one{" "}
          {HARNESS_ADAPTERS[harnessId].label} knows. Sent as written.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Outcome — present, named, and deliberately empty (#84).
 *
 * v1 asserts launch only, so this is the one part of the four-part object with
 * nothing behind it. #79 says the object HAS four parts, and a form that
 * silently ships three teaches the wrong shape to everyone who learns the
 * feature from the UI — so it stays.
 *
 * The first version drew it as a dashed, greyed-out pill, which is the visual
 * language of a control that is temporarily unavailable: it read as broken, the
 * exact risk #84 names. So it is drawn as a stated VALUE instead — solid, in
 * foreground text, the way any other chosen setting looks — and the sentence
 * underneath gives the reason rather than an apology. "Nothing" is an answer
 * here, not an absence, and it should look like one.
 */
function OutcomeControl() {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex w-fit items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs text-foreground">
        Nothing — the session is the report
      </span>
      <span className="text-xs text-muted-foreground">
        The answer for v1, not a gap: moving a ticket when a Run finishes needs completion
        detection, and a wrong guess moves your work for you. Tickets leave Doing because you move
        them.
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------- layouts */

/**
 * The settings idiom, shared by both layouts: everything that is not the writing
 * sits inside one recessed panel. It is the layout doing the argument — a
 * bordered `bg-muted` strip reads as chrome ON something, where a bare stack of
 * equally-weighted fields reads as four peers.
 */
function SettingsStrip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col rounded-lg border border-border bg-muted/30 px-3 py-2">
      {children}
    </div>
  );
}

/** A labelled row inside a {@link SettingsStrip}. Label left, control right, so
 *  the labels form one scannable column instead of interrupting the controls. */
function QuietField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 border-b border-border/60 py-2 first:pt-0 last:border-b-0 last:pb-0">
      <h3 className="w-16 shrink-0 pt-1 font-mono text-label uppercase text-muted-foreground">
        {label}
      </h3>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">{children}</div>
    </div>
  );
}

function ComposerLayout({
  automation,
  update,
}: {
  automation: Automation;
  update: (patch: Partial<Automation>) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <input
        value={automation.name}
        onChange={(event) => update({ name: event.target.value })}
        placeholder="Automation name"
        aria-label="Automation name"
        className="w-full border-none bg-transparent text-title font-medium text-foreground outline-none placeholder:text-muted-foreground"
      />

      {/* No label above the editor. The composer's whole claim is that the
          writing is the object rather than a field on it, and a field label
          would be the first thing to contradict that. */}
      <InstructionsEditor
        automation={automation}
        onChange={(instructions) => update({ instructions })}
        heightClass="min-h-[320px] max-h-[52vh]"
      />

      {/* One recessed strip for everything that is not the writing — the
          composer's claim in a single block of layout. */}
      <SettingsStrip>
        <div className="flex flex-wrap items-center gap-2 py-1">
          <TriggerControl
            columnScope={automation.columnScope}
            onChange={(columnScope) => update({ columnScope })}
          />
          <RuntimeControl
            automation={automation}
            onChange={(runtime) => update({ runtime })}
            layout="composer"
          />
        </div>
        <p className="pb-1 text-xs text-muted-foreground">
          Offered in {scopeSummary(automation.columnScope)}. It only runs on its own where a column
          is armed with it.
        </p>
      </SettingsStrip>
    </div>
  );
}

/**
 * Four labelled parts — but not four equal ones, which is the correction the
 * critique forced. The reading order Trigger → Instructions → Runtime → Outcome
 * is preserved exactly, so this is still the same argument as before; what
 * changed is that the writing is the only thing on a raised surface and the
 * other three bracket it as recessed settings. If four EQUAL parts turns out to
 * be the thing worth testing, it is this component that has to change back.
 */
function SectionedLayout({
  automation,
  update,
}: {
  automation: Automation;
  update: (patch: Partial<Automation>) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <input
        value={automation.name}
        onChange={(event) => update({ name: event.target.value })}
        placeholder="Automation name"
        aria-label="Automation name"
        className="w-full border-none bg-transparent text-heading font-medium text-foreground outline-none placeholder:text-muted-foreground"
      />

      <SettingsStrip>
        <QuietField label="Trigger">
          <TriggerControl
            columnScope={automation.columnScope}
            onChange={(columnScope) => update({ columnScope })}
          />
          <span className="text-xs text-muted-foreground">
            Where this Automation is offered. It only runs on its own where a column is armed with
            it.
          </span>
        </QuietField>
      </SettingsStrip>

      {/* The hero. Its heading is the one on this page in body weight rather than
          a mono all-caps field label, because it is naming the substance, not a
          setting — and the strips above and below keep their small labels so the
          difference is unmistakable. */}
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <h3 className="text-ui font-medium text-foreground">Instructions</h3>
          <span className="text-xs text-muted-foreground">What the agent is asked to do.</span>
        </div>
        <InstructionsEditor
          automation={automation}
          onChange={(instructions) => update({ instructions })}
          heightClass="min-h-[260px] max-h-[44vh]"
        />
      </div>

      <SettingsStrip>
        <QuietField label="Runtime">
          <RuntimeControl
            automation={automation}
            onChange={(runtime) => update({ runtime })}
            layout="sectioned"
          />
        </QuietField>
        <QuietField label="Outcome">
          <OutcomeControl />
        </QuietField>
      </SettingsStrip>
    </div>
  );
}

/* --------------------------------------------------------------------- index */

/**
 * The Automations page's left half: the scope switcher (#86a) and the list.
 *
 * Both scopes behind one switcher rather than two nav items, because "is this
 * mine or this repo's?" is a property of an automation, not a different place
 * to go. The seeded set arrives here unarmed (#88) — editing beats authoring
 * from scratch, so the list is never empty on a first launch.
 *
 * The switcher used to read "Voltaic | All projects", which was a lie in two
 * words: global scope means an Automation is AVAILABLE IN every project, not
 * that you are looking at every project's automations at once. The pair is now
 * "This project | Global" — both sides naming a property of the things in the
 * list — and a line underneath says which set you are looking at, because a
 * two-word toggle cannot carry a distinction this easy to get backwards.
 */
function AutomationIndex({
  automations,
  scope,
  onScopeChange,
  selectedId,
  onSelect,
  onCreate,
}: {
  automations: Automation[];
  scope: AutomationScope;
  onScopeChange: (scope: AutomationScope) => void;
  selectedId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  const visible = automations.filter((automation) => automation.scope === scope);

  return (
    <div className="flex w-60 shrink-0 flex-col gap-2 border-r border-border p-3">
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

      {/* Keyed on scope so the whole set — the sentence and the rows it describes
          — enters together. Two elements changing at two different times would
          read as the list lagging the switch. */}
      <div key={scope} className={cn("flex flex-col gap-2", ENTER_CLASS)}>
        <p className="px-1 text-xs text-muted-foreground">
          {scope === "project"
            ? `Offered in ${PROJECT_NAME} only.`
            : "Offered in every project, including ones you haven't opened."}
        </p>

        <div className="flex flex-col gap-px">
          {visible.map((automation) => (
            <button
              key={automation.id}
              type="button"
              onClick={() => onSelect(automation.id)}
              aria-current={automation.id === selectedId ? "true" : undefined}
              className="relative flex flex-col gap-0.5 rounded-md py-1.5 pr-2 pl-3 text-left transition-[background-color] duration-150 ease-out hover:bg-accent aria-[current]:bg-accent motion-reduce:transition-none"
            >
              {/* The selection marker is a mounted element rather than a border
                  that switches colour, which is what buys it an entrance: it
                  exists only on the selected row, so `starting:` fires each time
                  selection moves. */}
              {automation.id === selectedId ? (
                <span
                  aria-hidden
                  className="absolute inset-y-1.5 left-1 w-0.5 rounded-full bg-primary transition-[opacity,transform,translate,scale] duration-200 ease-out starting:scale-y-0 starting:opacity-0 motion-reduce:transition-none motion-reduce:starting:scale-y-100"
                />
              ) : null}
              <span className="text-ui text-foreground">
                {automation.name === "" ? "Untitled" : automation.name}
              </span>
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                {scopeSummary(automation.columnScope)} ·
                <HarnessTag harnessId={automation.runtime.harnessId} />
              </span>
            </button>
          ))}
        </div>
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

/* -------------------------------------------------------------------- scratch */

export default function AutomationFormScratch() {
  const [automations, setAutomations] = React.useState<Automation[]>(SEEDED_AUTOMATIONS);
  const [scope, setScope] = React.useState<AutomationScope>("project");
  const [selectedId, setSelectedId] = React.useState(SEEDED_AUTOMATIONS[0].id);
  const [layout, setLayout] = React.useState<Layout>("composer");

  const selected = automations.find((automation) => automation.id === selectedId) ?? automations[0];

  const update = React.useCallback(
    (patch: Partial<Automation>) => {
      setAutomations((current) =>
        current.map((automation) =>
          automation.id === selected.id ? { ...automation, ...patch } : automation,
        ),
      );
    },
    [selected.id],
  );

  function create() {
    const fresh = { ...blankAutomation(scope), id: `atm-${automations.length + 1}` };
    setAutomations((current) => [...current, fresh]);
    setSelectedId(fresh.id);
  }

  function changeScope(next: AutomationScope) {
    setScope(next);
    const first = automations.find((automation) => automation.scope === next);
    if (first !== undefined) setSelectedId(first.id);
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Lab-only control. Deliberately outside the framed page below so it can
          never be mistaken for a product affordance. */}
      <div className="flex items-center gap-2">
        <span className="font-mono text-label uppercase text-muted-foreground">Layout</span>
        {(["composer", "sectioned"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setLayout(option)}
            aria-pressed={option === layout}
            className="rounded-full px-2.5 py-0.5 text-label text-muted-foreground transition-[background-color,color] duration-150 ease-out hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground motion-reduce:transition-none"
          >
            {option === "composer" ? "Composer" : "Sectioned"}
          </button>
        ))}
      </div>

      <div className="flex overflow-hidden rounded-xl border border-border bg-background">
        <AutomationIndex
          automations={automations}
          scope={scope}
          onScopeChange={changeScope}
          selectedId={selected.id}
          onSelect={setSelectedId}
          onCreate={create}
        />
        {/* Keyed on layout: the two layouts are the comparison this scratch
            exists for, and a hard swap makes them harder to tell apart than a
            settle does. Deliberately NOT keyed on the selected automation —
            re-entering the form on every click would animate the wrong thing. */}
        <div
          key={layout}
          className={cn("min-w-0 flex-1 p-5", ENTER_CLASS, "starting:translate-y-1")}
        >
          {layout === "composer" ? (
            <ComposerLayout automation={selected} update={update} />
          ) : (
            <SectionedLayout automation={selected} update={update} />
          )}
        </div>
      </div>

      {/* The composer layout has no Outcome section; it belongs somewhere, and
          where it goes is part of what is being judged. Parked below the frame
          so the comparison above stays clean. */}
      {layout === "composer" ? (
        <div className="rounded-xl border border-dashed border-border p-4">
          <h3 className="pb-2 font-mono text-label uppercase text-muted-foreground">
            Outcome — homeless in this layout
          </h3>
          <OutcomeControl />
        </div>
      ) : null}
    </div>
  );
}
