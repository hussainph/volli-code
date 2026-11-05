/** The one authoring page. Listing, column rank and history share the existing store doors. */
import * as React from "react";
import {
  AutomationIcon,
  CopyIcon,
  MoreIcon,
  BoardIcon,
  PlayIcon,
  AddIcon,
  HistoryIcon,
  DeleteIcon,
  ClockIcon,
  GlobeIcon,
  ChevronDownIcon,
  ArrowLeftIcon,
  EditIcon,
} from "@renderer/components/ui/icon";
import { effortLabel } from "@volli/session-presentation";
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
  groupByTrigger,
  listingRunTarget,
  runAutomationLabel,
  runStartLabel,
  skipCountLabel,
  skipReasonLabel,
  triggerLabel,
  nextScheduledRun,
} from "./automations-page-model";
import { AutomationEditorPanel } from "./automation-editor";
import {
  clearEditorDraft,
  loadEditorDraft,
  saveEditorDraft,
  type AutomationEditorDraft,
} from "./editor-draft";
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
import { ResolvedModelName } from "@renderer/components/models/resolved-model-name";
import { Button } from "@renderer/components/ui/button";
import { ButtonGroup } from "@renderer/components/ui/button-group";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { PageHeader } from "@renderer/components/layout/page-header";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { PaperSurface } from "@renderer/components/ui/surface";
import { Input } from "@renderer/components/ui/input";
import { ListRow } from "@renderer/components/ui/list-row";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { useCanWrite, guardWrite } from "@renderer/components/hosts/use-hosts";
import { relativeTime } from "@renderer/lib/relative-time";
import { useAgeNow } from "@renderer/lib/use-age-now";
import {
  automationHistoryKey,
  selectAutomationRuns,
  selectAutomationSkips,
  useAutomationsStore,
} from "@renderer/stores/automations";
import { useBoardStore } from "@renderer/stores/board";
import { automationSourceIsCloud } from "@renderer/stores/automation-source";
import { useCloudAutomationsStore } from "@renderer/stores/cloud-automations/state";
import { CloudRunHistory } from "./cloud-run-history";
import { AutomationRuntimeValue } from "./automation-runtime-value";
import { Command, CommandInput, CommandList, CommandItem } from "@renderer/components/ui/command";
import { EmptyState } from "./empty-state";
import "./automations.css";
const NO_AUTOMATIONS: readonly Automation[] = [];
const NO_RUNS: readonly AutomationRun[] = [];
const NO_SKIPS: readonly AutomationSkippedOccurrence[] = [];
const NO_TICKETS: readonly Ticket[] = [];

const EXAMPLES: readonly Pick<
  AutomationEditorDraft,
  "name" | "instructions" | "triggerChoice" | "columns"
>[] = [
  {
    name: "Morning review",
    instructions: "/code-review\nFind regressions merged since yesterday.",
    triggerChoice: "schedule",
    columns: [],
  },
  {
    name: "Implement ticket",
    instructions: "/implement\nImplement the ticket and verify it with focused checks.",
    triggerChoice: "columns",
    columns: ["doing"],
  },
  {
    name: "Triage ticket",
    instructions: "/triage\nFind the smallest next step.",
    triggerChoice: "none",
    columns: [],
  },
];

