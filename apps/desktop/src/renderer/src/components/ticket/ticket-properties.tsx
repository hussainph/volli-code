/** Native label/value properties. Mutations, label order and focus recovery stay
 * with the board store; the row and pop-up geometry are shared with forms. */
import * as React from "react";
import { FlagIcon } from "@phosphor-icons/react/dist/csr/Flag";
import { TrayIcon } from "@phosphor-icons/react/dist/csr/Tray";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { PlayCircleIcon } from "@phosphor-icons/react/dist/csr/PlayCircle";
import { EyeIcon } from "@phosphor-icons/react/dist/csr/Eye";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
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

import {
  labelPickerOptions,
  newLabelFromQuery,
} from "@renderer/components/ticket/label-picker-model";
import { guardWrite, useCanWrite } from "@renderer/components/hosts/use-hosts";
import { useLabelVocabulary } from "@renderer/components/ticket/label-picker";
import { RAIL_PANEL_INSET } from "@renderer/components/ticket/rail-panel-parts";
import { InspectorPopup, InspectorRow } from "@renderer/components/ui/inspector";
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

const STATUS_ICON = {
  backlog: TrayIcon,
  todo: ListChecksIcon,
  doing: PlayCircleIcon,
  needs_review: EyeIcon,
  done: CheckCircleIcon,
} as const;

/** The current value is the only pop-up target; the row itself is inert. */
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
      <InspectorPopup
        disabled={!canWrite}
        aria-label={`${field}: ${label}`}
        data-testid={`ticket-rail-property-${field.toLowerCase()}`}
        data-value={value}
      >
        {children}
        <span className="min-w-0 truncate">{label}</span>
      </InspectorPopup>
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
      className="flex h-6 min-w-0 shrink items-center gap-1 rounded-control-small bg-(--accent-tint) py-0 pr-0.5 pl-1.5 text-ui"
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
          className="flex size-6 shrink-0 items-center justify-center rounded-control-small text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          {/* `bold` at 12px: the size tier where regular draws lighter than the
              text it sits among (CLAUDE.md), and this glyph now has no word
              beside it to borrow weight from. */}
          <PlusIcon weight="bold" className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <Command shouldFilter={false} className="bg-transparent">
          <CommandInput autoFocus value={query} onValueChange={setQuery} placeholder="Add label" />
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
  const StatusIcon = STATUS_ICON[ticket.status];
  const priorityLabel = TICKET_PRIORITY_LABELS[ticket.priority];
  const canWrite = useCanWrite(projectId);
  return (
    <section
      aria-label="Properties"
      data-testid="ticket-rail-properties"
      className={cn("flex flex-col gap-1", RAIL_PANEL_INSET)}
    >
      <ul className="flex flex-col">
        <InspectorRow label="Status" data-testid="ticket-rail-property-row-status">
          <DropdownMenu>
            <ValueTrigger
              label={statusLabel}
              field="Status"
              value={ticket.status}
              canWrite={canWrite}
            >
              <StatusIcon aria-hidden className="size-3.5 text-muted-foreground" />
            </ValueTrigger>
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
        </InspectorRow>
        <InspectorRow label="Priority" data-testid="ticket-rail-property-row-priority">
          <DropdownMenu>
            <ValueTrigger
              label={priorityLabel}
              field="Priority"
              value={ticket.priority}
              canWrite={canWrite}
            >
              <FlagIcon aria-hidden className="size-3.5 text-muted-foreground" />
            </ValueTrigger>
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
                    {TICKET_PRIORITY_LABELS[priority]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </InspectorRow>
        <InspectorRow label="Labels" data-testid="ticket-rail-property-row-labels">
          <LabelRun
            projectId={projectId}
            labels={ticket.labels}
            canWrite={canWrite}
            onChange={(next) => {
              if (!guardWrite(projectId)) return;
              void useBoardStore.getState().setLabels(ticket.id, next);
            }}
          />
        </InspectorRow>
      </ul>
    </section>
  );
}
