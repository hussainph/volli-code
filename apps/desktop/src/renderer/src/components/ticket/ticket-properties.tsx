/**
 * The Now page's Properties block — status, priority and labels — as a SECTION
 * (VC-406): a `PROPERTIES` eyebrow over three compact rows, the same object the
 * Sessions and Automations blocks under it are.
 *
 * It was a wrapping run of 24px pills with no eyebrow, and that run was the
 * one block on the page that was neither of its two object kinds: unmarked,
 * bordered at rest where every row is borderless until hovered, and two facts
 * to a line where the page sets one thing per line. Alone it read as Linear's
 * property strip; under the sections it was the odd block out.
 *
 * **THE VALUE IS THE CONTROL** (revision 05's first correction). The second
 * pass made the whole row the target and hung a picker off it, which is the
 * shape the user rejected: a row that opens a side overlay is a row pretending
 * to be a field, and it puts the act one hop further away than the fact it is
 * editing. A row here is NOT a target. It keeps the roster's grammar — a
 * glyph, then the value — and the value itself is the app's own 28px dropdown
 * trigger (`RAIL_CONTROL`, the recipe every button a rail page presses wears,
 * over the app's `DropdownMenu`). Nothing here is a native `<select>`: the
 * fixture used one as a stand-in and said so.
 *
 * **NO FIELD CAPTIONS.** The rows used to trail `Status`, `Priority` and
 * `Labels` in the muted ink at the right edge. The glyph at the left already
 * says which field the line is and the value says the rest, so the word was a
 * third naming of the same thing, spending rail width on it — the page's own
 * rule that a row's right edge says one thing, applied to a right edge with
 * nothing left to say. The field name is not lost and was never only visual:
 * it rides each control's accessible name (`Status: Todo`, and the run's
 * `Labels: …` group), which is where a screen reader was already getting it.
 * The leading glyph is `aria-hidden` so it does not name the same field a
 * second time beside the control that names it.
 *
 * The rows are 38px (28px trigger + 4px above and below + the row's 1px
 * transparent border) rather than the 36px of the page's other one-line rows —
 * the retained difference revision 05 records so it is not mistaken for drift.
 *
 * **LABELS ARE ADDITIVE, LEFT TO RIGHT.** Each applied label is its own pill
 * carrying its own Remove, in the order it was added, wrapping when the run
 * outgrows the rail; one Add control at the end of the run — a bare `+`, named
 * for the two readers who cannot see it — offers what is NOT yet applied. This
 * replaces the single
 * toggle picker the whole row used to open: a toggle list makes "take this one
 * off" a round trip through a popover, and it re-sorted nothing, so the only
 * thing it gave up was the ability to see and remove a label in one place.
 * Removal keeps the hand on the run — focus lands on the pill that slid into
 * the removed one's place, else on Add.
 *
 * The vocabulary is the PROJECT's (`useLabelVocabulary`: its label rows plus
 * every name in use on its tickets) with its stored colours, and the create
 * row is the picker's own rule (`newLabelFromQuery`) so a name that differs
 * only in case is offered to apply rather than minted a second time. No
 * fixture labels, colours or vocabulary reach this file.
 *
 * Every edit writes through the board store's existing actions — `moveTicket`,
 * `setTicketPriority`, `setLabels` — so the optimistic patch, the rollback and
 * the failure toast are the ones the board card and the context menu already
 * get, and a status change still has the board's own side effects (the column
 * move, and with it whichever Automation the new column arms).
 *
 * Worktree identity (branch, base branch, path) and the done flow are NOT here:
 * they are repository facts, and they live in the rail's worktree footer
 * (`ticket-repository-summary.tsx`).
 *
 * RETIRED, deliberately: the old page closed with a `Created …` / `Updated …`
 * pair under a rule (`formatTimestamp`, since deleted). The Calm Stack has no
 * such line, and the two facts are not lost — the Activity feed carries a
 * durable "created the ticket" event with its own stamp, and its most recent
 * entry is a truer answer to "when did this last move" than a derived
 * `updatedAt` that a label edit also bumps. `formatStamp` itself survives in
 * `lib/relative-time` for the Archive.
 */
import * as React from "react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CircleIcon } from "@phosphor-icons/react/dist/csr/Circle";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TagIcon } from "@phosphor-icons/react/dist/csr/Tag";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import {
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  type Ticket,
  type TicketPriority,
  type TicketStatus,
} from "@volli/shared";