export function AutomationsPage() {
  const project = useSelectedProject();
  if (project === null)
    return (
      <div className="grid flex-1 place-items-center text-ui text-muted-foreground">
        No project selected
      </div>
    );
  return (
    <AutomationsSurface
      key={project.id}
      projectId={project.id}
      projectName={project.name}
      ticketPrefix={project.ticketPrefix}
    />
  );
}
type PageView = "details" | "columns" | "history" | "runs";
function AutomationsSurface({
  projectId,
  projectName,
  ticketPrefix,
}: {
  projectId: string;
  projectName: string;
  ticketPrefix: string;
}) {
  const automations = useAutomationsStore((s) => s.byProject[projectId] ?? NO_AUTOMATIONS);
  const loaded = useAutomationsStore((s) => s.byProject[projectId] !== undefined);
  const editor = useAutomationsStore((s) => s.editor);
  const refreshRail = useAutomationsStore((s) => s.refreshRail);
  const editAutomation = useAutomationsStore((s) => s.editAutomation);
  const openEditor = useAutomationsStore((s) => s.openEditor);
  const closeEditor = useAutomationsStore((s) => s.closeEditor);
  const duplicate = useAutomationsStore((s) => s.duplicate);
  const remove = useAutomationsStore((s) => s.remove);
  const version = useBoardStore((s) => s.lastPlanningChange.version);
  const canWrite = useCanWrite(projectId);
  const [view, setView] = React.useState<PageView>("details");
  const [detail, setDetail] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [read, setRead] = React.useState<"loading" | "ready" | "failed">("loading");
  const [retry, setRetry] = React.useState(0);
  const [pending, setPending] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const startLock = React.useRef(false);
  const pendingRef = React.useRef(false);
  const [newDraftVersion, setNewDraftVersion] = React.useState(0);
  const [renameRequest, setRenameRequest] = React.useState(0);
  const [choosingTicket, setChoosingTicket] = React.useState<Automation | null>(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState<Automation | null>(null);
  const resume = React.useRef(loadEditorDraft(projectId) !== null);
  React.useEffect(() => {
    let current = true;
    setRead("loading");
    void refreshRail(projectId, version).then((ok) => {
      if (current) setRead(ok ? "ready" : "failed");
    });
    return () => {
      current = false;
    };
  }, [projectId, version, refreshRail, retry]);
  React.useEffect(() => closeEditor, [closeEditor]);
  React.useEffect(() => {
    if (resume.current) {
      resume.current = false;
      openEditor(projectId);
      setDetail(true);
      return;
    }
    if (
      editor?.projectId === projectId &&
      (editor.automation === null || automations.some((a) => a.id === editor.automation?.id))
    )
      return;
    if (automations[0]) editAutomation(projectId, automations[0]);
  }, [automations, editor, editAutomation, openEditor, projectId]);
  const target = editor?.projectId === projectId ? editor : null;
  const selected =
    target?.automation == null
      ? null
      : (automations.find((a) => a.id === target.automation?.id) ?? target.automation);
  const writable = canWrite && read === "ready" && !pending && !starting;
  function select(automation: Automation) {
    editAutomation(projectId, automation);
    setView("details");
    setDetail(true);
  }
  function create() {
    if (!writable || !guardWrite(projectId)) return;
    openEditor(projectId);
    setView("details");
    setDetail(true);
  }
  function back() {
    setView("details");
    setDetail(false);
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-automation-rail-row="${selected?.id}"]`)?.focus(),
    );
  }
  function run(automation: Automation) {
    if (!writable || !guardWrite(projectId)) return;
    if (listingRunTarget(automation) === "project") {
      if (startLock.current) return;
      startLock.current = true;
      setStarting(true);
      void runAutomationForProject({
        automationId: automation.id,
        automationName: automation.name,
        projectId,
      }).finally(() => {
        startLock.current = false;
        setStarting(false);
      });
    } else setChoosingTicket(automation);
  }
  async function mutate(action: () => Promise<unknown>) {
    if (pendingRef.current || !writable || !guardWrite(projectId)) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await action();
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  function example(starter: (typeof EXAMPLES)[number]) {
    if (!writable) return;
    // Examples are create drafts, never accepted records. Do not overwrite a saved draft.
    if (loadEditorDraft(projectId) !== null) {
      create();
      return;
    }
    saveEditorDraft(projectId, {
      ...starter,
      ownership: "project",
      schedule:
        starter.triggerChoice === "schedule"
          ? { preset: "weekdays", hour: 9, minute: 0, timeZone: "Asia/Kuwait" }
          : {
              preset: "daily",
              hour: 9,
              minute: 0,
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
      runtime: null,
    });
    setNewDraftVersion((revision) => revision + 1);
    create();
  }
  const actions =
    selected === null ? null : (
      <>
        <Button
          variant="outline"
          size="sm"
          disabled={!writable}
          aria-label={`Run ${selected.name}`}
          onClick={() => run(selected)}
        >
          <PlayIcon />
          {starting ? "Starting…" : "Run"}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" disabled={!writable} aria-label="More actions">
              <MoreIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setRenameRequest((n) => n + 1)}>
              <EditIcon />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void mutate(() => duplicate(projectId, selected))}>
              <CopyIcon />
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>
              Target · {selected.trigger.kind === "schedule" ? projectName : "Ticket"}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirmingDelete(selected)}>
              <DeleteIcon />
              Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    );
  return (
    <PaperSurface
      className="automations-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-detail={detail}
    >
      <PageHeader
        title="Automations"
        className="min-h-16 border-b border-border"
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Columns"
              onClick={() => setView("columns")}
            >
              <BoardIcon />
              <span className="automation-header-word">Columns</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="History"
              onClick={() => setView("history")}
            >
              <HistoryIcon />
              <span className="automation-header-word">History</span>
            </Button>
            <ButtonGroup>
              <Button size="sm" disabled={!writable} onClick={create}>
                <AddIcon />
                {target?.automation !== null && loadEditorDraft(projectId) !== null
                  ? "Resume draft"
                  : "New automation"}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" disabled={!writable} aria-label="New automation menu">
                    <ChevronDownIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Examples</DropdownMenuLabel>
                  {EXAMPLES.map((starter) => (
                    <DropdownMenuItem key={starter.name} onSelect={() => example(starter)}>
                      <AutomationIcon />
                      {starter.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </ButtonGroup>
          </>
        }
      />
      {read === "failed" && loaded ? (
        <div className="flex items-center gap-2 border-b border-border px-gutter py-2">
          <span role="alert" className="text-ui">
            Couldn’t refresh automations
          </span>
          <Button size="sm" variant="outline" onClick={() => setRetry((n) => n + 1)}>
            Retry
          </Button>
        </div>
      ) : null}
      {!loaded ? (
        <div className="grid min-h-0 flex-1 place-items-center">
          {read === "failed" ? (
            <EmptyState
              tier="page"
              illustration="failed"
              title="Couldn’t load automations"
              accessibleLabel="Automations"
              status="failed"
              action={{ label: "Retry", onAction: () => setRetry((n) => n + 1) }}
            />
          ) : (
            <p role="status" aria-busy="true" className="text-ui text-muted-foreground">
              Loading automations…
            </p>
          )}
        </div>
      ) : view === "columns" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ContentColumn className="py-6">
            <Button size="sm" variant="ghost" onClick={back}>
              <ArrowLeftIcon />
              Automations
            </Button>
            <AutomationLanes projectId={projectId} onSelect={select} disabled={!writable} />
          </ContentColumn>
        </div>
      ) : view === "history" || view === "runs" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ContentColumn className="py-6">
            <Button size="sm" variant="ghost" onClick={back}>
              <ArrowLeftIcon />
              Automations
            </Button>
            <HistorySurface
              key={view === "history" ? "project" : selected?.id}
              projectId={projectId}
              ticketPrefix={ticketPrefix}
              automationId={view === "runs" ? (selected?.id ?? null) : null}
              disabled={!writable}
              name={view === "runs" ? selected?.name : undefined}
              onScope={(id) => {
                if (id === "all") setView("history");
                else {
                  const row = automations.find((a) => a.id === id);
                  if (row) {
                    editAutomation(projectId, row);
                    setView("runs");
                  }
                }
              }}
            />
          </ContentColumn>
        </div>
      ) : automations.length === 0 && target === null ? (
        <div className="grid min-h-0 flex-1 place-items-center">
          <EmptyState
            tier="page"
            illustration="automation"
            title="No automations yet"
            accessibleLabel="Automations"
            action={{
              label: "New automation",
              onAction: create,
              disabled: !writable,
              icon: <AddIcon />,
            }}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <AutomationList
            automations={automations}
            selectedId={selected?.id ?? null}
            query={query}
            onQuery={setQuery}
            onSelect={select}
            onRun={run}
            disabled={!writable}
            coherent={read === "ready"}
            projectId={projectId}
          />
          <div className="automation-detail flex min-h-0 min-w-0 flex-1 flex-col">
            {target === null ? (
              <p className="p-gutter text-ui">Loading automation…</p>
            ) : (
              <AutomationEditorPanel
                key={selected?.id ?? `new:${newDraftVersion}`}
                projectId={projectId}
                automation={selected}
                actions={actions}
                disabled={!writable}
                renameRequest={renameRequest}
                readState={read}
                back={
                  <Button size="sm" variant="ghost" className="automation-back mb-4" onClick={back}>
                    <ArrowLeftIcon />
                    Automations
                  </Button>
                }
                onDiscardedNewDraft={() => {
                  if (automations[0]) editAutomation(projectId, automations[0]);
                  else closeEditor();
                  setDetail(false);
                }}
                history={
                  selected === null ? undefined : (
                    <HistorySurface
                      key={selected.id}
                      projectId={projectId}
                      ticketPrefix={ticketPrefix}
                      automationId={selected.id}
                      disabled={!writable}
                      recent
                      onAll={() => setView("runs")}
                    />
                  )
                }
              />
            )}
          </div>
        </div>
      )}
      {choosingTicket && (
        <RunOnTicketDialog
          open
          onOpenChange={(open) => {
            if (!open) setChoosingTicket(null);
          }}
          projectId={projectId}
          ticketPrefix={ticketPrefix}
          automation={choosingTicket}
        />
      )}
      <AlertDialog
        open={confirmingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{confirmingDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>Past runs and Sessions stay in history.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!writable}
              onClick={() => {
                const row = confirmingDelete;
                if (row)
                  void mutate(async () => {
                    await remove(projectId, row);
                    if (
                      !useAutomationsStore
                        .getState()
                        .byProject[projectId]?.some((a) => a.id === row.id)
                    )
                      clearEditorDraft(projectId, undefined, row.id);
                  });
                setConfirmingDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PaperSurface>
  );
}
function AutomationList({
  automations,
  selectedId,
  query,
  onQuery,
  onSelect,
  onRun,
  disabled,
  coherent,
  projectId,
}: {
  automations: readonly Automation[];
  selectedId: string | null;
  query: string;
  onQuery(value: string): void;
  onSelect(row: Automation): void;
  onRun(row: Automation): void;
  disabled: boolean;
  coherent: boolean;
  projectId: string;
}) {
  const groups = React.useMemo(() => groupByTrigger(automations, query), [automations, query]);
  return (
    <aside
      className="automation-master flex min-h-0 shrink-0 flex-col border-r border-border bg-muted/30"
      aria-label="Automations"
    >
      {automations.length > 8 || query !== "" ? (
        <div className="p-3">
          <Input
            aria-label="Filter automations"
            placeholder="Filter automations"
            value={query}
            onChange={(e) => onQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                onQuery("");
              }
            }}
          />
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {groups.every((g) => g.automations.length === 0) ? (
          <p className="p-2 text-ui text-muted-foreground">No matching automations</p>
        ) : (
          groups
            .filter((g) => g.automations.length > 0)
            .map((group) => (
              <section key={group.kind} className="mb-4">
                <SectionHeading as="h3" className="flex items-center justify-between px-2 py-2">
                  {group.label}
                  <span className="text-label text-muted-foreground tabular-nums">
                    {group.automations.length}
                  </span>
                </SectionHeading>
                <ul>
                  {group.automations.map((row) => (
                    <li key={row.id}>
                      <ListRow
                        data-automation-rail-row={row.id}
                        aria-current={row.id === selectedId ? "page" : undefined}
                        aria-label={row.name}
                        aria-describedby={
                          row.trigger.kind === "none" || !coherent
                            ? undefined
                            : `automation-fact-${row.id}`
                        }
                        selected={row.id === selectedId}
                        onActivate={() => onSelect(row)}
                        leading={
                          row.trigger.kind === "schedule" ? (
                            <ClockIcon className="size-4 shrink-0 text-muted-foreground" />
                          ) : (
                            <AutomationIcon className="size-4 shrink-0 text-muted-foreground" />
                          )
                        }
                        primary={
                          <span className="line-clamp-2 min-w-0 text-ui font-medium wrap-anywhere">
                            {row.name}
                          </span>
                        }
                        primaryTrailing={
                          row.projectId === null ? (
                            <span role="img" aria-label="All projects">
                              <GlobeIcon className="size-3 shrink-0 text-muted-foreground" />
                            </span>
                          ) : undefined
                        }
                        secondary={triggerLabel(row.trigger)}
                        trailing={
                          coherent ? (
                            <AutomationListFact automation={row} projectId={projectId} />
                          ) : undefined
                        }
                        actions={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={disabled}
                            className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                            aria-label={`Run ${row.name}`}
                            onClick={() => onRun(row)}
                          >
                            <PlayIcon />
                          </Button>
                        }
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))
        )}
      </div>
    </aside>
  );
}

/** One factual value at the row edge; no synthetic Run outcome or trigger provenance. */
function AutomationListFact({
  automation,
  projectId,
}: {
  automation: Automation;
  projectId: string;
}) {
  const enabled = useAutomationsStore((s) => s.enabledIds.includes(automation.id));
  const armings = useAutomationsStore((s) => s.armingByProject[projectId]);
  const cloudSchedule = useCloudAutomationsStore((s) =>
    s.schedules[projectId]?.find((row) => row.automationId === automation.id),
  );
  const [now] = React.useState(() => Date.now());
  if (automation.trigger.kind === "none") return null;
  let fact: string | null = null;
  if (automationSourceIsCloud()) {
    if (cloudSchedule?.pausedAt != null) fact = "Paused";
  } else if (!enabled) fact = "Manual only";
  else if (
    automation.trigger.kind === "columns" &&
    armings?.some(
      (a) =>
        a.automationId === automation.id &&
        automation.trigger.kind === "columns" &&
        automation.trigger.columns.includes(a.status),
    )
  )
    fact = "Armed";
  const schedule = automation.trigger.kind === "schedule" ? automation.trigger.schedule : null;
  const next =
    schedule !== null &&
    (automationSourceIsCloud()
      ? cloudSchedule !== undefined && cloudSchedule.pausedAt === null
      : enabled)
      ? automationSourceIsCloud()
        ? cloudSchedule!.nextFireAt
        : nextScheduledRun({
            schedule,
            automationId: automation.id,
            now,
            timeZone: schedule.timeZone,
          }).at
      : null;
  if (next !== null && schedule !== null)
    return (
      <span
        id={`automation-fact-${automation.id}`}
        className="shrink-0 text-label text-muted-foreground tabular-nums"
      >
        <span aria-hidden>
          {new Date(next).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
            timeZone: schedule.timeZone,
          })}
        </span>
        <span className="sr-only">
          Next run {new Date(next).toLocaleString(undefined, { timeZone: schedule.timeZone })} ·{" "}
          {schedule.timeZone}
        </span>
      </span>
    );
  return (
    <span
      id={`automation-fact-${automation.id}`}
      className="max-w-16 shrink-0 text-right text-label text-muted-foreground"
    >
      {fact}
    </span>
  );
}

/** Scoped reads stay scoped, including when a global record is selected. */
function HistorySurface({
  projectId,
  ticketPrefix,
  automationId,
  recent = false,
  onAll,
  name,
  onScope,
  disabled = false,
}: {
  projectId: string;
  ticketPrefix: string;
  automationId: string | null;
  recent?: boolean;
  onAll?(): void;
  name?: string;
  onScope?(id: string): void;
  disabled?: boolean;
}) {
  const runs = useAutomationsStore((s) =>
    automationId === null
      ? (s.runsByProject[projectId] ?? NO_RUNS)
      : selectAutomationRuns(s, projectId, automationId),
  );
  const skips = useAutomationsStore((s) =>
    automationId === null
      ? (s.skipsByProject[projectId] ?? NO_SKIPS)
      : selectAutomationSkips(s, projectId, automationId),
  );
  const loaded = useAutomationsStore((s) =>
    automationId === null
      ? s.runsByProject[projectId] !== undefined && s.skipsByProject[projectId] !== undefined
      : s.runsByAutomation[automationHistoryKey(projectId, automationId)] !== undefined,
  );
  const rows = useAutomationsStore((s) => s.byProject[projectId] ?? NO_AUTOMATIONS);
  const version = useBoardStore((s) => s.lastPlanningChange.version);
  const [retry, setRetry] = React.useState(0);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let current = true;
    setFailed(false);
    const store = useAutomationsStore.getState();
    const request =
      automationId === null
        ? Promise.all([store.refreshRuns(projectId), store.refreshSkips(projectId)]).then((r) =>
            r.every(Boolean),
          )
        : store.refreshAutomationHistory(projectId, automationId);
    void request.then((ok) => {
      if (current) setFailed(!ok);
    });
    return () => {
      current = false;
    };
  }, [automationId, projectId, version, retry]);
  return (
    <section className="mt-5 min-w-0" data-run-history={automationId ?? "project"}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <SectionHeading as={recent ? "h3" : "h2"}>
          {recent
            ? "Recent runs"
            : automationId === null
              ? "History"
              : `Runs${name ? ` · ${name}` : ""}`}
        </SectionHeading>
        {recent ? (
          <Button size="sm" variant="ghost" onClick={onAll}>
            All runs
          </Button>
        ) : onScope ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                {name ?? "All automations"}
                <ChevronDownIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => onScope("all")}>
                <HistoryIcon />
                All automations
              </DropdownMenuItem>
              {rows.map((row) => (
                <DropdownMenuItem key={row.id} onSelect={() => onScope(row.id)}>
                  <AutomationIcon />
                  {row.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {failed ? (
        <div className="flex items-center gap-2">
          <span role="alert" className="text-ui">
            Couldn’t load runs
          </span>
          <Button size="sm" variant="outline" onClick={() => setRetry((n) => n + 1)}>
            Retry
          </Button>
        </div>
      ) : null}
      {failed && !loaded ? null : automationSourceIsCloud() ? (
        <CloudRunHistory projectId={projectId} automationId={automationId} recent={recent} />
      ) : !loaded && !failed ? (
        <p role="status" aria-busy="true" className="text-ui text-muted-foreground">
          Loading runs…
        </p>
      ) : (
        <LocalRunHistory
          projectId={projectId}
          ticketPrefix={ticketPrefix}
          runs={runs}
          skips={skips}
          loaded={loaded}
          limit={recent ? 3 : undefined}
          disabled={disabled || failed}
        />
      )}
    </section>
  );
}

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

  const [selected, setSelected] = React.useState("");
  const [starting, setStarting] = React.useState(false);
  const lock = React.useRef(false);
  const canWrite = useCanWrite(projectId);
  const selectedTicket = matches.find((ticket) => ticket.id === selected);
  async function start() {
    if (lock.current || selectedTicket === undefined || !guardWrite(projectId)) return;
    lock.current = true;
    setStarting(true);
    try {
      const outcome = await runAutomationOnTicket({
        target: { kind: "automation", automationId: automation.id },
        automationName: automation.name,
        ticketId: selectedTicket.id,
        ticketDisplayId: displayTicketId(ticketPrefix, selectedTicket.ticketNumber),
        modelOverride: null,
      });
      if (outcome !== "failed" && outcome !== "refused") onOpenChange(false);
    } finally {
      lock.current = false;
      setStarting(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!starting) onOpenChange(value);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Run “{automation.name}” on</DialogTitle>
        </DialogHeader>
        <AutomationRuntimeValue
          runtime={automation.runtime}
          projectId={projectId}
          projectTarget={false}
        />
        <Command
          shouldFilter={false}
          value={selected}
          onValueChange={setSelected}
          onKeyDown={(e) => {
            if (e.key === "Enter" && selectedTicket) {
              e.preventDefault();
              void start();
            }
          }}
        >
          <CommandInput
            autoFocus
            aria-label="Find a ticket"
            placeholder="Find a ticket"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {matches.length === 0 ? (
              <p className="p-3 text-ui text-muted-foreground">No matching tickets</p>
            ) : (
              matches.map((ticket) => (
                <CommandItem
                  key={ticket.id}
                  value={ticket.id}
                  disabled={starting}
                  onSelect={() => setSelected(ticket.id)}
                >
                  <span className="shrink-0 font-mono text-label text-muted-foreground">
                    {displayTicketId(ticketPrefix, ticket.ticketNumber)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{ticket.title}</span>
                  <span className="text-label text-muted-foreground">
                    {TICKET_STATUS_LABELS[ticket.status]}
                  </span>
                </CommandItem>
              ))
            )}
          </CommandList>
        </Command>
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={!canWrite || starting || !selectedTicket}
            onClick={() => void start()}
          >
            {starting
              ? "Starting…"
              : selectedTicket
                ? `Run on ${displayTicketId(ticketPrefix, selectedTicket.ticketNumber)}`
                : "Select a ticket"}
          </Button>
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
 *
 * ONE component, TWO scopes, and the scope is on screen (VC-297). Inside the
 * editor it is the selected record's own history and says "Runs"; on the
 * project's own surface it is every record's and says "Project activity".
 * Same rows, same code, because they are one story at two scopes — what must
 * never happen is the narrow heading over the wide list, which is a page
 * telling a reader that a neighbour's work was this record's.
 *
 * The NARROWING is not done here. Each scope is its own read from main
 * (`runsForAutomation` beside `runsForProject`), so this component draws the
 * list it was handed and `automationId` only says which question was asked.
 * A client that filtered a project-wide list here would have to fetch a whole
 * project's history to draw one record's — the read a phone or a browser
 * should never be made to do.
 */
function LocalRunHistory({
  projectId,
  ticketPrefix,
  runs,
  skips,
  loaded,
  limit,
  disabled,
}: {
  projectId: string;
  ticketPrefix: string;
  /** Already scoped by main to whatever {@link automationId} names. */
  runs: readonly AutomationRun[];
  skips: readonly AutomationSkippedOccurrence[];
  /** Whether this scope's read has LANDED — not whether it found anything. */
  loaded: boolean;
  limit?: number;
  disabled?: boolean;
}) {
  const entries = React.useMemo(() => automationHistory(runs, skips), [runs, skips]);
  const now = useAgeNow(
    entries
      .slice(0, limit)
      .map((entry) => (entry.kind === "run" ? entry.run.createdAt : entry.skip.dueAt)),
  );
  const emptyCopy = loaded ? "No runs yet" : null;
  return (
    <section className="flex flex-col gap-1">
      {entries.length === 0 ? (
        emptyCopy === null ? null : (
          <p className="py-2 text-ui text-muted-foreground">{emptyCopy}</p>
        )
      ) : (
        entries
          .slice(0, limit)
          .map((entry) =>
            entry.kind === "run" ? (
              <RunRow
                key={entry.run.id}
                projectId={projectId}
                ticketPrefix={ticketPrefix}
                run={entry.run}
                now={now}
              />
            ) : (
              <SkippedRow key={entry.skip.id} skip={entry.skip} now={now} disabled={disabled} />
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
 * line, so it can never be mistaken for work that happened.
 *
 * No "how it started" word here, unlike a Run row (VC-297): a Skipped
 * occurrence IS a schedule's missed due time, so it could never have been
 * started by hand, and a mark every row of this kind must carry is a mark that
 * tells the reader nothing. What the row owes is why it was missed, which
 * `skipReasonLabel` says in words.
 *
 * "Run now" starts ONE Run at the Target the schedule would have used — the
 * Project — whatever
 * number of occurrences this row stands for: a missed occurrence is never
 * replayed (VC-112), and this is the by-hand recovery that ruling promises
 * instead.
 */
function SkippedRow({
  skip,
  now,
  disabled,
}: {
  skip: AutomationSkippedOccurrence;
  now: number;
  disabled?: boolean;
}) {
  const canWrite = useCanWrite(skip.projectId);
  const [pending, setPending] = React.useState(false);
  const lock = React.useRef(false);
  const count = skipCountLabel(skip);
  return (
    <ListRow
      data-run-history-skip={skip.id}
      // Inert as a row: a skip opened no Session, so there is nowhere for the
      // row itself to go. Its one act is the control, which is why the control
      // is on it rather than a click nothing would answer.
      onActivate={null}
      leading={<HistoryIcon className="size-4 text-muted-foreground" />}
      primary={skip.automationName}
      secondary={
        // The reason is the record, not optional metadata. Let it wrap below
        // the name rather than truncate to nothing beside the recovery action.
        <span className="block text-ui text-muted-foreground">
          {skipReasonLabel(skip)}
          {count === "" ? null : ` · ${count}`}
        </span>
      }
      actions={
        <Button
          size="sm"
          variant="secondary"
          aria-label={`Run ${skip.automationName} now`}
          disabled={disabled || !canWrite || pending}
          onClick={(event) => {
            event.stopPropagation();
            if (lock.current || disabled || !guardWrite(skip.projectId)) return;
            lock.current = true;
            setPending(true);
            void runAutomationForProject({
              automationId: skip.automationId,
              automationName: skip.automationName,
              projectId: skip.projectId,
            }).finally(() => {
              lock.current = false;
              setPending(false);
            });
          }}
        >
          Run now
        </Button>
      }
      trailing={
        <span className="shrink-0 text-label text-muted-foreground">
          {relativeTime(skip.dueAt, now)}
        </span>
      }
    />
  );
}

function RunRow({
  projectId,
  ticketPrefix,
  run,
  now,
}: {
  projectId: string;
  ticketPrefix: string;
  run: AutomationRun;
  now: number;
}) {
  const ticketNumber = useBoardStore(
    (state) =>
      state.ticketsByProject[projectId]?.find((candidate) => candidate.id === run.ticketId)
        ?.ticketNumber,
  );

  return (
    <ListRow
      data-run-history-run={run.id}
      aria-label={`${runAutomationLabel(run)}, ${runStartLabel(run)}. Open Session`}
      // The door back to the Session the Run opened, always. A Run whose
      // Ticket is gone kept its Session and its place in this history, so it
      // opens in Home — the project's own home for a Session no Ticket owns —
      // rather than going inert.
      onActivate={() =>
        openRunSession({ sessionId: run.sessionId, projectId, ticketId: run.ticketId })
      }
      leading={<AutomationIcon className="size-4 text-muted-foreground" />}
      primary={
        <span className="flex min-w-0 flex-wrap items-center gap-1 text-ui">
          <span className="min-w-0 wrap-anywhere text-foreground">{runAutomationLabel(run)}</span>
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
          {/* The Run's stored model is immutable; the catalogue supplies only
              its display name. Unknown models retain their IDs. Let the shared
              caption wrap rather than clipping it in an ancestor its reveal
              cannot measure. */}
          <span className="min-w-0 text-muted-foreground">
            <ResolvedModelName
              selection={run.model}
              className="max-w-full"
              trailing={
                run.model.reasoningLevel === "off"
                  ? undefined
                  : `${effortLabel(run.model.reasoningLevel)} effort`
              }
            />
          </span>
          <span aria-hidden className="text-muted-foreground">
            ·
          </span>
          {/* How it started (VC-297), from the Run's own attendance rather than
              from the record's Trigger today. `shrink-0` because this is the
              half of the row VC-297 asked to keep visible: the model may
              truncate before it does. */}
          <span className="shrink-0 text-muted-foreground">{runStartLabel(run)}</span>
        </span>
      }
      trailing={
        <span className="shrink-0 text-label text-muted-foreground">
          {relativeTime(run.createdAt, now)}
        </span>
      }
    />
  );
}
