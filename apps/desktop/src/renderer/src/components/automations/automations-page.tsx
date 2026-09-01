/**
 * The Automations page (VC-127): a nav destination beside Home and Configure,
 * and **the only surface in the app that authors an Automation**. Every other
 * surface — the board card menu, the ticket rail, the command palette — merely
 * runs one, and the editor dialog is mounted HERE rather than at window level
 * for exactly that reason: an authoring form summoned from anywhere is a
 * second authoring surface however it was opened.
 *
 * It is a nav page rather than a room inside Home on purpose: `nav-list.tsx`
 * carries the guardrail that Home must not become a junk drawer, and VC-112
 * names this page as the fourth `NavKey` for that reason.
 *
 * TWO drawings of one set, and the split is the point (VC-132). The **lanes**
 * across the top are one per board column, holding that column's Offered list
 * in digit order: they exist to arrange the ORDER, which is the one fact about
 * an Automation that is a property of a column rather than of the record. The
 * **flat list** below them owns the whole record lifecycle — create, edit,
 * duplicate, enable, disable, delete — plus the Run history and Run itself.
 * The lanes render and arrange; they never author, because a second authoring
 * surface is a second authoring surface however it is drawn.
 *
 * Three rows of vocabulary worth stating once, because all three are
 * load-bearing:
 *
 *  - **Every listing surface can Run.** VC-112: running by hand is universal
 *    and is never one of the Trigger's answers. So a row runs, and it runs
 *    whether or not the switch is on — the switch governs what starts an
 *    Automation BESIDES a person.
 *  - **The switch is machine-local, and off is the resting state.** It never
 *    travels with the project (VC-112 puts an Automation's shareable half in
 *    git as a Skill and keeps the record local; the switch is more local
 *    still), and a machine that has never been asked has not said yes: an
 *    Automation fires on its own only where somebody turned it on.
 *  - **Delete is a record delete.** There is no archive, and that is a ruling
 *    rather than an omission: for a Skill, git is already the archive.
 */
import * as React from "react";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ClockCounterClockwise";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";

import {
  TICKET_STATUS_LABELS,
  displayTicketId,
  type Automation,
  type AutomationRun,
  type AutomationSkippedOccurrence,
  type Ticket,
} from "@volli/shared";

import {
  automationHistory,
  groupByOwnership,
  listingRunTarget,
  runAutomationLabel,
  runModelLabel,
  runModelTitle,
  runtimeLabel,
  skipCountLabel,
  skipReasonLabel,
  triggerLabel,
} from "./automations-page-model";
import { AutomationEditorDialog } from "./automation-editor";
import { AutomationLanes } from "./automation-lanes";
import { openRunSession, runAutomationForProject, runAutomationOnTicket } from "./run-automation";
import { PageHeader } from "@renderer/components/layout/page-header";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { EMPTY_PAGE } from "@renderer/components/ui/empty-classes";
import { Input } from "@renderer/components/ui/input";
import { ListRow } from "@renderer/components/ui/list-row";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { Switch } from "@renderer/components/ui/switch";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { relativeTime } from "@renderer/lib/relative-time";
import { cn } from "@renderer/lib/utils";
import { useAutomationsStore } from "@renderer/stores/automations";
import { useBoardStore } from "@renderer/stores/board";

const NO_AUTOMATIONS: readonly Automation[] = [];
const NO_RUNS: readonly AutomationRun[] = [];
const NO_SKIPS: readonly AutomationSkippedOccurrence[] = [];
const NO_TICKETS: readonly Ticket[] = [];

export function AutomationsPage() {
  const project = useSelectedProject();

  if (project === null) {
    return (
      <div className={cn("flex-1", EMPTY_PAGE)}>
        <div className="flex max-w-sm flex-col items-center">
          <div className="mb-4 flex items-center justify-center rounded-xl border border-border bg-card/70 p-2">
            <LightningIcon className="size-5 text-muted-foreground" />
          </div>
          <h1 className="text-heading font-semibold">No automations</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">Select a project first.</p>
        </div>
      </div>
    );
  }

  return (
    <AutomationsSurface
      key={project.id}
      projectId={project.id}
      ticketPrefix={project.ticketPrefix}
    />
  );
}