import { PriorityIndicator } from "@renderer/components/board/priority-indicator";
import {
  labelPickerOptions,
  newLabelFromQuery,
} from "@renderer/components/ticket/label-picker-model";
import { guardWrite, useCanWrite } from "@renderer/components/hosts/use-hosts";
import { useLabelVocabulary } from "@renderer/components/ticket/label-picker";
import {
  RAIL_CONTROL,
  RAIL_PANEL_INSET,
  RailSectionHeadingRow,
} from "@renderer/components/ticket/rail-panel-parts";
import { Button } from "@renderer/components/ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "@renderer/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { resolveLabelColor } from "@renderer/lib/labels";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";

/**
 * One property row. Not a `ListRow`: a `ListRow` is either a target or inert,
 * and this row is neither — it is a line of the page that HOLDS a target. The
 * geometry is the row's (the same `px-2`, the same transparent border that
 * keeps every row's text on one left edge), without the hover fill that would
 * promise a press the row does not answer.
 */
function PropertyRow({
  glyph,
  control,
  align = "center",
  ...rest
}: React.HTMLAttributes<HTMLLIElement> & {
  glyph: React.ReactNode;
  control: React.ReactNode;
  /** `start` for the labels row, whose run wraps to several lines. */
  align?: "center" | "start";
}) {
  return (
    <li
      className={cn(
        "flex w-full gap-2 rounded-lg border border-transparent px-2 py-1",
        align === "center" ? "items-center" : "items-start",
      )}
      {...rest}
    >
      <span
        // Decorative: the control beside it carries the field in its own
        // accessible name, and `PriorityIndicator` is a labelled `img` that
        // would otherwise say "Priority: Medium" twice on one line.
        aria-hidden
        className={cn(
          "flex size-4 shrink-0 items-center justify-center text-muted-foreground",
          // The trigger is 28px and the glyph is 16px: centring it on the
          // control's own line rather than on the row keeps the mark level with
          // the value at both alignments.
          align === "center" ? "self-center" : "mt-1",
        )}
      >
        {glyph}
      </span>
      <span className={cn("flex min-w-0 flex-1", align === "start" && "flex-wrap")}>{control}</span>
    </li>
  );
}

/**
 * The value, as the app's compact dropdown trigger — 28px, sized to its own
 * label, never stretched across the column (docs/DESIGN.md, "Every act wears
 * one costume").
 */
function ValueTrigger({
  label,
  field,
  value,
  canWrite,
  children,
}: {
  label: string;
  field: string;
  value: string;
  /** Read-only (VC-576): the value still reads; the menu does not open. */
  canWrite: boolean;
  children?: React.ReactNode;
}) {
  return (
    <DropdownMenuTrigger asChild>
      <Button
        variant="outline"
        disabled={!canWrite}
        className={cn(RAIL_CONTROL, "max-w-full justify-start gap-1.5 pr-2 pl-2.5 font-normal")}
        // The field is in the accessible name because nothing beside the
        // control says it any more: "Doing" alone names no field.
        aria-label={`${field}: ${label}`}
        data-testid={`ticket-rail-property-${field.toLowerCase()}`}
        data-value={value}
      >
        {children}
        <span className="min-w-0 truncate">{label}</span>
        <CaretDownIcon weight="bold" className="size-3 shrink-0 text-muted-foreground" />
      </Button>
    </DropdownMenuTrigger>
  );
}

/** One applied label: its colour, its name, and its own Remove. */
function LabelPill({
  name,
  color,
  canWrite,
  removeRef,
  onRemove,
}: {
  name: string;
  color: string;
  /** Read-only (VC-576): the pill reads; its Remove stands down. */
  canWrite: boolean;
  removeRef: (node: HTMLButtonElement | null) => void;
  onRemove: () => void;
}) {
  return (
    <span
      data-testid="ticket-rail-label-pill"
      data-label={name}
      className="flex h-6 min-w-0 shrink items-center gap-1 rounded-full border border-sidebar-border py-0 pr-0.5 pl-1.5 text-label"
    >
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="min-w-0 truncate">{name}</span>
      <button
        type="button"
        ref={removeRef}
        aria-label={`Remove ${name}`}
        title={`Remove ${name}`}
        data-testid="ticket-rail-label-remove"
        disabled={!canWrite}
        className="flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        onClick={onRemove}
      >
        <XIcon weight="bold" className="size-2.5" />
      </button>
    </span>
  );
}

