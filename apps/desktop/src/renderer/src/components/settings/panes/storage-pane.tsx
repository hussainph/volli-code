/**
 * Settings → Storage: what Volli keeps on disk, and for how long.
 *
 * Retention and the orphan scan are ONE subject and now sit in one place. They
 * were two categories in two surfaces, which is how a person could set a
 * retention window in Settings → General and then find the folders it governs
 * listed under Settings → Worktrees with nothing connecting them.
 *
 * Both are app-wide by construction: the TTL lives in `app_state`, and
 * `scanOrphans` walks every project in the db — its disk-vs-git pass reports
 * directories git no longer attributes to any project at all, so it cannot be
 * scoped to one. That is why Configure has no copy of this.
 *
 * The two halves answer two different questions and stay separate for that
 * reason (VC-284). Retention governs a TICKET's checkout: automatic reclaim may
 * take an eligible, clean, inactive folder and keeps the ticket, its branch,
 * its pull-request link, and its history — archiving stays a user's own action.
 * An orphan has no ticket to archive, so the only thing that can happen to it
 * is a reviewed, confirmed folder removal.
 */
import * as React from "react";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { BroomIcon } from "@phosphor-icons/react/dist/csr/Broom";
import { DatabaseIcon } from "@phosphor-icons/react/dist/csr/Database";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";
import { errorMessage } from "@volli/shared";

import {
  DATA_EXPORT_ACTION_LABEL,
  DATA_EXPORT_CONFIRM_TITLE,
  DATA_EXPORT_CONTENTS,
  DATA_EXPORT_LIMITS,
} from "../../../../../data-export-copy";
import type {
  DirtyWorktreeOrphan,
  PiSessionOrphanInventory,
  WorktreeTrimScanEntry,
  WorktreeTrimSweepReport,
} from "../../../../../ipc/contract";
import {
  cleanupOutcome,
  cleanupRejectionMessage,
  describeInterrupted,
  describeKept,
  describeKeptMetadata,
  describeMetadata,
  describeRemovable,
  describeRunFailures,
  describeUnreadableProject,
  historyRows,
  isScanStale,
  orphanPolicyNote,
  planCleanup,
  preservationHistoryRows,
  retentionNote,
  runsWithFailures,
  staleScanNote,
  unfinishedRuns,
  type CleanupPlan,
  type OrphansScan,
} from "./storage-orphans-model";
import {
  AsyncSection,
  CommitField,
  ItemRow,
  PrefRow,
  PrefSection,
  RowAction,
  SectionAction,
  SectionIconAction,
  type AsyncState,
  type CommitResult,
} from "@renderer/components/settings/kit";
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
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { Switch } from "@renderer/components/ui/switch";
import { toast } from "sonner";

import { formatFileSize } from "@renderer/components/attachments/attachment-model";
import { RunningProcessesSection } from "./processes-section";
import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import { toastError } from "@renderer/lib/toast";

/** Below a week, an automatic deletion is close enough to ask about. */
const CONFIRM_BELOW_DAYS = 7;

export function StoragePane() {
  // The retention window is what every eligibility date in the orphan list was
  // measured against, so the two halves of this pane are not independent
  // (VC-284 re-review C6): committing a new window makes the list on screen a
  // statement about a policy that no longer exists. Retention says so, and the
  // orphan list refuses to act on a stale proposal until it has been scanned
  // again — main supersedes the revision from its own side at the same moment.
  const [retentionDays, setRetentionDays] = React.useState<number | null>(null);
  return (
    <>
      <RetentionSection onDays={setRetentionDays} />
      {/* Processes come before the two file sweeps: a running `next dev` is
          costing memory right now, while an orphaned folder is costing disk
          nobody is waiting on (VC-341). */}
      <RunningProcessesSection />
      {/* Then the artifacts a finished worktree is still carrying (VC-340):
          bigger than the orphan list and cheaper to act on, since a trim keeps
          every checkout where it is. */}
      <BuildArtifactsSection />
      <PiSessionLogsSection />
      <OrphansSection retentionDays={retentionDays} />
      <DatabaseSection />
    </>
  );
}

/**
 * The one number governing three things that were always the same question —
 * how long a finished ticket's checkout is worth keeping.
 *
 * `CommitField` rather than a bare input and a Save button, and the `confirm`
 * is the reason this pane exists in its current shape: this governs an
 * AUTOMATIC folder deletion, and the naive version sent whatever string was in
 * the box on blur. Select-all, type `1`, click away, and a one-day sweep is
 * armed with no confirmation and nothing on screen that changed.
 */
