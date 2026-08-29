/**
 * The Automations page (VC-127): a fourth nav destination beside Home and
 * Configure, and **the only surface in the app that authors an Automation**.
 * Every other surface — the board card menu, the ticket rail, the command
 * palette — merely runs one.
 *
 * It is a nav page rather than a room inside Home on purpose: `nav-list.tsx`
 * carries the guardrail that Home must not become a junk drawer, and VC-112
 * names this page as the fourth `NavKey` for that reason.
 *
 * A FLAT LIST, deliberately. VC-112's eventual drawing is one lane per column
 * holding that column's Offered list in digit order; that layout belongs to
 * the ticket that owns per-column ordering (VC-132), and building a lane view
 * before columns can be a Trigger would be drawing lanes with nothing to put
 * in them. What this page owes today is the whole record lifecycle — create,
 * edit, duplicate, enable, disable, delete — and the Run history.
 *
 * Two rows of vocabulary worth stating once, because both are load-bearing:
 *
 *  - **The switch is machine-local.** Enabling and disabling never travels
 *    with the project (VC-112 puts an Automation's shareable half in git as a
 *    Skill and keeps the record local; the switch is more local still). It
 *    governs what starts an Automation BESIDES a person — running by hand
 *    stays universal, so a disabled row is still runnable from every surface
 *    that lists it.
 *  - **Delete is a record delete.** There is no archive, and that is a ruling
 *    rather than an omission: for a Skill, git is already the archive.
 */
import * as React from "react";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";

import { displayTicketId, type Automation, type AutomationRun } from "@volli/shared";

import {
  MANUAL_TRIGGER_LABEL,
  groupByOwnership,
  runAutomationLabel,
  runDoor,
  runModelLabel,
  runModelTitle,
  runtimeLabel,
} from "./automations-page-model";
import { openRunSession } from "./run-automation";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { EMPTY_PAGE } from "@renderer/components/ui/empty-classes";
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
  const openEditor = useAutomationsStore((state) => state.openEditor);
  const refresh = useAutomationsStore((state) => state.refresh);
  const refreshRuns = useAutomationsStore((state) => state.refreshRuns);
  const refreshEnablement = useAutomationsStore((state) => state.refreshEnablement);

  // Read on arrival rather than subscribed: the record moves only through this
  // app's own doors, and opening the page IS the moment staleness would show.
  // The planning-change version is in the deps so a Run started elsewhere —
  // the palette, the board — lands in the history without a manual reload.
  const planningVersion = useBoardStore((state) => state.lastPlanningChange.version);
  React.useEffect(() => {
    void refresh(projectId);
    void refreshRuns(projectId);
    void refreshEnablement();
  }, [projectId, planningVersion, refresh, refreshRuns, refreshEnablement]);

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
      <div className="flex flex-col gap-6 px-gutter pb-10">
        {automations.length === 0 ? (
          <EmptyAutomations projectId={projectId} />
        ) : (
          <>
            <AutomationSection
              title="This project"
              projectId={projectId}
              automations={owned}
              emptyNote="Nothing yet in this project."
            />
            <AutomationSection
              title="All projects"
              projectId={projectId}
              automations={global}
              emptyNote="Nothing shared across every project."
            />
          </>
        )}
        <RunHistory projectId={projectId} ticketPrefix={ticketPrefix} runs={runs} />
      </div>
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
    <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-border px-4 py-6">
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
  automations,
  emptyNote,
}: {
  title: string;
  projectId: string;
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
          <AutomationRowItem key={automation.id} projectId={projectId} automation={automation} />
        ))
      )}
    </section>
  );
}

function AutomationRowItem({
  projectId,
  automation,
}: {
  projectId: string;
  automation: Automation;
}) {
  const disabled = useAutomationsStore((state) => state.disabledIds.includes(automation.id));
  const editAutomation = useAutomationsStore((state) => state.editAutomation);
  const duplicate = useAutomationsStore((state) => state.duplicate);
  const setEnabled = useAutomationsStore((state) => state.setEnabled);
  const remove = useAutomationsStore((state) => state.remove);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);

  return (
    <>
      <ListRow
        density="two-line"
        // The row's own activation is Edit: this is the authoring surface, so
        // opening an Automation means opening its form.
        onActivate={() => editAutomation(projectId, automation)}
        leading={
          <LightningIcon
            className={cn("size-4", disabled ? "text-muted-foreground" : "text-foreground")}
          />
        }
        primary={
          <span className={disabled ? "text-muted-foreground" : undefined}>{automation.name}</span>
        }
        secondary={
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{MANUAL_TRIGGER_LABEL}</span>
            <span aria-hidden>·</span>
            <span className="truncate">{runtimeLabel(automation.runtime)}</span>
            {disabled ? (
              <>
                <span aria-hidden>·</span>
                {/* What being off actually MEANS, said once where it is true:
                    by-hand Runs stay universal (VC-112). */}
                <span className="shrink-0">Won&rsquo;t start on its own</span>
              </>
            ) : null}
          </span>
        }
        actions={
          <div className="flex items-center gap-1">
            <Switch
              checked={!disabled}
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
 * Run history, newest first. Each Run names its Automation and the model and
 * reasoning it RESOLVED at launch, and is a door back to its Session — which
 * is the whole reason a Run is a record and not a log line.
 */
function RunHistory({
  projectId,
  ticketPrefix,
  runs,
}: {
  projectId: string;
  ticketPrefix: string;
  runs: readonly AutomationRun[];
}) {
  return (
    <section className="flex flex-col gap-1">
      <SectionHeading className="h-6 leading-6">Runs</SectionHeading>
      {runs.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">Nothing has run in this project yet.</p>
      ) : (
        runs.map((run) => (
          <RunRow key={run.id} projectId={projectId} ticketPrefix={ticketPrefix} run={run} />
        ))
      )}
    </section>
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
  const door = runDoor(run);
  const ticketNumber = useBoardStore(
    (state) =>
      state.ticketsByProject[projectId]?.find((candidate) => candidate.id === run.ticketId)
        ?.ticketNumber,
  );

  return (
    <ListRow
      density="two-line"
      // The door back to the Session the Run opened. A Run whose Ticket is
      // gone states itself and stops being clickable rather than navigating
      // into a workspace that no longer exists.
      onActivate={door === null ? null : () => void openRunSession({ ...door, projectId })}
      leading={<LightningIcon className="size-4 text-muted-foreground" />}
      primary={runAutomationLabel(run)}
      secondary={
        <span className="flex min-w-0 items-center gap-1.5" title={runModelTitle(run)}>
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