/**
 * The additive control at the end of the run: the project's own vocabulary,
 * MINUS what is already applied.
 *
 * It is the app's search-a-list shape (`Popover` + cmdk `Command`, the branch
 * picker's idiom) rather than the shared `LabelPickerPopover`, for one reason:
 * that picker is a TOGGLE list, and its ticks are the removal affordance the
 * pills now own. Offering an applied label here would be a second, quieter
 * place to take a label off — and a menu whose rows do two different things
 * depending on a check you have to notice. Both surfaces read the same
 * vocabulary and the same `newLabelFromQuery` rule, so a name that differs
 * only in case is still offered rather than minted twice.
 *
 * THE GLYPH IS THE WHOLE CONTROL. The button used to trail the word `Add`
 * beside its `+`, which is the run's own rule broken by the one thing in it
 * that is not a label: every pill on the line is a NAME, so a chip reading
 * `+ Add` reads at a glance as a label called Add, and it spends rail width
 * saying what the universal glyph beside it already says. The word is not
 * lost and was never only visual — `aria-label` and `title` still say `Add
 * label`, which is where a screen reader and a hovering pointer were already
 * getting it. The target keeps the run's 24px height and squares up to it, so
 * dropping the text takes nothing off the pointer's reach.
 *
 * ADD IS NEVER DISABLED. It briefly went dead once the project's existing
 * vocabulary was all applied — which reads as "there is nothing to add" and is
 * false everywhere except a fixture: `newLabelFromQuery` mints a name the
 * project has never seen, so the field behind this button is how a label is
 * CREATED. A project with three labels, all applied, is the common case on a
 * young board, and disabling there takes the create path away exactly when it
 * is the only one left.
 */
