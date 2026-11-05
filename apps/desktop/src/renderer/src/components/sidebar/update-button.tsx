/**
 * The sidebar's download icon (VC-59): the one place the self-updater is
 * visible and drivable. Sits in the footer beside Settings, square where the
 * Settings row is wide — a rare, occasionally-important control must not
 * compete with a daily one for the same full-width row.
 *
 * State-driven, one presentation per updater phase:
 *  - idle       plain icon; click runs a real check against the feed
 *  - checking   spinner (the click already landed — nothing else to offer)
 *  - downloading spinner + tooltip carrying version and percent
 *  - downloaded  icon + attention dot; click (re)opens the install dialog
 *  - error      destructive tint; click opens expandable details and Retry
 *
 * Renders NOTHING in dev (`supported: false`, mirroring the updater's own
 * `isPackaged` guard) and nothing until main's first snapshot arrives — an
 * icon rendered from a guess would have to lie about at least one state.
 */
import { useState } from "react";
import { Button } from "@renderer/components/ui/button";
import { Notice } from "@renderer/components/ui/notice";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { DownloadIcon } from "@renderer/components/ui/icon";

import { errorMessage, summarizeUpdateFailure, UPDATE_FAILURE_FALLBACK } from "@volli/shared";

import { Spinner } from "@renderer/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";
import { useUpdateStore } from "@renderer/stores/update";

/** Runs the explicit check; only a failure to even ASK surfaces here (outcomes ride the state pushes). */
function requestCheck(): void {
  window.api.updates
    .check()
    .then((result) => {
      if (!result.ok) toastError(`Couldn't check for updates: ${result.error}`);
    })
    .catch((error: unknown) => {
      toastError(`Couldn't check for updates: ${errorMessage(error)}`);
    });
}

function failureLabel(error: string | null): string {
  const summary = summarizeUpdateFailure(error ?? UPDATE_FAILURE_FALLBACK).replace(/\.$/u, "");
  return `Update check failed: ${summary}`;
}

export function UpdateButton() {
  const state = useUpdateStore((store) => store.state);
  const openDialog = useUpdateStore((store) => store.openDialog);
  const [errorOpen, setErrorOpen] = useState(false);

  if (state === null || !state.supported) return null;

  const busy = state.phase === "checking" || state.phase === "downloading";
  const label =
    state.phase === "checking"
      ? "Checking for updates"
      : state.phase === "downloading"
        ? `Downloading ${state.targetVersion ?? "update"} (${Math.round(state.percent ?? 0)}%)`
        : state.phase === "downloaded"
          ? state.targetVersion === null
            ? "Install update"
            : `Install Volli Code ${state.targetVersion}`
          : state.phase === "error"
            ? failureLabel(state.error)
            : "Check for updates";

  return (
    <Popover
      open={errorOpen && state.phase === "error"}
      onOpenChange={(open) => {
        if (state.phase === "error") setErrorOpen(open);
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="icon-lg"
              type="button"
              aria-label={label}
              data-update-phase={state.phase}
              // Not `disabled` while busy — a disabled trigger swallows pointer
              // events and the tooltip is where the download percent lives. The
              // click is simply inert instead.
              aria-disabled={busy}
              onClick={() => {
                if (busy || state.phase === "error") return;
                if (state.phase === "downloaded") {
                  openDialog();
                  return;
                }
                requestCheck();
              }}
              className={cn(
                "relative shrink-0 hover:bg-sidebar-accent-veil hover:text-foreground",
                state.phase === "error" ? "text-destructive" : "text-sidebar-foreground",
              )}
            >
              {busy ? <Spinner /> : <DownloadIcon className="size-4" />}
              {state.phase === "downloaded" && (
                // The badge that keeps a dismissed update visible: the attention
                // tone, because a staged install is a decision waiting on a human
                // (`status-dot.tsx`'s vocabulary), not a warning.
                <span
                  aria-hidden
                  className="absolute top-1 right-1 size-2 rounded-full bg-attention"
                />
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-sm whitespace-normal [overflow-wrap:anywhere]">
          {label}
        </TooltipContent>
      </Tooltip>
      {state.phase === "error" ? (
        <PopoverContent
          side="top"
          align="end"
          className="w-96 max-w-[calc(100vw-2rem)] max-h-96 overflow-y-auto p-2"
        >
          <Notice
            tone="error"
            layout="stack"
            title="Couldn't check for updates"
            detail={summarizeUpdateFailure(state.error ?? UPDATE_FAILURE_FALLBACK)}
            actions={
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setErrorOpen(false);
                  requestCheck();
                }}
              >
                Retry update check
              </Button>
            }
          />
        </PopoverContent>
      ) : null}
    </Popover>
  );
}