function AutomationsSurface({
  projectId,
  ticketPrefix,
}: {
  projectId: string;
  ticketPrefix: string;
}) {
  const automations = useAutomationsStore((state) => state.byProject[projectId] ?? NO_AUTOMATIONS);
  const runs = useAutomationsStore((state) => state.runsByProject[projectId] ?? NO_RUNS);
  const skips = useAutomationsStore((state) => state.skipsByProject[projectId] ?? NO_SKIPS);
  const openEditor = useAutomationsStore((state) => state.openEditor);
  const closeEditor = useAutomationsStore((state) => state.closeEditor);
  const refresh = useAutomationsStore((state) => state.refresh);
  const refreshRuns = useAutomationsStore((state) => state.refreshRuns);
  const refreshArming = useAutomationsStore((state) => state.refreshArming);
  const refreshOrder = useAutomationsStore((state) => state.refreshOrder);
  const refreshSkips = useAutomationsStore((state) => state.refreshSkips);
  const refreshEnablement = useAutomationsStore((state) => state.refreshEnablement);

  // Read on arrival rather than subscribed: the record moves only through this
  // app's own doors, and opening the page IS the moment staleness would show.
  // The planning-change version is in the deps so a Run started elsewhere —
  // the palette, the board — lands in the history without a manual reload.
  const planningVersion = useBoardStore((state) => state.lastPlanningChange.version);
  React.useEffect(() => {
    void refresh(projectId);
    void refreshRuns(projectId);
    // The scheduler broadcasts a planning change when it records a skip, so a
    // due time missed while this page is open lands here without a reload.
    void refreshSkips(projectId);
    // The lanes compose the same four machine-local reads the drag does, so a
    // digit printed here is the digit that works mid-drag — which is only true
    // if the arming and the order arrive with the list.
    void refreshArming(projectId);
    void refreshOrder(projectId);
    void refreshEnablement();
  }, [
    projectId,
    planningVersion,
    refresh,
    refreshRuns,
    refreshSkips,
    refreshArming,
    refreshOrder,
    refreshEnablement,
  ]);

  // The editor is this page's dialog, so leaving the page closes it. Without
  // this, walking away mid-draft would leave the form armed to reappear the
  // next time somebody arrives here, with no visible cause.
  React.useEffect(() => closeEditor, [closeEditor]);

  const { project: owned, global } = React.useMemo(
    () => groupByOwnership(automations),
    [automations],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PageHeader
        title="Automations"
        actions={
          <Button size="sm" onClick={() => openEditor(projectId)}>
            <PlusIcon />
            New Automation
          </Button>
        }
      />
      <div className="flex flex-col gap-6 px-gutter pb-6">
        {automations.length === 0 ? (
          <EmptyAutomations projectId={projectId} />
        ) : (
          <>
            {/* Where a column's order is arranged (VC-132). Above the list
                because it answers the question the list cannot: not what an
                Automation IS, but which one a column reaches for first. */}
            <AutomationLanes projectId={projectId} />
            <AutomationSection
              title="This project"
              projectId={projectId}
              ticketPrefix={ticketPrefix}
              automations={owned}
              emptyNote="Nothing yet in this project."
            />
            <AutomationSection
              title="All projects"
              projectId={projectId}
              ticketPrefix={ticketPrefix}
              automations={global}
              emptyNote="Nothing shared across every project."
            />
          </>
        )}
        <RunHistory projectId={projectId} ticketPrefix={ticketPrefix} runs={runs} skips={skips} />
      </div>
      {/* The one authoring form, mounted by the one authoring surface. */}
      <AutomationEditorDialog />
    </div>
  );
}

/**
 * The zero state. One sentence and the action, per the copy rule — the page's
 * own New button is the same act, and this is the version you meet when there
 * is nothing else on screen to explain it.
 */
