/**
 * Settings → Storage → Running processes (VC-341).
 *
 * The list this feature exists to make visible: a `next dev` from a Ticket
 * whose Session ended three weeks ago, a Gradle daemon that outlived its
 * worktree, a `sleep` somebody's script left behind. Nothing on this machine
 * could name any of them before, so the first thing this surface owes a person
 * is EVIDENCE — the Ticket, how long it has been running, how much memory it is
 * holding, and the command line as informational text.
 *
 * Reap is per row and there is a Reap all, and neither is the default action:
 * the section scans on demand and never on mount, because a scan spawns `ps`
 * and `lsof` and a Settings pane a person opened to change a theme should not
 * do that.
 *
 * A row Volli may not kill is still listed and simply has no Reap. That is the
 * person's own shell standing in the worktree, and it belongs on the list for
 * the same reason a doctor reports a measurement it has no remedy for: it is
 * the answer to "what is holding this checkout".
 */
import * as React from "react";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { SkullIcon } from "@phosphor-icons/react/dist/csr/Skull";
import { errorMessage, formatProcessAge, type AutoReapPolicy } from "@volli/shared";

import type { OrphanProcessInventory } from "../../../../../ipc/contract";
import {
  AsyncSection,
  ItemRow,
  PrefRow,
  RowAction,
  SectionIconAction,
  type AsyncState,
} from "@renderer/components/settings/kit";
import { Button } from "@renderer/components/ui/button";
import { Switch } from "@renderer/components/ui/switch";
import { formatFileSize } from "@renderer/components/attachments/attachment-model";
import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import { toastError } from "@renderer/lib/toast";
import { processRowMeta, processSummary, reapableIds } from "./processes-model";

export function RunningProcessesSection() {
  const [state, setState] = React.useState<AsyncState<OrphanProcessInventory | null>>({
    status: "ready",
    data: null,
  });
  const [policy, setPolicy] = React.useState<AutoReapPolicy | null>(null);
  const [scanning, setScanning] = React.useState(false);
  const [reaping, setReaping] = React.useState(false);
  const fetcher = useLatestAsync();
  const inventory = state.status === "ready" ? state.data : null;

  React.useEffect(() => () => fetcher.invalidate(), [fetcher]);

  async function scan(): Promise<void> {
    if (scanning) return;
    const token = fetcher.claim();
    setScanning(true);
    setState({ status: "loading" });
    try {
      const result = await window.api.orphanProcesses.scan();
      if (!fetcher.isCurrent(token)) return;
      if (!result.ok) {
        setState({
          status: "error",
          message: `Couldn't look for orphaned processes: ${result.error}`,
          onRetry: () => void scan(),
        });
        return;
      }
      setState({ status: "ready", data: result.inventory });
      setPolicy(result.policy);
    } catch (error) {
      if (fetcher.isCurrent(token)) {
        setState({
          status: "error",
          message: `Couldn't look for orphaned processes: ${errorMessage(error)}`,
          onRetry: () => void scan(),
        });
      }
    } finally {
      if (fetcher.isCurrent(token)) setScanning(false);
    }
  }

  async function reap(itemIds: readonly string[]): Promise<void> {
    if (inventory === null || itemIds.length === 0 || reaping) return;
    setReaping(true);
    try {
      const result = await window.api.orphanProcesses.reap({
        scanRevision: inventory.revision,
        itemIds: [...itemIds],
      });
      if (!result.ok) {
        toastError(`Couldn't reap: ${result.error}`);
        return;
      }
      // A kept row is not a failure of the reap — it is main reporting that the
      // process it was asked to kill is not what is running under that number
      // any more. Saying so is the whole point of re-checking.
      for (const kept of result.report.kept) {
        toastError(`Left pid ${kept.candidate.pid} alone — ${kept.reason}`);
      }
      await scan();
    } catch (error) {
      toastError(`Couldn't reap: ${errorMessage(error)}`);
    } finally {
      setReaping(false);
    }
  }

  async function commitPolicy(next: AutoReapPolicy): Promise<void> {
    const previous = policy;
    setPolicy(next);
    try {
      const result = await window.api.orphanProcesses.setPolicy(next);
      if (!result.ok) {
        setPolicy(previous);
        toastError(`Couldn't save that: ${result.error}`);
        return;
      }
      setPolicy(result.policy);
    } catch (error) {
      setPolicy(previous);
      toastError(`Couldn't save that: ${errorMessage(error)}`);
    }
  }

  const reapable = inventory === null ? [] : reapableIds(inventory.candidates);

  return (
    <AsyncSection
      title="Running processes"
      icon={CpuIcon}
      hint={
        <>
          Processes still running under a ticket&rsquo;s worktree with no live Session. Scanning
          only looks.
        </>
      }
      action={
        <SectionIconAction
          label="Look for processes no Session owns"
          icon={ArrowsClockwiseIcon}
          busy={scanning}
          onAct={() => void scan()}
        />
      }
      before={
        <>
          <PrefRow label="No Session owns">
            <span className="text-ui text-muted-foreground">
              {processSummary(state.status === "loading", inventory)}
            </span>
            <Button
              size="xs"
              variant="outline"
              disabled={reapable.length === 0 || scanning || reaping}
              onClick={() => void reap(reapable)}
            >
              <SkullIcon />
              Reap all
            </Button>
          </PrefRow>
          <PrefRow label="Reap under memory pressure" htmlFor="auto-reap">
            <Switch
              id="auto-reap"
              checked={policy?.enabled ?? false}
              disabled={policy === null}
              onCheckedChange={(enabled) => {
                if (policy !== null) void commitPolicy({ ...policy, enabled });
              }}
            />
          </PrefRow>
        </>
      }
      state={state}
      isEmpty={(report) => report === null || report.candidates.length === 0}
    >
      {(report) =>
        report === null
          ? null
          : report.candidates.map((candidate) => (
              <ItemRow
                key={candidate.itemId}
                name={`${candidate.ticketDisplayId ?? "No ticket"} · ${candidate.command}`}
                meta={processRowMeta(candidate, formatProcessAge, formatFileSize)}
              >
                {candidate.stance === "reapable" ? (
                  <RowAction
                    label={`Reap pid ${candidate.pid}`}
                    hint="Reap"
                    icon={SkullIcon}
                    disabled={scanning || reaping}
                    onAct={() => void reap([candidate.itemId])}
                  />
                ) : null}
              </ItemRow>
            ))
      }
    </AsyncSection>
  );
}
