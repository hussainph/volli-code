import * as React from "react";
import { errorMessage } from "@volli/shared";
import { CloudArrowUpIcon } from "@phosphor-icons/react/dist/csr/CloudArrowUp";
import { desktopCloudMovesApi, type CloudMovesClient } from "@renderer/lib/cloud-moves";
import { useCloudEnabled } from "@renderer/components/hosts/use-hosts";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@renderer/components/ui/dialog";
import { SidebarMenu, SidebarMenuItem, SidebarMenuButton } from "@renderer/components/ui/sidebar";
import { PrefRow, PrefSection } from "@renderer/components/settings/kit";
import {
  bindCloudMoves,
  closeCloudMoves,
  prepareCloudMove,
  showCloudMoves,
  useCloudMovesStore,
} from "@renderer/stores/cloud-moves";
import { useProjectsStore } from "@renderer/stores/projects";
import { launchStore } from "@renderer/stores/launch";
import { MovePreflight } from "./preflight";
import { MoveProgress } from "./progress";
import { MOVE_STATE_LABELS, movePercentLabel } from "./presentation";
import { toastError } from "@renderer/lib/toast";

/** One subscription, outside navigation. Closing a sheet never stops the host's queue. */
export function CloudMovesRoot({ api }: { api?: CloudMovesClient } = {}) {
  const enabled = useCloudEnabled();
  React.useEffect(
    () => (enabled ? bindCloudMoves(api ?? desktopCloudMovesApi()) : undefined),
    [enabled, api],
  );
  return enabled ? <CloudMoveSheet /> : null;
}

function CloudMoveSheet() {
  const { sheet, api, snapshot, error, refresh } = useCloudMovesStore();
  const moves =
    snapshot?.moves.filter(
      (move) =>
        sheet?.kind !== "progress" || sheet.queueId === undefined || move.queueId === sheet.queueId,
    ) ?? [];
  return (
    <Dialog
      open={sheet !== null}
      onOpenChange={(open) => {
        if (!open) closeCloudMoves();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {sheet?.kind === "prepare" ? "Move to Volli Cloud" : "Moves to Volli Cloud"}
          </DialogTitle>
          <DialogDescription className={sheet?.kind === "prepare" ? undefined : "sr-only"}>
            {sheet?.kind === "prepare"
              ? "Your local projects stay on this Mac."
              : "Project move progress"}
          </DialogDescription>
        </DialogHeader>
        {error !== null ? (
          <div className="flex items-center justify-between gap-2 text-ui">
            <p role="alert">{error}</p>
            <Button size="sm" onClick={refresh}>
              Try again
            </Button>
          </div>
        ) : null}
        {api === null || snapshot === null ? (
          <p role="status" className="text-ui">
            Reading moves…
          </p>
        ) : sheet?.kind === "prepare" ? (
          <MovePreflight
            key={sheet.key}
            api={api}
            snapshot={snapshot}
            {...(sheet.projectIds === undefined ? {} : { projectIds: sheet.projectIds })}
          />
        ) : (
          <MoveProgress
            key={sheet?.key}
            api={api}
            moves={moves}
            {...(sheet?.kind === "progress" && sheet.cancelMoveId !== undefined
              ? { initialCancelMoveId: sheet.cancelMoveId }
              : {})}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Quiet Settings entry; no prompts or banners for projects that have not moved. */
export function CloudMovesSettings() {
  return (
    <PrefSection title="Move projects to Volli Cloud" icon={CloudArrowUpIcon}>
      <PrefRow label="Local projects">
        <Button size="sm" variant="outline" onClick={() => prepareCloudMove()}>
          Move all projects…
        </Button>
      </PrefRow>
      <PrefRow label="Moves">
        <Button size="sm" variant="ghost" onClick={() => showCloudMoves()}>
          Progress and local copies
        </Button>
      </PrefRow>
    </PrefSection>
  );
}

export function CloudMoveRailRow() {
  const enabled = useCloudEnabled();
  const snapshot = useCloudMovesStore((state) => state.snapshot);
  const latestByProject = new Map(snapshot?.moves.map((move) => [move.projectId, move]));
  const moves = [...latestByProject.values()].filter(
    (move) =>
      move.state !== "returned" && move.state !== "finished" && move.state !== "rolled-back",
  );
  if (!enabled || moves.length === 0) return null;
  const current =
    moves.find((move) => move.state === "moving") ??
    moves.find((move) => move.state === "waiting") ??
    moves.find((move) => move.state === "problem") ??
    moves[0]!;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={() => showCloudMoves(current.queueId)}
          aria-label="Move to Volli Cloud progress"
        >
          <CloudArrowUpIcon />
          <span className="truncate">
            {current.projectName} · {MOVE_STATE_LABELS[current.state]}
            {current.state === "moving" ? ` ${movePercentLabel(current.progress)}` : ""}
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** Only frozen/archived LOCAL copies get a banner. Cloud projects are not read-only copies. */
export function CloudMoveReadOnlyBanner() {
  const enabled = useCloudEnabled();
  const projectId = useProjectsStore((state) => state.selectedProjectId);
  const snapshot = useCloudMovesStore((state) => state.snapshot);
  const api = useCloudMovesStore((state) => state.api);
  const [resuming, setResuming] = React.useState(false);
  const move = snapshot?.moves.findLast((item) => item.projectId === projectId);
  if (!enabled || launchStore() !== "local" || move === undefined || !move.localReadOnly)
    return null;
  async function resume() {
    if (api === null || move === undefined || resuming) return;
    setResuming(true);
    try {
      await api.command({ moveId: move.moveId, action: "resume" });
    } catch (error) {
      toastError(errorMessage(error));
    } finally {
      setResuming(false);
    }
  }
  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 text-ui"
    >
      <span>
        {move.confirmedAt === null
          ? move.completedSteps.includes("verify")
            ? "In Volli Cloud. This local copy is read-only until you finish the move or go back to local."
            : move.state === "waiting"
              ? `${move.message} The local copy is read-only.`
              : `${move.projectName} is read-only while it moves to Volli Cloud.`
          : `Moved to Volli Cloud (${move.workspaceName}) on ${new Date(move.confirmedAt).toLocaleDateString()}. This local copy is read-only.`}
      </span>
      <div className="flex items-center gap-2">
        {move.actions.includes("resume") ? (
          <Button
            size="xs"
            variant="outline"
            disabled={resuming || api === null}
            onClick={() => void resume()}
          >
            Resume
          </Button>
        ) : null}
        {move.actions.includes("cancel") ? (
          <Button
            size="xs"
            variant="outline"
            disabled={resuming}
            onClick={() => showCloudMoves(move.queueId, move.moveId)}
          >
            Cancel…
          </Button>
        ) : null}
        <Button size="xs" variant="outline" onClick={() => showCloudMoves(move.queueId)}>
          View move
        </Button>
      </div>
    </div>
  );
}