function EmptyAutomations({ projectId }: { projectId: string }) {
  const openEditor = useAutomationsStore((state) => state.openEditor);
  return (
    <div className="flex flex-col items-start gap-4 rounded-xl border border-dashed border-border px-4 py-6">
      <p className="text-sm text-muted-foreground">
        An Automation is a saved way of starting work — its Trigger, its Instructions and its
        Runtime.
      </p>
      <Button size="sm" variant="secondary" onClick={() => openEditor(projectId)}>
        <PlusIcon />
        New Automation
      </Button>
    </div>
  );
}

function AutomationSection({
  title,
  projectId,
  ticketPrefix,
  automations,
  emptyNote,
}: {
  title: string;
  projectId: string;
  ticketPrefix: string;
  automations: readonly Automation[];
  emptyNote: string;
}) {
  return (
    <section className="flex flex-col gap-1">
      <SectionHeading className="h-6 leading-6">{title}</SectionHeading>
      {automations.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{emptyNote}</p>
      ) : (
        automations.map((automation) => (
          <AutomationRowItem
            key={automation.id}
            projectId={projectId}
            ticketPrefix={ticketPrefix}
            automation={automation}
          />
        ))
      )}
    </section>
  );
}

function AutomationRowItem({
  projectId,
  ticketPrefix,
  automation,
}: {
  projectId: string;
  ticketPrefix: string;
  automation: Automation;
}) {
  const enabled = useAutomationsStore((state) => state.enabledIds.includes(automation.id));
  const editAutomation = useAutomationsStore((state) => state.editAutomation);
  const duplicate = useAutomationsStore((state) => state.duplicate);
  const setEnabled = useAutomationsStore((state) => state.setEnabled);
  const remove = useAutomationsStore((state) => state.remove);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [choosingTicket, setChoosingTicket] = React.useState(false);

  return (
    <>
      <ListRow
        density="two-line"
        // The row's own activation is Edit: this is the authoring surface, so
        // opening an Automation means opening its form. Running is an explicit
        // action, because it spends tokens and opens a Session.
        onActivate={() => editAutomation(projectId, automation)}
        // Neither the mark nor the name dims when the switch is off. Off is
        // the resting state of every record nobody has turned on here, and a
        // row that greyed for it would read as broken — while still being
        // editable, duplicable and runnable by hand. The switch says the state;
        // the line under the name says what the state means.
        leading={<LightningIcon className="size-4 text-muted-foreground" />}
        primary={automation.name}
        secondary={
          <span className="flex min-w-0 items-center gap-1 text-ui">
            {/* The record's own Trigger, not a constant: a row whose Trigger
                names columns says so, because this is the page that authors
                the field. */}
            <span className="truncate">{triggerLabel(automation.trigger)}</span>
            <span aria-hidden>·</span>
            <span className="truncate">{runtimeLabel(automation.runtime)}</span>
            {enabled ? null : (
              <>
                <span aria-hidden>·</span>
                {/* What being off actually MEANS, said once where it is true:
                    by-hand Runs stay universal (VC-112). */}
                <span className="shrink-0">Won&rsquo;t start on its own</span>
              </>
            )}
          </span>
        }
        actions={
          <div className="flex items-center gap-1">
            {/* Its own control rather than a menu item, because VC-112 rules
                that every Automation is runnable by hand from every surface
                that lists it — including one whose switch is off. A rule that
                universal does not live one click deep. */}
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Run ${automation.name}`}
              onClick={(event) => {
                event.stopPropagation();
                // The Trigger decides the Target (VC-112). A schedule names the
                // Project, so its Play opens the Project Session the schedule
                // itself would open rather than asking which Ticket — the
                // by-hand Run and the automatic one are the same work.
                if (listingRunTarget(automation) === "project") {
                  void runAutomationForProject({
                    automationId: automation.id,
                    automationName: automation.name,
                    projectId,
                  });
                  return;
                }
                setChoosingTicket(true);
              }}
            >
              <PlayIcon />
            </Button>
            <Switch
              checked={enabled}
              aria-label={`Enabled on this machine: ${automation.name}`}
              onCheckedChange={(next) => void setEnabled(automation.id, next)}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Actions for ${automation.name}`}
                  onClick={(event) => event.stopPropagation()}
                >
                  <DotsThreeIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onSelect={() => editAutomation(projectId, automation)}>
                  <PencilSimpleIcon />
                  Edit
                </DropdownMenuItem>
                {/* Explicit, because VC-112's tripwire depends on it: one
                    Trigger per Automation is only cheap if "same work,
                    different Trigger" is one click. */}
                <DropdownMenuItem onSelect={() => void duplicate(projectId, automation)}>
                  <CopyIcon />
                  Duplicate
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirmingDelete(true)}>
                  <TrashIcon />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />
      <RunOnTicketDialog
        open={choosingTicket}
        onOpenChange={setChoosingTicket}
        projectId={projectId}
        ticketPrefix={ticketPrefix}
        automation={automation}
      />
      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{automation.name}”?</AlertDialogTitle>
            {/* One of the copy rule's stated exceptions: an irreversible
                confirm may say what it does. There is no archive — for a
                Skill, git is already the archive (VC-112). */}
            <AlertDialogDescription>
              Deletes the record. Runs it already started keep their history. Can&rsquo;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void remove(projectId, automation)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * Which Ticket to run on.
 *
 * A Run opens one fresh Session at one scope (VC-112), and the manual Trigger
 * names no Ticket of its own — so the surface that runs has to ask. Elsewhere
 * the Ticket is already the context (the board card, the rail, the palette's
 * open Ticket); here the person is looking at a list of records, so this is
 * the one place the question is worth a dialog.
 *
 * Starting the Run does NOT navigate. VC-234 makes that universal rather than
 * a listing-versus-context distinction: `runAutomationOnTicket` toasts with an
 * "Open session" action and the person decides whether to leave this page.
 */
function RunOnTicketDialog({
  open,
  onOpenChange,
  projectId,
  ticketPrefix,
  automation,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  projectId: string;
  ticketPrefix: string;
  automation: Automation;
}) {
  const tickets = useBoardStore((state) => state.ticketsByProject[projectId] ?? NO_TICKETS);
  const [query, setQuery] = React.useState("");

  const matches = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return tickets;
    return tickets.filter((ticket) =>
      `${displayTicketId(ticketPrefix, ticket.ticketNumber)} ${ticket.title}`
        .toLowerCase()
        .includes(needle),
    );
  }, [query, tickets, ticketPrefix]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("");
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Run “{automation.name}” on</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Input
            autoFocus
            value={query}
            aria-label="Find a ticket"
            placeholder="Find a ticket"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <div className="flex max-h-80 flex-col overflow-y-auto">
            {matches.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">No tickets here.</p>
            ) : (
              matches.map((ticket) => {
                const ticketDisplayId = displayTicketId(ticketPrefix, ticket.ticketNumber);
                return (
                  <ListRow
                    key={ticket.id}
                    primary={ticket.title}
                    leading={
                      <span className="shrink-0 font-mono text-label text-muted-foreground">
                        {ticketDisplayId}
                      </span>
                    }
                    trailing={
                      <span className="shrink-0 text-label text-muted-foreground">
                        {TICKET_STATUS_LABELS[ticket.status]}
                      </span>
                    }
                    onActivate={() => {
                      onOpenChange(false);
                      setQuery("");
                      void runAutomationOnTicket({
                        target: { kind: "automation", automationId: automation.id },
                        automationName: automation.name,
                        ticketId: ticket.id,
                        ticketDisplayId,
                        // The page runs the record as saved. Its per-invocation
                        // override lives where a person picks one Ticket and
                        // stops — the rail and the ticket context menu.
                        modelOverride: null,
                      });
                    }}
                  />
                );
              })
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Run history, newest first. Each Run names its Automation and the model and
 * reasoning it RESOLVED at launch, and is a door back to its Session — which
 * is the whole reason a Run is a record and not a log line.
 *
 * Skipped occurrences are interleaved here rather than filed in a lane of
 * their own, because VC-112 requires exactly that: a skip "offers Run now from
 * the Run history", and a skip and a silence must never look the same. A
 * schedule that fired on Monday and did not on Tuesday tells one story, and
 * two lists would make the reader assemble it.
 */
function RunHistory({
  projectId,
  ticketPrefix,
  runs,
  skips,
}: {
  projectId: string;
  ticketPrefix: string;
  runs: readonly AutomationRun[];
  skips: readonly AutomationSkippedOccurrence[];
}) {
  const entries = React.useMemo(() => automationHistory(runs, skips), [runs, skips]);
  return (
    <section className="flex flex-col gap-1">
      <SectionHeading className="h-6 leading-6">Runs</SectionHeading>
      {entries.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">Nothing has run in this project yet.</p>
      ) : (
        entries.map((entry) =>
          entry.kind === "run" ? (
            <RunRow
              key={entry.run.id}
              projectId={projectId}
              ticketPrefix={ticketPrefix}
              run={entry.run}
            />
          ) : (
            <SkippedRow key={entry.skip.id} skip={entry.skip} />
          ),
        )
      )}
    </section>
  );
}

/**
 * One Skipped occurrence: a due time that passed without a Run, and the
 * control that starts it now.
 *
 * It wears a different mark from a Run and says what went wrong in its own
 * line, so it can never be mistaken for work that happened. "Run now" starts
 * ONE Run at the Target the schedule would have used — the Project — whatever
 * number of occurrences this row stands for: a missed occurrence is never
 * replayed (VC-112), and this is the by-hand recovery that ruling promises
 * instead.
 */
function SkippedRow({ skip }: { skip: AutomationSkippedOccurrence }) {
  const count = skipCountLabel(skip);
  return (
    <ListRow
      density="two-line"
      // Inert as a row: a skip opened no Session, so there is nowhere for the
      // row itself to go. Its one act is the control, which is why the control
      // is on it rather than a click nothing would answer.
      onActivate={null}
      leading={<ClockCounterClockwiseIcon className="size-4 text-muted-foreground" />}
      primary={skip.automationName}
      secondary={
        <span className="flex min-w-0 items-center gap-1 text-ui">
          <span className="truncate">{skipReasonLabel(skip)}</span>
          {count === "" ? null : (
            <>
              <span aria-hidden>·</span>
              <span className="shrink-0">{count}</span>
            </>
          )}
        </span>
      }
      actions={
        <Button
          size="sm"
          variant="secondary"
          aria-label={`Run ${skip.automationName} now`}
          onClick={(event) => {
            event.stopPropagation();
            void runAutomationForProject({
              automationId: skip.automationId,
              automationName: skip.automationName,
              projectId: skip.projectId,
            });
          }}
        >
          Run now
        </Button>
      }
      trailing={
        <span className="shrink-0 text-label text-muted-foreground">
          {relativeTime(skip.dueAt)}
        </span>
      }
    />
  );
}

function RunRow({
  projectId,
  ticketPrefix,
  run,
}: {
  projectId: string;
  ticketPrefix: string;
  run: AutomationRun;
}) {
  const ticketNumber = useBoardStore(
    (state) =>
      state.ticketsByProject[projectId]?.find((candidate) => candidate.id === run.ticketId)
        ?.ticketNumber,
  );

  return (
    <ListRow
      density="two-line"
      // The door back to the Session the Run opened, always. A Run whose
      // Ticket is gone kept its Session and its place in this history, so it
      // opens in Home — the project's own home for a Session no Ticket owns —
      // rather than going inert.
      onActivate={() =>
        openRunSession({ sessionId: run.sessionId, projectId, ticketId: run.ticketId })
      }
      leading={<LightningIcon className="size-4 text-muted-foreground" />}
      primary={runAutomationLabel(run)}
      secondary={
        <span className="flex min-w-0 items-center gap-1 text-ui" title={runModelTitle(run)}>
          {ticketNumber === undefined ? null : (
            <>
              <span className="shrink-0 font-mono text-label">
                {displayTicketId(ticketPrefix, ticketNumber)}
              </span>
              <span aria-hidden>·</span>
            </>
          )}
          {/* The RESOLVED model this Session was born with, printed from the
              Run's own row — never re-labelled through today's catalogue. */}
          <span className="truncate">{runModelLabel(run)}</span>
        </span>
      }
      trailing={
        <span className="shrink-0 text-label text-muted-foreground">
          {relativeTime(run.createdAt)}
        </span>
      }
    />
  );
}
