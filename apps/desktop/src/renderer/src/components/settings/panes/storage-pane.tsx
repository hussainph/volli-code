/**
 * Settings → Storage: what Volli keeps on disk, and for how long.
 *
 * Retention and the orphan sweep are ONE subject and now sit in one place. They
 * were two categories in two surfaces, which is how a person could set a
 * retention window in Settings → General and then find the folders it governs
 * listed under Settings → Worktrees with nothing connecting them.
 *
 * Both are app-wide by construction: the TTL lives in `app_state`, and
 * `sweepOrphans` walks every project in the db — its disk-vs-git pass reports
 * directories git no longer attributes to any project at all, so it cannot be
 * scoped to one. That is why Configure has no copy of this.
 */
import * as React from "react";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { DatabaseIcon } from "@phosphor-icons/react/dist/csr/Database";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";
import { errorMessage } from "@volli/shared";

import type {
  DirtyWorktreeOrphan,
  KeptWorktreeOrphan,
  RemovedWorktreeOrphan,
} from "../../../../../ipc/contract";
import {
  AsyncSection,
  CommitField,
  ItemRow,
  PrefRow,
  PrefSection,
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
import { Button } from "@renderer/components/ui/button";
import { formatFileSize } from "@renderer/components/attachments/attachment-model";
import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import { toastError } from "@renderer/lib/toast";

/** Below a week, an automatic deletion is close enough to ask about. */
const CONFIRM_BELOW_DAYS = 7;

export function StoragePane() {
  return (
    <>
      <RetentionSection />
      <OrphansSection />
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
function RetentionSection() {
  const [days, setDays] = React.useState("");
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void window.api.retention
      .getTtlDays()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setDays(String(result.days));
        else toastError(`Couldn't load the retention setting: ${result.error}`);
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
  }, []);

  return (
    <PrefSection title="Retention" icon={TreeStructureIcon}>
      <PrefRow
        label="Keep Done worktrees for"
        htmlFor="done-ttl-days"
        // The sanctioned trust-boundary exception, and the reason it stays
        // prose rather than becoming a hint: this governs an automatic
        // deletion, and what gets deleted must not sit behind a disclosure.
        description="Volli removes the folder and keeps the branch, its commits, and the ticket."
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
        toastError(`Couldn't export database: ${result.error}`);
        return;
      }
      setSizeBytes(result.sizeBytes);
      setSizeLoaded(true);
    } catch (error) {
      toastError(`Couldn't export database: ${errorMessage(error)}`);
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
        <PrefRow label="Export database">
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
            <AlertDialogTitle>Export database?</AlertDialogTitle>
            <AlertDialogDescription>
              Creates a JSON file containing every project, ticket, comment, session, label, and
              setting in Volli.
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

interface OrphansReport {
  dirty: DirtyWorktreeOrphan[];
  removed: RemovedWorktreeOrphan[];
  kept: KeptWorktreeOrphan[];
}

/** Truncates a long path to `start…end`, keeping both ends identifiable. */
function truncateMiddle(value: string, max = 56): string {
  if (value.length <= max) return value;
  const keep = Math.floor((max - 1) / 2);
  return `${value.slice(0, keep)}…${value.slice(value.length - keep)}`;
}

/**
 * The orphan list, with what the launch sweep already did beside it.
 *
 * Mount reads the CACHED launch report; only the explicit refresh rescans. The
 * sweep is destructive — it prunes git metadata and removes clean orphan dirs
 * — which is exactly why `orphan-sweep.ts` caches it to once per launch.
 * Rescanning on mount would re-run it every time this category is entered,
 * since the shell unmounts an inactive pane.
 */
function OrphansSection() {
  const [state, setState] = React.useState<AsyncState<OrphansReport>>({ status: "loading" });
  const [pendingDelete, setPendingDelete] = React.useState<DirtyWorktreeOrphan | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const fetcher = useLatestAsync();

  const load = React.useCallback(
    async (rescan: boolean) => {
      const token = fetcher.claim();
      setBusy(true);
      setState({ status: "loading" });
      try {
        const result = await window.api.worktree.orphans(rescan ? { rescan: true } : {});
        if (!fetcher.isCurrent(token)) return;
        if (!result.ok) {
          setState({
            status: "error",
            message: result.error,
            // Retry the read that FAILED — retrying a failed refresh with the
            // cached report answers a question nobody asked, and retrying the
            // mount read with a rescan runs the destructive sweep they didn't
            // ask for either.
            onRetry: () => void load(rescan),
          });
          return;
        }
        setState({
          status: "ready",
          data: { dirty: result.dirty, removed: result.removedClean, kept: result.keptRecent },
        });
      } catch (error) {
        if (fetcher.isCurrent(token)) {
          setState({
            status: "error",
            message: errorMessage(error),
            onRetry: () => void load(rescan),
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
      // A delete invalidates the cached report, so this one re-sweeps.
      await load(true);
    } catch (error) {
      toastError(`Couldn't delete worktree: ${errorMessage(error)}`);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <AsyncSection
        title="Orphaned worktrees"
        icon={TreeStructureIcon}
        hint={<>Never swept automatically while they hold uncommitted work.</>}
        action={
          <SectionIconAction
            label="Rescan orphaned worktrees"
            icon={ArrowsClockwiseIcon}
            busy={busy}
            onAct={() => void load(true)}
          />
        }
        state={state}
        isEmpty={(report) =>
          report.dirty.length === 0 && report.removed.length === 0 && report.kept.length === 0
        }
        empty="No orphaned worktrees."
      >
        {(report) => (
          <>
            {report.dirty.map((orphan) => (
              <ItemRow
                key={orphan.path}
                name={truncateMiddle(orphan.path)}
                meta={orphan.reason}
                testId="orphan-row"
              >
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Reveal ${orphan.path}`}
                  onClick={() => void reveal(orphan.path)}
                >
                  <FolderOpenIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Delete ${orphan.path}`}
                  onClick={() => setPendingDelete(orphan)}
                >
                  <TrashIcon />
                </Button>
              </ItemRow>
            ))}

            {/*
             * What the sweep DID, not only what it left behind. A launch that
             * quietly deleted forty checkouts is indistinguishable from work
             * going missing unless the app says so somewhere.
             */}
            {report.removed.map((entry) => (
              <ItemRow
                key={entry.path}
                name={truncateMiddle(entry.path)}
                meta={
                  entry.branch === null
                    ? "Removed at launch. No branch was checked out here."
                    : `Removed at launch. Branch ${entry.branch} is still in git.`
                }
              />
            ))}
            {report.kept.map((entry) => (
              <ItemRow
                key={entry.path}
                name={truncateMiddle(entry.path)}
                meta={
                  entry.removableAt === null
                    ? "Kept — Volli can't tell when this was last used."
                    : `Kept until ${new Date(entry.removableAt).toLocaleDateString()}.`
                }
              />
            ))}
          </>
        )}
      </AsyncSection>

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