function RetentionSection({ onDays }: { onDays: (days: number) => void }) {
  const [days, setDays] = React.useState("");
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void window.api.retention
      .getTtlDays()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setDays(String(result.days));
          onDays(result.days);
        } else toastError(`Couldn't load the retention setting: ${result.error}`);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        toastError(`Couldn't load the retention setting: ${errorMessage(error)}`);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
    // `onDays` is a setState function from the pane above — stable for the life
    // of the mount, and listed because the read it feeds is the one that tells
    // the orphan list which window its dates were measured against.
  }, [onDays]);

  return (
    <PrefSection title="Retention" icon={TreeStructureIcon}>
      <PrefRow
        label="Keep Done worktrees for"
        htmlFor="done-ttl-days"
        // The sanctioned trust-boundary exception, and the reason it stays
        // prose rather than becoming a hint: this governs an automatic
        // deletion, and what gets deleted must not sit behind a disclosure.
        // It names Keep because the exemption is only reachable from a ticket,
        // and a policy whose opt-out is invisible here reads as unconditional.
        description="Volli removes the folder and keeps the branch, its commits, the pull-request link, and the ticket. Keep on a ticket holds its folder."
      >
        <CommitField
          id="done-ttl-days"
          type="number"
          width="sm"
          value={days}
          disabled={!loaded}
          validate={(next) => {
            const parsed = Number.parseInt(next.trim(), 10);
            return Number.isFinite(parsed) && parsed >= 1
              ? null
              : "Enter a whole number of days, at least 1.";
          }}
          confirm={(next) =>
            Number.parseInt(next, 10) >= CONFIRM_BELOW_DAYS ||
            window.confirm(
              `Keep Done worktrees for only ${next} day(s)? Folders will be removed sooner.`,
            )
          }
          onCommit={async (next): Promise<CommitResult> => {
            const parsed = Number.parseInt(next.trim(), 10);
            try {
              const result = await window.api.retention.setTtlDays(parsed);
              if (!result.ok) return { ok: false, error: result.error };
              // Adopt what main clamped it to, not what was typed.
              setDays(String(result.days));
              // And tell the orphan list, whose every date was measured against
              // the window this just replaced.
              onDays(result.days);
              return { ok: true, value: String(result.days) };
            } catch (error) {
              return { ok: false, error: errorMessage(error) };
            }
          }}
        />
        <span className="text-ui text-muted-foreground">days</span>
      </PrefRow>
    </PrefSection>
  );
}

/**
 * Build artifacts (VC-340): what the checkouts are carrying, and the one action
 * that puts it down.
 *
 * A scan on demand rather than on mount, for the same reason the orphan sweep is
 * cached per launch: the read spawns a `git ls-files` per worktree, and this pane
 * governs 143 of them on the machine that opened the ticket. Sizes are
 * deliberately absent from the table — measuring them means walking every tree,
 * which is the thirty-second stall that started this. The trim measures what it
 * takes and reports it afterwards, which is when the number is worth having.
 */
