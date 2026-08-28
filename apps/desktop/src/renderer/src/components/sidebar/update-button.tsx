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
 *  - error      destructive tint; the tooltip carries the message, click retries
 *
 * Renders NOTHING in dev (`supported: false`, mirroring the updater's own
 * `isPackaged` guard) and nothing until main's first snapshot arrives — an
 * icon rendered from a guess would have to lie about at least one state.
 */
import { DownloadSimpleIcon } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { errorMessage } from "@volli/shared";

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

export function UpdateButton() {
  const state = useUpdateStore((store) => store.state);
  const openDialog = useUpdateStore((store) => store.openDialog);

  if (state === null || !state.supported) return null;

  const busy = state.phase === "checking" || state.phase === "downloading";
  const label =
    state.phase === "checking"
      ? "Checking for updates…"
      : state.phase === "downloading"
        ? `Downloading ${state.targetVersion ?? "update"} (${Math.round(state.percent ?? 0)}%)`
        : state.phase === "downloaded"
          ? state.targetVersion === null
            ? "Update ready. Select to install."
            : `Volli Code ${state.targetVersion} is ready. Select to install.`
          : state.phase === "error"
            ? `Update check failed: ${state.error ?? "unknown error"}. Select to retry.`
            : "Check for updates";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-update-phase={state.phase}
          // Not `disabled` while busy — a disabled trigger swallows pointer
          // events and the tooltip is where the download percent lives. The
          // click is simply inert instead.
          aria-disabled={busy}
          onClick={() => {
            if (busy) return;
            if (state.phase === "downloaded") {
              openDialog();
              return;
            }
            requestCheck();
          }}
          className={cn(
            "relative flex size-8 shrink-0 items-center justify-center rounded-md ring-ring outline-hidden",
            "transition-[transform,background-color,color] duration-100 ease-out",
            "hover:bg-sidebar-accent-veil hover:text-foreground focus-visible:ring-2",
            "active:scale-[0.97] active:bg-sidebar-accent-veil motion-reduce:scale-100!",
            state.phase === "error" ? "text-destructive" : "text-sidebar-foreground",
          )}
        >
          {busy ? <Spinner /> : <DownloadSimpleIcon className="size-4" />}
          {state.phase === "downloaded" && (
            // The badge that keeps a dismissed update visible: the attention
            // tone, because a staged install is a decision waiting on a human
            // (`status-dot.tsx`'s vocabulary), not a warning.
            <span aria-hidden className="absolute top-1 right-1 size-2 rounded-full bg-attention" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
