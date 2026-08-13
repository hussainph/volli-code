/**
 * The one-shot messages a launch has to hand to a Toaster that did not exist
 * when they were raised.
 *
 * Two hooks rather than one, because they are two decisions — whether a legacy
 * import failed, and whether this window was opened by the CLI — but one module,
 * because they are the same MECHANISM and change for the same reason: something
 * before the first render learned a fact worth one sentence, stashed it, and
 * needs it surfaced exactly once when a Toaster is finally mounted. Both `take`
 * as they read, so StrictMode's double-invoke cannot say it twice.
 */
import * as React from "react";
import { toast } from "sonner";

import { takeBootNotice } from "@renderer/lib/boot-notice";
import { takeCliLaunchNotice } from "@renderer/lib/cli-launch-notice";
import { toastError } from "@renderer/lib/toast";

/**
 * Surfaces a one-shot boot notice (e.g. a failed legacy import). boot() runs
 * before the Toaster mounts, so it stashes the message rather than toasting
 * directly (see lib/boot-notice.ts).
 */
export function useBootNotice(): void {
  React.useEffect(() => {
    const notice = takeBootNotice();
    if (notice !== null) toastError(notice);
  }, []);
}

/** Surfaces what the `volli` CLI asked for, when the CLI is what opened us. */
export function useCliLaunchNotice(): void {
  React.useEffect(() => {
    const notice = takeCliLaunchNotice(window.api.app.launchedByCli);
    if (notice !== null) toast.info(notice);
  }, []);
}