function BuildArtifactsSection() {
  const [state, setState] = React.useState<AsyncState<WorktreeTrimScanEntry[] | null>>({
    status: "ready",
    data: null,
  });
  const [report, setReport] = React.useState<WorktreeTrimSweepReport | null>(null);
  const [trimOnFinish, setTrimOnFinish] = React.useState<boolean | null>(null);
  const [scanning, setScanning] = React.useState(false);
  const [trimming, setTrimming] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const fetcher = useLatestAsync();
  const worktrees = state.status === "ready" ? state.data : null;
  const carrying = (worktrees ?? []).filter((entry) => entry.artifactCount > 0);
  const trimmable = carrying.filter((entry) => entry.activeReason === null);

  React.useEffect(() => {
    let cancelled = false;
    void window.api.worktree
      .trimSettings()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setTrimOnFinish(result.settings.trimOnFinish);
        else toastError(`Couldn't load the trim setting: ${result.error}`);
      })
      .catch((error: unknown) => {
        if (!cancelled) toastError(`Couldn't load the trim setting: ${errorMessage(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => () => fetcher.invalidate(), [fetcher]);

  const scan = React.useCallback(async (): Promise<void> => {
    const token = fetcher.claim();
    setScanning(true);
    setState({ status: "loading" });
    try {
      const result = await window.api.worktree.trimScan();
      if (!fetcher.isCurrent(token)) return;
      if (!result.ok) {
        setState({ status: "error", message: result.error, onRetry: () => void scan() });
        return;
      }
      setState({ status: "ready", data: result.worktrees });
    } catch (error) {
      if (fetcher.isCurrent(token)) {
        setState({ status: "error", message: errorMessage(error), onRetry: () => void scan() });
      }
    } finally {
      if (fetcher.isCurrent(token)) setScanning(false);
    }
  }, [fetcher]);

  async function saveTrimOnFinish(next: boolean): Promise<void> {
    setTrimOnFinish(next);
    try {
      const result = await window.api.worktree.setTrimSettings({ trimOnFinish: next });
      if (result.ok) {
        setTrimOnFinish(result.settings.trimOnFinish);
        return;
      }
      setTrimOnFinish(!next);
      toastError(`Couldn't save the trim setting: ${result.error}`);
    } catch (error) {
      setTrimOnFinish(!next);
      toastError(`Couldn't save the trim setting: ${errorMessage(error)}`);
    }
  }

  async function trim(): Promise<void> {
    if (trimming) return;
    setTrimming(true);
    try {
      const result = await window.api.worktree.trim();
      if (!result.ok) {
        toastError(`Couldn't trim build artifacts: ${result.error}`);
        return;
      }
      setReport(result.report);
      setConfirmOpen(false);
      // The table it was based on is now wrong about every row it trimmed.
      await scan();
    } catch (error) {
      toastError(`Couldn't trim build artifacts: ${errorMessage(error)}`);
    } finally {
      setTrimming(false);
    }
  }

  const summary =
    state.status === "loading"
      ? "Scanning…"
      : worktrees === null
        ? "Not scanned"
        : carrying.length === 0
          ? "Nothing to trim"
          : `${carrying.length} of ${worktrees.length} worktree(s)`;

  return (
    <>
      <AsyncSection
        title="Build artifacts"
        icon={BroomIcon}
        hint={
          <>
            A trim removes what git ignores — dependencies, build output, caches — and keeps .env,
            keys, and other local configuration. Keeping a file keeps the folders around it, so a
            folder that held one can stay behind part-emptied. One install puts a worktree back.
          </>
        }
        action={
          <SectionIconAction
            // "Scan", never "Rescan": VC-284 found that word on a button that
            // pruned metadata and deleted directories, and the label a person
            // reads before pressing is part of that fix. This one only reads.
            label="Scan for build artifacts"
            icon={ArrowsClockwiseIcon}
            busy={scanning}
            onAct={() => void scan()}
          />
        }
        before={
          <>
            <PrefRow label="Trim when a ticket is done" htmlFor="trim-on-finish">
              <Switch
                id="trim-on-finish"
                checked={trimOnFinish ?? true}
                disabled={trimOnFinish === null}
                onCheckedChange={(next) => void saveTrimOnFinish(next)}
              />
            </PrefRow>
            <PrefRow label="Carrying artifacts">
              <span className="text-ui text-muted-foreground">{summary}</span>
              <Button
                size="xs"
                variant="outline"
                disabled={trimmable.length === 0 || scanning || trimming}
                onClick={() => setConfirmOpen(true)}
              >
                <BroomIcon />
                Trim…
              </Button>
            </PrefRow>
            {report === null ? null : <TrimReportRows report={report} />}
          </>
        }
        state={state}
        isEmpty={(entries) => entries !== null && entries.length === 0}
        empty="No worktrees to trim."
      >
        {(entries) =>
          entries === null
            ? null
            : entries.map((entry) => (
                <ItemRow
                  key={entry.path}
                  name={truncateMiddle(entry.path)}
                  meta={
                    entry.activeReason ??
                    (entry.artifactCount === 0
                      ? "No ignored files."
                      : `${entry.artifactCount} ignored path(s).`)
                  }
                  badges={
                    entry.artifactCount > 0 ? <Badge variant="outline">Artifacts</Badge> : null
                  }
                  testId="trim-row"
                >
                  <RowAction
                    label={`Reveal ${entry.path} in Finder`}
                    hint="Reveal in Finder"
                    icon={FolderOpenIcon}
                    onAct={() => void reveal(entry.path)}
                  />
                </ItemRow>
              ))
        }
      </AsyncSection>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!trimming) setConfirmOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Trim build artifacts?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="block">
                Removes the git-ignored files in {trimmable.length} worktree(s) — dependencies,
                build output, caches. Tracked files, uncommitted work, .env files, and keys stay,
                and so do the folders around anything kept, so a folder holding one can remain
                part-emptied. Volli re-checks every worktree before touching it and skips any with a
                running agent, an open terminal, or uncommitted changes.
              </span>
              <span className="mt-2 block max-h-48 overflow-auto whitespace-pre-wrap font-mono text-ui text-foreground">
                {trimmable.map((entry) => entry.path).join("\n")}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={trimming}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={trimming}
              onClick={(event) => {
                event.preventDefault();
                void trim();
              }}
            >
              {trimming ? "Trimming…" : "Trim"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** How many entries of a finished trim are worth listing before it becomes a log. */
const TRIM_REPORT_ROWS = 5;

/**
 * What the trim did, where the action was: the total, the biggest things it took,
 * the configuration it kept, and what it refused. A destructive action that
 * reports only "done" is the failure `removedClean` was added to the orphan list
 * to end — and a kept COUNT with no names is the same failure at one remove: a
 * person reading "kept 3" cannot tell whether their `.env` is one of the three.
 * So the kept paths are listed with the pattern that spared each, bounded the
 * same way the offenders are.
 */
function TrimReportRows({ report }: { report: WorktreeTrimSweepReport }) {
  const offenders = report.worktrees
    .flatMap((worktree) =>
      worktree.removed.map((removal) => ({
        path: `${truncateMiddle(worktree.worktreePath, 32)}/${removal.path}`,
        bytes: removal.bytes,
      })),
    )
    .toSorted((a, b) => b.bytes - a.bytes)
    .slice(0, TRIM_REPORT_ROWS);
  const allKept = report.worktrees.flatMap((worktree) =>
    worktree.kept.map((keep) => ({
      path: `${truncateMiddle(worktree.worktreePath, 32)}/${keep.path}`,
      reason: keep.reason,
    })),
  );
  const kept = allKept.slice(0, TRIM_REPORT_ROWS);
  const keptCount = allKept.length;

  return (
    <>
      <PrefRow label="Freed">
        <span className="text-ui text-muted-foreground">
          {formatFileSize(report.totalBytes)} · {report.removedCount} path(s) in{" "}
          {report.worktrees.length} worktree(s)
          {keptCount > 0 ? ` · kept ${keptCount}` : ""}
        </span>
      </PrefRow>
      {offenders.map((offender) => (
        <ItemRow
          key={offender.path}
          name={offender.path}
          meta={`Removed · ${formatFileSize(offender.bytes)}`}
        />
      ))}
      {/* The preserved configuration, by name: this is the difference between a
          trim and a blind `git clean -fdX`, so it is the part that must be
          readable rather than counted. */}
      {kept.map((entry) => (
        <ItemRow key={`kept:${entry.path}`} name={entry.path} meta={`Kept — ${entry.reason}`} />
      ))}
      {keptCount > kept.length ? (
        <ItemRow
          name={`… and ${keptCount - kept.length} more kept`}
          meta="Ignored, but preserved as configuration."
        />
      ) : null}
      {report.skipped.map((skipped) => (
        <ItemRow
          key={`skipped:${skipped.path}`}
          name={truncateMiddle(skipped.path)}
          meta={`Skipped — ${skipped.reason}`}
        />
      ))}
    </>
  );
}

function PiSessionLogsSection() {
  const [state, setState] = React.useState<AsyncState<PiSessionOrphanInventory | null>>({
    status: "ready",
    data: null,
  });
  const [scanning, setScanning] = React.useState(false);
  const [cleaning, setCleaning] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const fetcher = useLatestAsync();
  const inventory = state.status === "ready" ? state.data : null;

  async function scan(): Promise<void> {
    if (scanning) return;
    const token = fetcher.claim();
    setScanning(true);
    setState({ status: "loading" });
    try {
      const result = await window.api.piSessions.scanOrphans();
      if (!fetcher.isCurrent(token)) return;
      if (!result.ok) {
        setState({
          status: "error",
          message: `Couldn't scan Pi session logs: ${result.error}`,
          onRetry: () => void scan(),
        });
        return;
      }
      setState({ status: "ready", data: result.inventory });
    } catch (error) {
      if (fetcher.isCurrent(token)) {
        setState({
          status: "error",
          message: `Couldn't scan Pi session logs: ${errorMessage(error)}`,
          onRetry: () => void scan(),
        });
      }
    } finally {
      if (fetcher.isCurrent(token)) setScanning(false);
    }
  }

  React.useEffect(() => () => fetcher.invalidate(), [fetcher]);

  async function reclaim(): Promise<void> {
    if (inventory === null || inventory.candidateCount === 0 || cleaning) return;
    setCleaning(true);
    try {
      const result = await window.api.piSessions.reclaimOrphans({
        scanRevision: inventory.revision,
        itemIds: inventory.candidates.map((candidate) => candidate.itemId),
      });
      if (!result.ok) {
        toastError(`Couldn't clean up Pi session logs: ${result.error}`);
        return;
      }
      setConfirmOpen(false);
      if (result.report.kept.length > 0) {
        toastError(
          `Kept ${result.report.kept.length} Pi session log(s) because they changed or became referenced.`,
        );
      }
      await scan();
    } catch (error) {
      toastError(`Couldn't clean up Pi session logs: ${errorMessage(error)}`);
    } finally {
      setCleaning(false);
    }
  }

  const summary =
    state.status === "loading"
      ? "Scanning…"
      : inventory === null
        ? "Not scanned"
        : `${inventory.candidateCount} file(s), ${formatFileSize(inventory.candidateBytes)}`;

  return (
    <>
      <AsyncSection
        title="Pi session logs"
        icon={DatabaseIcon}
        action={
          <SectionIconAction
            label="Scan for orphaned Pi logs"
            icon={ArrowsClockwiseIcon}
            busy={scanning}
            onAct={() => void scan()}
          />
        }
        before={
          <PrefRow
            label="Orphaned logs"
            hint={
              <>
                Only logs not referenced by any Volli session are candidates. Scanning never deletes
                files.
              </>
            }
          >
            <span className="text-ui text-muted-foreground">{summary}</span>
            <Button
              size="xs"
              variant="outline"
              disabled={
                inventory === null || inventory.candidateCount === 0 || scanning || cleaning
              }
              onClick={() => setConfirmOpen(true)}
            >
              <TrashIcon />
              Clean up…
            </Button>
          </PrefRow>
        }
        state={state}
      >
        {(report) =>
          report === null ? null : (
            <>
              {report.candidates.map((candidate) => (
                <ItemRow
                  key={candidate.itemId}
                  name={truncateMiddle(candidate.path)}
                  meta={`${candidate.sessionId} · ${formatFileSize(candidate.sizeBytes)}`}
                />
              ))}
              {report.skipped.map((entry) => (
                <ItemRow
                  key={`skipped:${entry.path}`}
                  name={truncateMiddle(entry.path)}
                  meta={`Kept — ${entry.reason}`}
                />
              ))}
            </>
          )
        }
      </AsyncSection>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!cleaning) setConfirmOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clean up orphaned Pi session logs?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="block">
                Permanently deletes {inventory?.candidateCount ?? 0} confirmed orphan file(s) (
                {formatFileSize(inventory?.candidateBytes ?? 0)}). Main checks every file and the
                attachment set again before removal. This can&rsquo;t be undone.
              </span>
              <span className="mt-2 block max-h-48 overflow-auto whitespace-pre-wrap font-mono text-ui text-foreground">
                {inventory?.candidates.map((candidate) => candidate.path).join("\n")}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cleaning}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={cleaning}
              onClick={(event) => {
                event.preventDefault();
                void reclaim();
              }}
            >
              {cleaning ? "Cleaning up…" : "Delete orphaned logs"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function DatabaseSection() {
  const [sizeBytes, setSizeBytes] = React.useState<number | null>(null);
  const [sizeLoaded, setSizeLoaded] = React.useState(false);
  const [revealing, setRevealing] = React.useState(false);
  const [exportOpen, setExportOpen] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void window.api
      .database()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setSizeBytes(result.sizeBytes);
        else toastError(`Couldn't load database size: ${result.error}`);
        setSizeLoaded(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        toastError(`Couldn't load database size: ${errorMessage(error)}`);
        setSizeLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function revealDatabase(): Promise<void> {
    if (revealing) return;
    setRevealing(true);
    try {
      const result = await window.api.database("reveal");
      if (!result.ok) {
        toastError(`Couldn't reveal database: ${result.error}`);
        return;
      }
      setSizeBytes(result.sizeBytes);
      setSizeLoaded(true);
    } catch (error) {
      toastError(`Couldn't reveal database: ${errorMessage(error)}`);
    } finally {
      setRevealing(false);
    }
  }

  async function exportDatabase(): Promise<void> {
    if (exporting) return;
    setExporting(true);
    try {
      const result = await window.api.database("export");
      if (!result.ok) {
        toastError(`Couldn't export data: ${result.error}`);
        return;
      }
      setSizeBytes(result.sizeBytes);
      setSizeLoaded(true);
    } catch (error) {
      toastError(`Couldn't export data: ${errorMessage(error)}`);
    } finally {
      setExporting(false);
      setExportOpen(false);
    }
  }

  return (
    <>
      <PrefSection
        title="Database"
        icon={DatabaseIcon}
        action={
          <SectionAction
            label="Reveal in Finder"
            icon={FolderOpenIcon}
            disabled={revealing}
            onAct={() => void revealDatabase()}
          />
        }
      >
        <PrefRow label="Size">
          <span className="text-ui text-muted-foreground">
            {sizeLoaded
              ? sizeBytes === null
                ? "Unavailable"
                : formatFileSize(sizeBytes)
              : "Loading…"}
          </span>
        </PrefRow>
        <PrefRow label={DATA_EXPORT_ACTION_LABEL}>
          <Button size="xs" variant="outline" onClick={() => setExportOpen(true)}>
            Export…
          </Button>
        </PrefRow>
      </PrefSection>

      <AlertDialog
        open={exportOpen}
        onOpenChange={(open) => {
          if (!exporting) setExportOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{DATA_EXPORT_CONFIRM_TITLE}</AlertDialogTitle>
            <AlertDialogDescription>
              <DataExportConfirmBody />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={exporting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={exporting}
              onClick={(event) => {
                event.preventDefault();
                void exportDatabase();
              }}
            >
              {exporting ? "Exporting…" : "Choose location…"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * What the export is, said before it runs.
 *
 * A named component rather than inline JSX because the sentence is the
 * feature: the dialog it sits in only mounts when opened, so this is what a
 * test can hold, and the limits cannot quietly drift back into a promise of
 * "every project, ticket, comment, session, label, and setting" (VC-283).
 *
 * The exported/limited split is deliberate — the limits come FIRST, because a
 * person skimming reads one sentence and the one that matters is the one that
 * says a rescue is not possible from this file.
 */
export function DataExportConfirmBody() {
  return (
    <>
      {DATA_EXPORT_LIMITS} {DATA_EXPORT_CONTENTS}
    </>
  );
}

/** Truncates a long path to `start…end`, keeping both ends identifiable. */
function truncateMiddle(value: string, max = 56): string {
  if (value.length <= max) return value;
  const keep = Math.floor((max - 1) / 2);
  return `${value.slice(0, keep)}…${value.slice(value.length - keep)}`;
}

/**
 * The orphan list: what a cleanup WOULD do, what it keeps and why, and what
 * past cleanups actually did.
 *
 * Scan and cleanup are two separate acts (VC-284), and this section is where
 * the difference is visible. Scan asks git questions and changes nothing, so
 * mount and the Scan button are the same safe read. Removing anything takes the
 * Clean up button, its confirmation naming every path and record, and a
 * per-path re-check in main immediately before each change.
 *
 * This surface used to be the other way round: its one button said "Rescan" and
 * sent `{ rescan: true }`, which pruned git metadata and deleted every clean
 * orphan past the retention window — the same act the app ran, unasked, at
 * every launch.
 */
function OrphansSection({ retentionDays: setting }: { retentionDays: number | null }) {
  const [state, setState] = React.useState<AsyncState<OrphansScan>>({ status: "loading" });
  const [pendingDelete, setPendingDelete] = React.useState<DirtyWorktreeOrphan | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [confirmCleanup, setConfirmCleanup] = React.useState(false);
  const [cleaning, setCleaning] = React.useState(false);
  const fetcher = useLatestAsync();

  const load = React.useCallback(
    async (refresh: boolean) => {
      const token = fetcher.claim();
      setBusy(true);
      setState({ status: "loading" });
      try {
        const result = await window.api.worktree.orphans(refresh ? { refresh: true } : {});
        if (!fetcher.isCurrent(token)) return;
        if (!result.ok) {
          setState({
            status: "error",
            message: result.error,
            // Retry the read that FAILED — both shapes are read-only, so the
            // only thing this choice costs is a repeated walk.
            onRetry: () => void load(refresh),
          });
          return;
        }
        setState({
          status: "ready",
          data: {
            revision: result.revision,
            scannedAt: result.scannedAt,
            retentionDays: result.retentionDays,
            prunable: result.prunable,
            removable: result.removable,
            keptRecent: result.keptRecent,
            keptMetadata: result.keptMetadata,
            unreadableProjects: result.unreadableProjects,
            dirty: result.dirty,
            runs: result.runs,
          },
        });
      } catch (error) {
        if (fetcher.isCurrent(token)) {
          setState({
            status: "error",
            message: errorMessage(error),
            onRetry: () => void load(refresh),
          });
        }
      } finally {
        if (fetcher.isCurrent(token)) setBusy(false);
      }
    },
    [fetcher],
  );

  React.useEffect(() => {
    void load(false);
    return () => fetcher.invalidate();
  }, [load, fetcher]);

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    try {
      const result = await window.api.worktree.deleteOrphan(pendingDelete.path);
      if (!result.ok) {
        toastError(`Couldn't delete worktree: ${result.error}`);
        return;
      }
      setPendingDelete(null);
      // A delete invalidates the cached scan, so this one re-scans.
      await load(true);
    } catch (error) {
      toastError(`Couldn't delete worktree: ${errorMessage(error)}`);
    } finally {
      setDeleting(false);
    }
  }

  /**
   * The confirmed act. It names exactly the scan revision on screen and the
   * item ids that revision proposed — never a path — and mints a fresh
   * command id per press so a retried click after a stalled response cannot
   * double-run (VC-284 review C1). Main re-checks each target before touching
   * it, so a skip is a normal outcome, reported rather than treated as a
   * failure — but a FAILED or indeterminate item is not: it gets a warning,
   * never `toast.success` (review S2).
   */
  async function runCleanup(plan: CleanupPlan): Promise<void> {
    if (cleaning) return;
    setCleaning(true);
    try {
      const result = await window.api.worktree.cleanupOrphans({
        commandId: crypto.randomUUID(),
        scanRevision: plan.scanRevision,
        itemIds: plan.itemIds,
      });
      if (!result.ok) {
        toastError(cleanupRejectionMessage(result.code, result.error));
        return;
      }
      setConfirmCleanup(false);
      const outcome = cleanupOutcome(result.run);
      if (outcome.kind === "warning") toast.warning(outcome.message);
      else toast.success(outcome.message);
      await load(true);
    } catch (error) {
      toastError(`Couldn't clean up: ${errorMessage(error)}`);
    } finally {
      setCleaning(false);
    }
  }

  // The proposal describes a retention window that has since been replaced, so
  // it may be READ but not acted on (VC-284 re-review C6).
  const stale = state.status === "ready" && isScanStale(state.data, setting);
  const plan = state.status === "ready" && !stale ? planCleanup(state.data) : null;
  // The window every eligibility date on this list was measured against, read
  // from the scan rather than re-fetched: the two must be the same number.
  const retentionDays = state.status === "ready" ? state.data.retentionDays : null;

  return (
    <>
      <AsyncSection
        title="Orphaned worktrees"
        icon={TreeStructureIcon}
        hint={
          <>
            Scanning only looks. Cleanup removes folders you confirm and keeps their branches;
            anything with uncommitted work, recent use, or a live terminal or agent is left alone.
            {retentionDays === null ? null : ` ${retentionNote(retentionDays)}`}
          </>
        }
        // One header action, per the kit's header grammar — and it is the SAFE
        // one. The destructive act is a row below, attached to the summary of
        // what a scan actually found, so it cannot be pressed by muscle memory
        // in the place the old "Rescan" button used to sit.
        action={
          <SectionIconAction
            label="Scan for orphaned worktrees"
            icon={ArrowsClockwiseIcon}
            busy={busy}
            onAct={() => void load(true)}
          />
        }
        state={state}
        isEmpty={(report) =>
          report.dirty.length === 0 &&
          report.removable.length === 0 &&
          report.keptRecent.length === 0 &&
          report.keptMetadata.length === 0 &&
          report.unreadableProjects.length === 0 &&
          report.prunable.length === 0 &&
          historyRows(report.runs).length === 0 &&
          preservationHistoryRows(report.runs).length === 0 &&
          unfinishedRuns(report.runs).length === 0 &&
          runsWithFailures(report.runs).length === 0
        }
        empty="No orphaned worktrees."
      >
        {(report) => (
          <>
            {/*
             * The window every date below was measured against, and what this
             * list may do at all — on the surface rather than behind the
             * section's summoned hint, because an eligibility date nobody can
             * check against a policy is a date nobody can argue with.
             */}
            <ItemRow name="Retention" meta={orphanPolicyNote(report.retentionDays)} />

            {/*
             * The retention window moved after this scan ran, so every date
             * below was measured against a policy that is no longer in force.
             * The Clean up row is gone until it has been scanned again, and
             * main refuses the old revision from its own side.
             */}
            {stale && setting !== null ? (
              <ItemRow name="Scan is out of date" meta={staleScanNote(report, setting)}>
                <Button size="xs" variant="outline" disabled={busy} onClick={() => void load(true)}>
                  Scan again
                </Button>
              </ItemRow>
            ) : null}

            {/*
             * A cleanup the app never finished. It is stated before anything
             * else because it is the only row that describes an incomplete act
             * — and it says what completed, so nothing already removed reads as
             * still pending. "Scan again" is a real button here, not only a
             * sentence, per the review's S2.
             */}
            {unfinishedRuns(report.runs).map((run) => (
              <ItemRow key={run.id} name="Interrupted cleanup" meta={describeInterrupted(run)}>
                <Button size="xs" variant="outline" disabled={busy} onClick={() => void load(true)}>
                  Scan again
                </Button>
              </ItemRow>
            ))}

            {/*
             * A cleanup that FINISHED but left a failed or indeterminate item
             * behind — the case the old pane's `toast.success` erased (review
             * S2). Every failed path and its reason are named, with the same
             * recovery.
             */}
            {runsWithFailures(report.runs).map((run) => (
              <ItemRow
                key={`failures:${run.id}`}
                name="Cleanup finished with problems"
                meta={describeRunFailures(run)}
              >
                <Button size="xs" variant="outline" disabled={busy} onClick={() => void load(true)}>
                  Scan again
                </Button>
              </ItemRow>
            ))}

            {plan === null || plan.isEmpty ? null : (
              <ItemRow
                name="Ready to clean up"
                meta={`${plan.worktrees.length} folder(s) and ${plan.metadata.length} stale git record(s). Branches are kept.`}
              >
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || cleaning}
                  onClick={() => setConfirmCleanup(true)}
                >
                  <TrashIcon />
                  Clean up…
                </Button>
              </ItemRow>
            )}

            {/* A project whose worktree listing couldn't even be read — said outright, not hidden. */}
            {report.unreadableProjects.map((entry) => (
              <ItemRow
                key={`unreadable:${entry.projectId}`}
                name={entry.projectName}
                meta={describeUnreadableProject(entry)}
              />
            ))}

            {report.dirty.map((orphan) => (
              <ItemRow
                key={orphan.path}
                name={truncateMiddle(orphan.path)}
                meta={
                  orphan.projectName ? `${orphan.projectName} — ${orphan.reason}` : orphan.reason
                }
                testId="orphan-row"
              >
                <RowAction
                  label={`Reveal ${orphan.path} in Finder`}
                  hint="Reveal in Finder"
                  icon={FolderOpenIcon}
                  onAct={() => void reveal(orphan.path)}
                />
                <RowAction
                  label={`Delete ${orphan.path}`}
                  hint="Delete worktree"
                  icon={TrashIcon}
                  onAct={() => setPendingDelete(orphan)}
                />
              </ItemRow>
            ))}

            {/* Candidates: stated as proposals, with the project, date, and basis each became eligible under. */}
            {report.removable.map((entry) => (
              <ItemRow
                key={entry.path}
                name={truncateMiddle(entry.path)}
                meta={describeRemovable(entry, { retentionDays: report.retentionDays })}
              >
                <RowAction
                  label={`Reveal ${entry.path} in Finder`}
                  hint="Reveal in Finder"
                  icon={FolderOpenIcon}
                  onAct={() => void reveal(entry.path)}
                />
              </ItemRow>
            ))}

            {report.prunable.map((entry) => (
              <ItemRow
                key={`prunable:${entry.id}`}
                name={truncateMiddle(entry.path)}
                meta={describeMetadata(entry)}
              />
            ))}

            {/* Stale records cleanup will NOT prune, and why. */}
            {report.keptMetadata.map((entry) => (
              <ItemRow
                key={`kept-metadata:${entry.projectId}:${entry.path}`}
                name={truncateMiddle(entry.path)}
                meta={describeKeptMetadata(entry)}
              />
            ))}

            {report.keptRecent.map((entry) => (
              <ItemRow
                key={entry.path}
                name={truncateMiddle(entry.path)}
                meta={describeKept(entry)}
              />
            ))}

            {/*
             * What a cleanup DID, from the durable record rather than from this
             * session's memory — with its real source and time, because a
             * removal nobody can audit is indistinguishable from work going
             * missing, and one mislabelled is worse. Includes pruned METADATA
             * records, not only removed folders, and never folds two runs'
             * rows into one (review C6).
             */}
            {historyRows(report.runs).map((row) => (
              <ItemRow key={row.key} name={truncateMiddle(row.path)} meta={row.meta} />
            ))}

            {/*
             * The exact preservation policy each completed cleanup ran under,
             * rendered through the same shared vocabulary the confirmation
             * uses — never a second, independent description (review S3).
             */}
            {preservationHistoryRows(report.runs).map((row) => (
              <ItemRow key={row.key} name="Preservation applied" meta={row.meta} />
            ))}
          </>
        )}
      </AsyncSection>

      {/*
       * The confirmation, and the only door to a destructive orphan act. It
       * names every directory and every git record by hand — no counts standing
       * in for paths — and states what survives, because this is the moment the
       * decision is actually made.
       */}
      <AlertDialog
        open={confirmCleanup && plan !== null && !plan.isEmpty}
        onOpenChange={(open) => {
          if (!cleaning) setConfirmCleanup(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clean up these worktrees?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4">
                {plan !== null && plan.worktrees.length > 0 ? (
                  <div className="space-y-1">
                    <p>Removes {plan.worktrees.length} folder(s):</p>
                    <ul className="space-y-1">
                      {plan.worktrees.map((entry) => (
                        <li key={entry.id} className="font-mono text-foreground">
                          {entry.path}
                          {entry.branch === null ? "" : ` — keeps branch ${entry.branch}`}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {plan !== null && plan.metadata.length > 0 ? (
                  <div className="space-y-1">
                    <p>Prunes {plan.metadata.length} stale git record(s):</p>
                    <ul className="space-y-1">
                      {plan.metadata.map((entry) => (
                        <li key={entry.id} className="font-mono text-foreground">
                          {entry.projectName} — {entry.path}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <ul className="space-y-1">
                  {(plan?.preservation ?? []).map((rule) => (
                    <li key={rule}>{rule}</li>
                  ))}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cleaning}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={cleaning}
              onClick={(event) => {
                event.preventDefault();
                if (plan !== null) void runCleanup(plan);
              }}
            >
              {cleaning ? "Cleaning up…" : "Clean up"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this worktree?</AlertDialogTitle>
            <AlertDialogDescription>
              Deletes <span className="font-mono text-foreground">{pendingDelete?.path}</span> and
              the uncommitted work inside it. Can&rsquo;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={() => void confirmDelete()}
            >
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

async function reveal(path: string): Promise<void> {
  try {
    const result = await window.api.fs.revealInFinder(path);
    if (!result.ok) toastError(`Couldn't reveal in Finder: ${result.error}`);
  } catch (error) {
    toastError(`Couldn't reveal in Finder: ${errorMessage(error)}`);
  }
}
