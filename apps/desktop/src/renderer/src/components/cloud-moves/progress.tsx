import * as React from "react";
import type { CloudMoveAction, CloudMoveStatus, CloudMovesApi } from "@volli/shared";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@renderer/components/ui/alert-dialog";
import { formatFileSize } from "@renderer/components/attachments/attachment-model";
import { toastError } from "@renderer/lib/toast";
import { MOVE_STEP_LABELS, MOVE_STATE_LABELS, moveTime } from "./presentation";

const ACTION_LABELS: Record<CloudMoveAction, string> = {
  pause: "Pause",
  resume: "Resume",
  cancel: "Cancel move",
  retry: "Retry",
  skip: "Skip this project",
  finish: "Finish move",
  "open-cloud": "Open in Volli Cloud",
  "go-back": "Go back to local",
  "remove-local": "Remove local copy…",
};

export function MoveProgress({ api, moves }: { api: CloudMovesApi; moves: CloudMoveStatus[] }) {
  const [busy, setBusy] = React.useState(false);
  const [confirming, setConfirming] = React.useState<{
    move: CloudMoveStatus;
    action: "go-back" | "remove-local" | "cancel";
  } | null>(null);
  const [confirmation, setConfirmation] = React.useState("");
  async function perform(moveId: string, action: CloudMoveAction) {
    if (busy) return;
    setBusy(true);
    try {
      await api.command({ moveId, action, ...(action === "remove-local" ? { confirmation } : {}) });
      setConfirming(null);
      setConfirmation("");
    } catch {
      toastError(`Couldn't complete “${ACTION_LABELS[action]}”. Try again.`);
    } finally {
      setBusy(false);
    }
  }
  async function report(moveId: string) {
    if (busy) return;
    setBusy(true);
    try {
      await navigator.clipboard.writeText(await api.report(moveId));
    } catch {
      toastError("Couldn't copy the move report. Try again.");
    } finally {
      setBusy(false);
    }
  }
  // A fresh host answer can revoke a destructive action while its confirm is open.
  const current =
    confirming === null ? null : moves.find((move) => move.moveId === confirming.move.moveId);
  const allowed = confirming !== null && current?.actions.includes(confirming.action) === true;
  return (
    <>
      <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto text-ui">
        {moves.length === 0 ? <p>No moves yet.</p> : null}
        {moves.map((move) => (
          <section
            key={move.moveId}
            aria-label={move.projectName}
            className="flex flex-col gap-2 rounded-control border border-border p-2"
          >
            <h3 className="flex justify-between gap-2 font-medium">
              <span>{move.projectName}</span>
              <span className="text-muted-foreground">{MOVE_STATE_LABELS[move.state]}</span>
            </h3>
            <p role={move.state === "problem" ? "alert" : "status"}>{move.message}</p>
            {move.state === "moving" || move.state === "waiting" ? (
              <>
                <ol aria-label="Move steps" className="flex flex-wrap gap-2 text-muted-foreground">
                  {Object.entries(MOVE_STEP_LABELS).map(([step, label]) => (
                    <li key={step} aria-current={move.step === step ? "step" : undefined}>
                      {move.completedSteps.includes(step as CloudMoveStatus["step"]) ? "✓ " : ""}
                      {label}
                    </li>
                  ))}
                </ol>
                {move.progress !== null && move.progress.total > 0 ? (
                  <>
                    <progress
                      className="w-full accent-primary"
                      aria-label={`${move.projectName} progress`}
                      max={move.progress.total}
                      value={move.progress.completed}
                    />
                    <p>
                      {move.progress.unit === "bytes"
                        ? `${formatFileSize(move.progress.completed)} / ${formatFileSize(move.progress.total)}`
                        : `${move.progress.completed.toLocaleString()} / ${move.progress.total.toLocaleString()} ${move.progress.unit === "rows" ? "records" : "Sessions"}`}
                    </p>
                  </>
                ) : null}
                <p className="text-muted-foreground">{moveTime(move.estimateSeconds)}</p>
                {move.step === "backup" ? (
                  <p className="text-muted-foreground">The snapshot cannot stop immediately.</p>
                ) : null}
              </>
            ) : null}
            {move.counts !== null && (move.state === "check" || move.state === "finished") ? (
              <p>
                {move.counts.tickets.toLocaleString()} tickets ·{" "}
                {move.counts.sessions.toLocaleString()} Sessions ·{" "}
                {move.counts.attachments.toLocaleString()} attachments
              </p>
            ) : null}
            {move.checks.length > 0 ? (
              <ul aria-label="Verification results" className="flex flex-col gap-1">
                {move.checks.map((check) => (
                  <li key={check.label}>
                    <span aria-label={check.passed ? "Passed" : "Not matched"}>
                      {check.passed ? "✓" : "!"}
                    </span>{" "}
                    {check.label}
                    {check.sourceCount === undefined
                      ? ""
                      : ` · ${check.cloudCount?.toLocaleString() ?? "—"} / ${check.sourceCount.toLocaleString()}`}
                  </li>
                ))}
              </ul>
            ) : null}
            {move.state === "check" &&
            move.checks.length > 0 &&
            move.checks.every((check) => check.passed) ? (
              <p>All checks passed. Open the project in Volli Cloud, then finish the move.</p>
            ) : null}
            {move.backupPath !== null ? (
              <p className="break-all text-muted-foreground">Backup: {move.backupPath}</p>
            ) : null}
            {move.returnExportPath !== null && move.state === "returned" ? (
              <p className="break-all">Cloud changes saved to: {move.returnExportPath}</p>
            ) : null}
            {move.pausedAutomations.length > 0 ? (
              <details>
                <summary>Paused Automations ({move.pausedAutomations.length})</summary>
                <p>Re-arm these when Automations are available in Volli Cloud.</p>
                <ul>
                  {move.pausedAutomations.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            {move.localCredentials.length > 0 ? (
              <details>
                <summary>Credentials kept on this Mac</summary>
                <p>Re-enter these on other machines.</p>
                <ul>
                  {move.localCredentials.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {move.actions.map((action) => (
                <Button
                  key={action}
                  size="sm"
                  variant={
                    action === "finish"
                      ? "default"
                      : action === "remove-local"
                        ? "destructive"
                        : "outline"
                  }
                  disabled={busy || (action === "go-back" && move.returnExportPath === null)}
                  onClick={() => {
                    if (action === "go-back" || action === "remove-local" || action === "cancel") {
                      setConfirmation("");
                      setConfirming({ move, action });
                    } else void perform(move.moveId, action);
                  }}
                >
                  {ACTION_LABELS[action]}
                </Button>
              ))}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void report(move.moveId)}
              >
                Report
              </Button>
            </div>
          </section>
        ))}
      </div>
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming?.action === "remove-local"
                ? "Remove the local copy?"
                : confirming?.action === "go-back"
                  ? "Go back to local?"
                  : "Cancel this move?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.action === "remove-local"
                ? "Removes this Mac’s archived tickets and Session history. Your folder, worktrees, cloud project and backup are kept. Going back to local will no longer be available."
                : confirming?.action === "go-back"
                  ? "Unlocks the local copy as it was before the move. Changes made in Volli Cloud since the move are saved to a readable export, not applied to the local copy. Volli Cloud keeps its copy."
                  : "The cloud copy is cleared and this project becomes writable on this Mac again. The backup is kept."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirming?.action === "go-back" ? (
            <p className="break-all text-ui">
              Export: {current?.returnExportPath ?? confirming.move.returnExportPath}
            </p>
          ) : null}
          {confirming?.action === "remove-local" && current?.backupPath ? (
            <p className="break-all text-ui">Backup kept: {current.backupPath}</p>
          ) : null}
          {confirming?.action === "remove-local" ? (
            <label className="flex flex-col gap-2 text-ui">
              Type {confirming.move.projectName} to confirm
              <Input
                aria-label="Project name to confirm removal"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                disabled={busy}
                autoComplete="off"
              />
            </label>
          ) : null}
          {!allowed && confirming !== null ? (
            <p role="alert" className="text-ui">
              This action is no longer available. Check the move’s current state.
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep as is</AlertDialogCancel>
            <Button
              variant={confirming?.action === "remove-local" ? "destructive" : "default"}
              disabled={
                busy ||
                !allowed ||
                (confirming?.action === "go-back" && current?.returnExportPath == null) ||
                (confirming?.action === "remove-local" && confirmation !== current?.projectName)
              }
              onClick={() => {
                if (confirming !== null) void perform(confirming.move.moveId, confirming.action);
              }}
            >
              {busy
                ? "Working…"
                : confirming === null
                  ? "Continue"
                  : ACTION_LABELS[confirming.action].replace("…", "")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
