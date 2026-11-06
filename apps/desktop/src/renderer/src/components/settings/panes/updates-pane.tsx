import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import { LoadingLabel } from "@renderer/components/ui/loading-label";
/**
 * Settings → Updates: which release line this install follows, and what is on
 * offer right now.
 *
 * THIS PANE IS WHY THE `sqlite3` COMMAND IS GONE. `auto-update.ts` used to
 * carry a comment saying there was no UI for the prerelease toggle, followed by
 * an `INSERT` for people to run by hand against the app's own live WAL-mode
 * database. That is not a setting; it is a workaround with a footgun in it.
 *
 * A `Select` rather than two pills, and a confirm on the way in: a build line
 * that ships broken work and will not downgrade itself is not a one-click
 * toggle. The confirm is one-directional on purpose — leaving canary is always
 * safe, so only entering it asks.
 *
 * The pane keeps what the last check said (`updates-pane-model.ts`), and a
 * channel it could not read says so — a disabled select showing "Stable" read
 * as a preference this install did not offer, not as a fault.
 *
 * The select shows the line this install actually follows — a canary build
 * that never chose reads Canary. Leaving canary is honoured from the next
 * launch (the running updater is not narrowed mid-run), and an installed canary
 * is never downgraded, so the pane says both the moment it happens.
 */
import * as React from "react";
import { DownloadIcon } from "@renderer/components/ui/icon";

import { errorMessage } from "@volli/shared";

import type { UpdateChannel } from "../../../../../ipc/contract";
import { CONTROL_W, Health, PrefRow, PrefSection } from "@renderer/components/settings/kit";
import { useNow } from "@renderer/components/hosts/use-hosts";
import { Button } from "@renderer/components/ui/button";
import { Notice } from "@renderer/components/ui/notice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { toastError } from "@renderer/lib/toast";
import { useUpdateStore } from "@renderer/stores/update";

import { updateStatus } from "./updates-pane-model";

/** The one caution at the moment of the choice; the Channel row itself carries none. */
const ENTER_CANARY_WARNING =
  "Canary builds break more often, and an installed canary won't downgrade itself. Continue?";

async function check() {
  try {
    const result = await window.api.updates.check();
    if (!result.ok) toastError(`Couldn't check for updates: ${result.error}`);
  } catch (cause) {
    toastError(`Couldn't check for updates: ${errorMessage(cause)}`);
  }
}

export function UpdatesPane() {
  const state = useUpdateStore((store) => store.state);
  const openDialog = useUpdateStore((store) => store.openDialog);
  const [channel, setChannel] = React.useState<UpdateChannel | null>(null);
  const [channelError, setChannelError] = React.useState<string | null>(null);
  const reads = useLatestAsync();
  const [saving, setSaving] = React.useState(false);
  /** Stable was just chosen over Canary — not yet in effect (see LEAVING_CANARY_DETAIL). */
  const [leftCanary, setLeftCanary] = React.useState(false);
  // The clock behind "· 3h ago", read outside render (react/purity) and
  // ticking so the age keeps up while the pane stays open.
  const now = useNow(true, 30_000);

  const load = React.useCallback(async () => {
    const token = reads.claim();
    setChannelError(null);
    try {
      const result = await window.api.updates.channel();
      if (!reads.isCurrent(token)) return;
      if (result.ok) setChannel(result.channel);
      else setChannelError(result.error);
    } catch (cause) {
      if (reads.isCurrent(token)) setChannelError(errorMessage(cause));
    }
  }, [reads]);
  React.useEffect(() => {
    void load();
    return () => reads.invalidate();
  }, [load, reads]);

  async function choose(next: UpdateChannel): Promise<void> {
    if (saving || next === channel) return;
    if (next === "canary" && !window.confirm(ENTER_CANARY_WARNING)) return;
    setSaving(true);
    try {
      const result = await window.api.updates.setChannel(next);
      if (!result.ok) {
        toastError(`Couldn't change the release channel: ${result.error}`);
        return;
      }
      setLeftCanary(channel === "canary" && result.channel === "stable");
      setChannel(result.channel);
    } catch (error) {
      toastError(`Couldn't change the release channel: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  const ready = state?.phase === "downloaded" && state.targetVersion !== null;
  const status = state === null ? null : updateStatus(state, now);

  return (
    <>
      {ready ? (
        <Notice
          tone="positive"
          dismissalKey={`settings:updates:ready:${state?.targetVersion}`}
          icon={DownloadIcon}
          title={`Volli ${state?.targetVersion} is ready`}
          actions={
            <Button size="xs" variant="outline" onClick={openDialog}>
              Restart now
            </Button>
          }
        />
      ) : null}
      {leftCanary ? (
        <Notice icon={DownloadIcon} title="Stable takes effect the next time Volli opens" />
      ) : null}

      <PrefSection title="Updates" icon={DownloadIcon}>
        <PrefRow label="Channel" htmlFor="update-channel">
          {channelError ? (
            <Notice
              tone="error"
              title="Couldn't read the release channel"
              detail={channelError}
              actions={
                <Button size="sm" onClick={() => void load()}>
                  Retry
                </Button>
              }
            />
          ) : channel === null ? null : (
            <Select
              value={channel}
              disabled={channel === null || saving}
              onValueChange={(next) => void choose(next as UpdateChannel)}
            >
              <SelectTrigger id="update-channel" className={CONTROL_W.md}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stable">Stable</SelectItem>
                <SelectItem value="canary">Canary</SelectItem>
              </SelectContent>
            </Select>
          )}
        </PrefRow>

        <PrefRow label="Current version">
          <span className="text-ui text-muted-foreground">
            {state?.currentVersion ?? "Unknown"}
          </span>
        </PrefRow>

        {/* Always drawn: before the store's first snapshot the button stays,
            disabled, rather than the row appearing late. */}
        <PrefRow label="Status">
          {status === null ? null : (
            <div className="flex min-w-0 flex-col items-end">
              <Health state={status.state}>{status.label}</Health>
              {status.detail === null ? null : (
                <span className={`${CONTROL_W.lg} text-right text-ui text-muted-foreground`}>
                  {status.detail}
                </span>
              )}
            </div>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={state?.supported !== true || state.phase === "checking"}
            onClick={() => void check()}
          >
            {state?.phase === "checking" ? (
              <LoadingLabel>Checking</LoadingLabel>
            ) : (
              (status?.action ?? "Check now")
            )}
          </Button>
        </PrefRow>
      </PrefSection>
    </>
  );
}