function AddLabelControl({
  projectId,
  applied,
  canWrite,
  addRef,
  onAdd,
}: {
  projectId: string;
  applied: readonly string[];
  /** Read-only (VC-576): Add stands down, like Status and Priority. */
  canWrite: boolean;
  addRef: (node: HTMLButtonElement | null) => void;
  onAdd: (name: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const vocabulary = useLabelVocabulary(projectId);
  // Only what is not yet applied. `labelPickerOptions` already unions the
  // vocabulary with the applied set and filters by the query; dropping the
  // selected rows is the whole difference between Add and the toggle picker.
  const options = labelPickerOptions(vocabulary, applied, query).filter(
    (option) => !option.selected,
  );
  const creatable = newLabelFromQuery(vocabulary, applied, query);
  const projectLabels = useBoardStore((state) => state.labelsByProject[projectId]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          ref={addRef}
          aria-label="Add label"
          title="Add label"
          data-testid="ticket-rail-label-add"
          disabled={!canWrite}
          className="flex size-6 shrink-0 items-center justify-center rounded-full border border-sidebar-border text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          {/* `bold` at 12px: the size tier where regular draws lighter than the
              text it sits among (CLAUDE.md), and this glyph now has no word
              beside it to borrow weight from. */}
          <PlusIcon weight="bold" className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <Command shouldFilter={false} className="bg-transparent">
          <CommandInput autoFocus value={query} onValueChange={setQuery} placeholder="Add label…" />
          <CommandList className="max-h-56">
            {options.length === 0 && creatable === null ? (
              // Not "none left": the field itself is the remaining answer.
              <div className={EMPTY_INLINE}>Type a new label name</div>
            ) : null}
            {options.map((option) => (
              <CommandItem
                key={option.name}
                value={option.name}
                // The closure, never cmdk's callback argument: it hands the
                // value back LOWERCASED, and `bug` is not the label `Bug`.
                onSelect={() => {
                  onAdd(option.name);
                  setQuery("");
                  setOpen(false);
                }}
              >
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: resolveLabelColor(projectLabels, option.name) }}
                />
                <span className="truncate">{option.name}</span>
              </CommandItem>
            ))}
            {creatable === null ? null : (
              <CommandItem
                value={`new-label:${creatable}`}
                onSelect={() => {
                  onAdd(creatable);
                  setQuery("");
                  setOpen(false);
                }}
              >
                <PlusIcon />
                <span className="truncate">Create “{creatable}”</span>
              </CommandItem>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The applied run, plus Add.
 *
 * ORDER IS THE TICKET's: labels are drawn in the order the array carries them,
 * and an added one is appended — never re-sorted, because a run that
 * re-arranges itself on every edit is a run whose Remove buttons move under
 * the pointer.
 *
 * FOCUS AFTER A REMOVAL stays on the run. The neighbour that slid into the
 * removed pill's place takes it (the last pill, when the removed one was
 * last), and Add takes it when the run is now empty. It is requested at click
 * time and spent in a layout effect, because the pill that will hold the focus
 * does not exist as the removed one's sibling until the store's optimistic
 * patch has re-rendered the run.
 */
function LabelRun({
  projectId,
  labels,
  canWrite,
  onChange,
}: {
  projectId: string;
  labels: readonly string[];
  canWrite: boolean;
  onChange: (next: string[]) => void;
}) {
  const projectLabels = useBoardStore((state) => state.labelsByProject[projectId]);
  const removeRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const addRef = React.useRef<HTMLButtonElement | null>(null);
  /** The pill to focus once the run has re-rendered, or `null` for Add. */
  const pendingFocus = React.useRef<string | null | undefined>(undefined);

  React.useLayoutEffect(() => {
    const wanted = pendingFocus.current;
    if (wanted === undefined) return;
    pendingFocus.current = undefined;
    const target = wanted === null ? addRef.current : (removeRefs.current.get(wanted) ?? null);
    (target ?? addRef.current)?.focus();
  }, [labels]);

  const remove = (name: string): void => {
    const index = labels.indexOf(name);
    if (index === -1) return;
    const next = labels.filter((existing) => existing !== name);
    // The pill that slides into this one's place: the one now at the same
    // index, else the new last pill, else Add.
    pendingFocus.current = next[Math.min(index, next.length - 1)] ?? null;
    removeRefs.current.delete(name);
    onChange(next);
  };

  return (
    <span
      role="group"
      aria-label={`Labels: ${labels.length === 0 ? "none" : labels.join(", ")}`}
      data-testid="ticket-rail-label-run"
      className="flex min-w-0 flex-1 flex-wrap items-center gap-1"
    >
      {labels.map((name) => (
        <LabelPill
          key={name}
          name={name}
          color={resolveLabelColor(projectLabels, name)}
          canWrite={canWrite}
          removeRef={(node) => {
            if (node === null) removeRefs.current.delete(name);
            else removeRefs.current.set(name, node);
          }}
          onRemove={() => remove(name)}
        />
      ))}
      <AddLabelControl
        projectId={projectId}
        applied={labels}
        canWrite={canWrite}
        addRef={(node) => {
          addRef.current = node;
        }}
        onAdd={(name) => {
          // Appended, so the run reads in the order it was built.
          if (labels.includes(name)) return;
          onChange([...labels, name]);
        }}
      />
    </span>
  );
}

export function TicketProperties({ projectId, ticket }: { projectId: string; ticket: Ticket }) {
  const statusLabel = TICKET_STATUS_LABELS[ticket.status];
  const priorityLabel = TICKET_PRIORITY_LABELS[ticket.priority];
  const canWrite = useCanWrite(projectId);
  return (
    <section
      aria-label="Properties"
      data-testid="ticket-rail-properties"
      className={cn("flex flex-col gap-1", RAIL_PANEL_INSET)}
    >
      <RailSectionHeadingRow label="Properties" />
      <ul className="flex flex-col">
        <PropertyRow
          data-testid="ticket-rail-property-row-status"
          glyph={<CircleIcon className="size-4" />}
          control={
            <DropdownMenu>
              <ValueTrigger
                label={statusLabel}
                field="Status"
                value={ticket.status}
                canWrite={canWrite}
              />
              <DropdownMenuContent align="start">
                <DropdownMenuRadioGroup
                  value={ticket.status}
                  onValueChange={(value) => {
                    if (!guardWrite(projectId)) return;
                    // The board's own move, so the column change keeps every
                    // side effect it has anywhere else — including whichever
                    // Automation the new column arms.
                    void useBoardStore
                      .getState()
                      .moveTicket(
                        projectId,
                        ticket.id,
                        value as TicketStatus,
                        Number.MAX_SAFE_INTEGER,
                      );
                  }}
                >
                  {TICKET_STATUSES.map((status) => (
                    <DropdownMenuRadioItem key={status} value={status}>
                      {TICKET_STATUS_LABELS[status]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
        <PropertyRow
          data-testid="ticket-rail-property-row-priority"
          glyph={<PriorityIndicator priority={ticket.priority} />}
          control={
            <DropdownMenu>
              <ValueTrigger
                label={priorityLabel}
                field="Priority"
                value={ticket.priority}
                canWrite={canWrite}
              />
              <DropdownMenuContent align="start">
                <DropdownMenuRadioGroup
                  value={ticket.priority}
                  onValueChange={(value) => {
                    if (!guardWrite(projectId)) return;
                    void useBoardStore
                      .getState()
                      .setTicketPriority(projectId, ticket.id, value as TicketPriority);
                  }}
                >
                  {TICKET_PRIORITIES.map((priority) => (
                    <DropdownMenuRadioItem key={priority} value={priority}>
                      <PriorityIndicator priority={priority} />
                      {TICKET_PRIORITY_LABELS[priority]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
        <PropertyRow
          data-testid="ticket-rail-property-row-labels"
          align="start"
          glyph={<TagIcon className="size-4" />}
          control={
            <LabelRun
              projectId={projectId}
              labels={ticket.labels}
              canWrite={canWrite}
              onChange={(next) => {
                if (!guardWrite(projectId)) return;
                void useBoardStore.getState().setLabels(ticket.id, next);
              }}
            />
          }
        />
      </ul>
    </section>
  );
}
