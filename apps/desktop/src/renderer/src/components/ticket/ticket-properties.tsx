/**
 * The Now page's Properties block — status, priority and labels — as a SECTION
 * (VC-406, second pass): a `PROPERTIES` eyebrow over three `ListRow`s, the
 * same object the Sessions and Automations blocks under it are.
 *
 * It was a wrapping run of 24px pills with no eyebrow, and that run was the
 * one block on the page that was neither of its two object kinds: unmarked,
 * bordered at rest where every row is borderless until hovered, and two facts
 * to a line where the page sets one thing per line. Alone it read as Linear's
 * property strip; under the sections it was the odd block out.
 *
 * The rows speak the roster's grammar: a glyph, THE VALUE as the thing, and the
 * field name as the quiet qualifier at the right — `○ Doing · Status`. The
 * value is the thing because it is what a reader scans for; the field is what
 * they check. Each row opens the picker its pill did. It costs ~80px more
 * than the chips, paid deliberately at the top of the page. Labels lose their
 * inline ×: the picker (one press away, the same picker the + opened) toggles
 * them, because a row is one target, not three.
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
import { CircleIcon } from "@phosphor-icons/react/dist/csr/Circle";
import { TagIcon } from "@phosphor-icons/react/dist/csr/Tag";
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
import { LabelPickerPopover } from "@renderer/components/ticket/label-picker";
import {
  RAIL_PANEL_INSET,
  RailSectionHeadingRow,
} from "@renderer/components/ticket/rail-panel-parts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { ListRow } from "@renderer/components/ui/list-row";
import { resolveLabelColor } from "@renderer/lib/labels";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";

const NOOP = () => {};

function FieldWord({ children }: { children: string }) {
  return <span className="shrink-0 text-label text-muted-foreground">{children}</span>;
}

function LabelRun({ projectId, labels }: { projectId: string; labels: readonly string[] }) {
  const projectLabels = useBoardStore((state) => state.labelsByProject[projectId]);
  if (labels.length === 0)
    return <span className="truncate text-ui text-muted-foreground">No labels</span>;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2 truncate text-ui">
      {labels.map((label) => (
        <span key={label} className="flex shrink-0 items-center gap-1">
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: resolveLabelColor(projectLabels, label) }}
          />
          {label}
        </span>
      ))}
    </span>
  );
}

export function TicketProperties({ projectId, ticket }: { projectId: string; ticket: Ticket }) {
  const statusLabel = TICKET_STATUS_LABELS[ticket.status];
  const priorityLabel = TICKET_PRIORITY_LABELS[ticket.priority];
  return (
    <section
      aria-label="Properties"
      data-testid="ticket-rail-properties"
      className={cn("flex flex-col gap-1", RAIL_PANEL_INSET)}
    >
      <RailSectionHeadingRow label="Properties" />
      <ul className="flex flex-col">
        <li>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <ListRow
                aria-label={`Status: ${statusLabel}`}
                onActivate={NOOP}
                leading={<CircleIcon className="size-4 shrink-0 text-muted-foreground" />}
                primary={statusLabel}
                trailing={<FieldWord>Status</FieldWord>}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuRadioGroup
                value={ticket.status}
                onValueChange={(value) =>
                  void useBoardStore
                    .getState()
                    .moveTicket(
                      projectId,
                      ticket.id,
                      value as TicketStatus,
                      Number.MAX_SAFE_INTEGER,
                    )
                }
              >
                {TICKET_STATUSES.map((status) => (
                  <DropdownMenuRadioItem key={status} value={status}>
                    {TICKET_STATUS_LABELS[status]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
        <li>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <ListRow
                aria-label={`Priority: ${priorityLabel}`}
                onActivate={NOOP}
                leading={<PriorityIndicator priority={ticket.priority} />}
                primary={priorityLabel}
                trailing={<FieldWord>Priority</FieldWord>}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuRadioGroup
                value={ticket.priority}
                onValueChange={(value) =>
                  void useBoardStore
                    .getState()
                    .setTicketPriority(projectId, ticket.id, value as TicketPriority)
                }
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
        </li>
        <li>
          <LabelPickerPopover
            projectId={projectId}
            value={ticket.labels}
            onChange={(next) => void useBoardStore.getState().setLabels(ticket.id, next)}
          >
            <ListRow
              aria-label="Labels"
              onActivate={NOOP}
              leading={<TagIcon className="size-4 shrink-0 text-muted-foreground" />}
              primary={<LabelRun projectId={projectId} labels={ticket.labels} />}
              trailing={<FieldWord>Labels</FieldWord>}
            />
          </LabelPickerPopover>
        </li>
      </ul>
    </section>
  );
}
