/**
 * The Automations page (VC-127): a nav destination beside Home and Configure,
 * and **the only surface in the app that authors an Automation**. Every other
 * surface — the board card menu, the ticket rail, the command palette — merely
 * runs one. The persistent rail and embedded editor live HERE for exactly that
 * reason: an authoring form summoned from anywhere is a second authoring
 * surface however it was opened.
 *
 * It is a nav page rather than a room inside Home on purpose: `nav-list.tsx`
 * carries the guardrail that Home must not become a junk drawer, and VC-112
 * names this page as the fourth `NavKey` for that reason.
 *
 * TWO drawings of one set, and the split is the point (VC-132). The persistent
 * rail selects a record for its focused editor; Lanes switches the main plane
 * to one lane per board column, holding each Offered list in digit order. The
 * editor owns the whole record lifecycle and Run history. Lanes only arranges
 * column order and arming — it never rewrites a record, because a second
 * authoring surface is a second authoring surface however it is drawn.
 *
 * Three rows of vocabulary worth stating once, because all three are
 * load-bearing:
 *
 *  - **Every listing surface can Run.** VC-112: running by hand is universal
 *    and is never one of the Trigger's answers. The selected editor can Run
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
import { KanbanIcon } from "@phosphor-icons/react/dist/csr/Kanban";
import { ListBulletsIcon } from "@phosphor-icons/react/dist/csr/ListBullets";
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
import { AutomationEditorPanel } from "./automation-editor";
import { AutomationLanes } from "./automation-lanes";
import { openRunSession, runAutomationForProject, runAutomationOnTicket } from "./run-automation";
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

type AutomationPageView = "details" | "lanes";

function ViewChoice({
  view,
  value,
  label,
  icon: Icon,
  onChange,
}: {
  view: AutomationPageView;
  value: AutomationPageView;
  label: string;
  icon: typeof ListBulletsIcon;
  onChange(value: AutomationPageView): void;
}) {
  const active = view === value;
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onChange(value)}
      className={cn(
        "flex h-7 items-center gap-2 rounded-md px-2 text-ui outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring/45",
        active
          ? "bg-accent text-foreground shadow-raised"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon aria-hidden className="size-4" />
      {label}
    </button>
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
  const editor = useAutomationsStore((state) => state.editor);
  const enabledIds = useAutomationsStore((state) => state.enabledIds);
  const openEditor = useAutomationsStore((state) => state.openEditor);
  const editAutomation = useAutomationsStore((state) => state.editAutomation);
  const closeEditor = useAutomationsStore((state) => state.closeEditor);
  const duplicate = useAutomationsStore((state) => state.duplicate);
  const remove = useAutomationsStore((state) => state.remove);
  const setEnabled = useAutomationsStore((state) => state.setEnabled);
  const refresh = useAutomationsStore((state) => state.refresh);
  const refreshRuns = useAutomationsStore((state) => state.refreshRuns);
  const refreshArming = useAutomationsStore((state) => state.refreshArming);
  const refreshOrder = useAutomationsStore((state) => state.refreshOrder);
  const refreshSkips = useAutomationsStore((state) => state.refreshSkips);
  const refreshEnablement = useAutomationsStore((state) => state.refreshEnablement);
  const [view, setView] = React.useState<AutomationPageView>("details");
  const [choosingTicket, setChoosingTicket] = React.useState<Automation | null>(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState<Automation | null>(null);

  const planningVersion = useBoardStore((state) => state.lastPlanningChange.version);
  React.useEffect(() => {
    void refresh(projectId);
    void refreshRuns(projectId);
    void refreshSkips(projectId);
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

  React.useEffect(() => closeEditor, [closeEditor]);

  // The rail always has one selected record once the list lands. A create is a
  // deliberate null record and is never replaced by this defaulting effect.
  React.useEffect(() => {
    if (automations.length === 0) return;
    if (editor?.projectId === projectId && editor.automation === null) return;
    const selectedId = editor?.projectId === projectId ? editor.automation?.id : undefined;
    if (
      selectedId !== undefined &&
      automations.some((automation) => automation.id === selectedId)
    ) {
      return;
    }
    editAutomation(projectId, automations[0]!);
  }, [automations, editAutomation, editor, projectId]);

  const target = editor?.projectId === projectId ? editor : null;
  const selectedAutomation =
    target?.automation === null || target === null
      ? null
      : (automations.find((automation) => automation.id === target.automation?.id) ??
        target.automation);
  const { project: projectAutomations, global: globalAutomations } = React.useMemo(
    () => groupByOwnership(automations),
    [automations],
  );

  function selectAutomation(automation: Automation): void {
    setView("details");
    editAutomation(projectId, automation);
  }

  function createAutomation(): void {
    setView("details");
    openEditor(projectId);
  }

  function runAutomation(automation: Automation): void {
    if (listingRunTarget(automation) === "project") {
      void runAutomationForProject({
        automationId: automation.id,
        automationName: automation.name,
        projectId,
      });
      return;
    }
    setChoosingTicket(automation);
  }

  const editorActions =
    selectedAutomation === null ? (
      automations.length === 0 ? null : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => editAutomation(projectId, automations[0]!)}
        >
          Cancel
        </Button>
      )
    ) : (
      <>
        <label className="flex items-center gap-2 text-ui text-muted-foreground">
          Enabled
          <Switch
            checked={enabledIds.includes(selectedAutomation.id)}
            aria-label={`Enabled on this machine: ${selectedAutomation.name}`}
            onCheckedChange={(enabled) => void setEnabled(selectedAutomation.id, enabled)}
          />
        </label>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Run ${selectedAutomation.name}`}
          onClick={() => runAutomation(selectedAutomation)}
        >
          <PlayIcon />
          Run
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`More for ${selectedAutomation.name}`}
            >
              <DotsThreeIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void duplicate(projectId, selectedAutomation)}>
              <CopyIcon />
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setConfirmingDelete(selectedAutomation)}
            >
              <TrashIcon />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-4 border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <LightningIcon weight="fill" className="size-4 text-muted-foreground" />
          <h1 className="text-sm font-semibold">Automations</h1>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border bg-rail/30 p-1">
          <ViewChoice
            view={view}
            value="details"
            label="Automations"
            icon={ListBulletsIcon}
            onChange={setView}
          />
          <ViewChoice
            view={view}
            value="lanes"
            label="Lanes"
            icon={KanbanIcon}
            onChange={setView}
          />
        </div>
        <Button size="sm" onClick={createAutomation}>
          <PlusIcon />
          New Automation
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <AutomationRail
          project={projectAutomations}
          global={globalAutomations}
          enabledIds={enabledIds}
          selectedId={selectedAutomation?.id ?? null}
          creating={target?.automation === null}
          onSelect={selectAutomation}
          onCreate={createAutomation}
        />
        {view === "lanes" ? (
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6">
            {automations.length === 0 ? (
              <EmptyAutomations onCreate={createAutomation} />
            ) : (
              <AutomationLanes projectId={projectId} />
            )}
          </div>
        ) : target !== null ? (
          <AutomationEditorPanel
            key={`${target.automation?.id ?? "new"}:${target.automation?.updatedAt ?? 0}`}
            projectId={projectId}
            automation={selectedAutomation}
            actions={editorActions}
            history={
              selectedAutomation === null ? undefined : (
                <RunHistory
                  projectId={projectId}
                  ticketPrefix={ticketPrefix}
                  runs={runs}
                  skips={skips}
                />
              )
            }
          />
        ) : (
          <EmptyAutomations
            onCreate={createAutomation}
            history={
              <RunHistory
                projectId={projectId}
                ticketPrefix={ticketPrefix}
                runs={runs}
                skips={skips}
              />
            }
          />
        )}
      </div>

      {choosingTicket === null ? null : (
        <RunOnTicketDialog
          open
          onOpenChange={(open) => (open ? undefined : setChoosingTicket(null))}
          projectId={projectId}
          ticketPrefix={ticketPrefix}
          automation={choosingTicket}
        />
      )}

      <AlertDialog
        open={confirmingDelete !== null}
        onOpenChange={(open) => (open ? undefined : setConfirmingDelete(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{confirmingDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Its past Runs stay in history, but this Automation cannot be run again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (confirmingDelete !== null) void remove(projectId, confirmingDelete);
                setConfirmingDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AutomationRail({
  project,
  global,
  enabledIds,
  selectedId,
  creating,
  onSelect,
  onCreate,
}: {
  project: readonly Automation[];
  global: readonly Automation[];
  enabledIds: readonly string[];
  selectedId: string | null;
  creating: boolean;
  onSelect(automation: Automation): void;
  onCreate(): void;
}) {
  const groups = [
    { label: "This project", automations: project },
    { label: "All projects", automations: global },
  ] as const;
  return (
    <aside className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-border bg-rail/30 p-2">
      {creating ? (
        <div className="mb-2 rounded-lg bg-accent px-2 py-2 text-ui font-medium text-foreground">
          New Automation
        </div>
      ) : null}
      {groups.map((group) => (
        <section key={group.label} className="flex flex-col gap-1 pb-4">
          <div className="flex h-6 items-center px-2">
            <h2 className="text-label text-muted-foreground uppercase">{group.label}</h2>
            <button
              type="button"
              aria-label={`New automation in ${group.label}`}
              onClick={onCreate}
              className="ml-auto grid size-5 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45"
            >
              <PlusIcon weight="bold" className="size-3" />
            </button>
          </div>
          {group.automations.length === 0 ? (
            <p className="px-2 py-1 text-label text-muted-foreground">Nothing here</p>
          ) : (
            group.automations.map((automation) => (
              <button
                key={automation.id}
                type="button"
                data-automation-rail-row={automation.id}
                aria-current={automation.id === selectedId ? "page" : undefined}
                onClick={() => onSelect(automation)}
                className={cn(
                  "flex w-full flex-col gap-1 rounded-lg px-2 py-2 text-left outline-none",
                  "focus-visible:ring-2 focus-visible:ring-ring/45",
                  automation.id === selectedId
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/50",
                )}
              >
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-ui font-medium">
                    {automation.name}
                  </span>
                  <span
                    aria-label={enabledIds.includes(automation.id) ? "Enabled" : "Switched off"}
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      enabledIds.includes(automation.id) ? "bg-primary" : "border border-border",
                    )}
                  />
                </span>
                <span className="w-full truncate text-label text-muted-foreground">
                  {triggerLabel(automation.trigger)} · {runtimeLabel(automation.runtime)}
                </span>
              </button>
            ))
          )}
        </section>
      ))}
    </aside>
  );
}

function EmptyAutomations({ onCreate, history }: { onCreate(): void; history?: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="grid min-h-64 flex-1 place-items-center p-6">
        <div className="flex max-w-sm flex-col items-center gap-4 text-center">
          <LightningIcon className="size-5 text-muted-foreground" />
          <div>
            <h2 className="text-heading font-semibold">Nothing saved yet</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Save a way of starting work, then run it by hand or give it a Trigger.
            </p>
          </div>
          <Button size="sm" onClick={onCreate}>
            <PlusIcon />
            New Automation
          </Button>
        </div>
      </div>
      {history === undefined ? null : (
        <div className="mx-auto w-full max-w-content px-6 pb-6">{history}</div>
      )}
    </div>
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
              <p className="py-2 text-ui text-muted-foreground">No tickets here.</p>
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
        <p className="py-2 text-ui text-muted-foreground">Nothing has run in this project yet.</p>
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
      data-run-history-skip={skip.id}
      // Inert as a row: a skip opened no Session, so there is nowhere for the
      // row itself to go. Its one act is the control, which is why the control
      // is on it rather than a click nothing would answer.
      onActivate={null}
      leading={<ClockCounterClockwiseIcon className="size-4 text-muted-foreground" />}
      primary={
        <span className="flex min-w-0 items-center gap-1 text-ui">
          <span className="shrink-0 text-foreground">{skip.automationName}</span>
          <span aria-hidden className="text-muted-foreground">
            ·
          </span>
          <span className="truncate text-muted-foreground">{skipReasonLabel(skip)}</span>
          {count === "" ? null : (
            <>
              <span aria-hidden className="text-muted-foreground">
                ·
              </span>
              <span className="shrink-0 text-muted-foreground">{count}</span>
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
      // The door back to the Session the Run opened, always. A Run whose
      // Ticket is gone kept its Session and its place in this history, so it
      // opens in Home — the project's own home for a Session no Ticket owns —
      // rather than going inert.
      onActivate={() =>
        openRunSession({ sessionId: run.sessionId, projectId, ticketId: run.ticketId })
      }
      leading={<LightningIcon className="size-4 text-muted-foreground" />}
      primary={
        <span className="flex min-w-0 items-center gap-1 text-ui" title={runModelTitle(run)}>
          <span className="shrink-0 text-foreground">{runAutomationLabel(run)}</span>
          {ticketNumber === undefined ? null : (
            <>
              <span aria-hidden className="text-muted-foreground">
                ·
              </span>
              <span className="shrink-0 font-mono text-label text-muted-foreground">
                {displayTicketId(ticketPrefix, ticketNumber)}
              </span>
            </>
          )}
          <span aria-hidden className="text-muted-foreground">
            ·
          </span>
          {/* The RESOLVED model this Session was born with, printed from the
              Run's own row — never re-labelled through today's catalogue. */}
          <span className="truncate text-muted-foreground">{runModelLabel(run)}</span>
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
