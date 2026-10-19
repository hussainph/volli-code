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
 * VC-294: the pane keeps what the last check said (`updates-pane-model.ts`),
 * and a channel it could not read says so — a disabled select showing
 * "Stable" read as a preference this install did not offer, not as a fault.
 *
 * VC-851: the select shows the line this install actually follows — a canary
 * build that never chose reads Canary. Leaving canary is honoured from the
 * next launch (the running updater is not narrowed mid-run), and an installed
 * canary is never downgraded, so the pane says both the moment it happens.
 */
import * as React from "react";
import { DownloadSimpleIcon } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { errorMessage } from "@volli/shared";

import type { UpdateChannel } from "../../../../../ipc/contract";
import { CONTROL_W, Health, PrefRow, PrefSection } from "@renderer/components/settings/kit";
import { Button } from "@renderer/components/ui/button";
import { useNow } from "@renderer/components/hosts/use-hosts";
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

/** Shown once Stable is chosen over Canary — exactly when and how it takes effect. */
const LEAVING_CANARY_DETAIL =
  "An installed canary build stays until a newer stable release is out; it never downgrades.";

const ENTER_CANARY_WARNING =
  "Canary builds ship the newest work first and break more often. You can switch back, but an installed canary won't downgrade itself. Continue?";

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

export function UpdatesPane() {
  const state = useUpdateStore((store) => store.state);
  const openDialog = useUpdateStore((store) => store.openDialog);
  const [channel, setChannel] = React.useState<UpdateChannel | null>(null);
  /** Why the channel could not be read — a fault, never a disabled preference. */
  const [channelError, setChannelError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  /** Stable was just chosen over Canary — not yet in effect (see LEAVING_CANARY_DETAIL). */
  const [leftCanary, setLeftCanary] = React.useState(false);
  const [reads, setReads] = React.useState(0);
  // The clock behind "· 3h ago", read outside render (react/purity) and
  // ticking so the age keeps up while the pane stays open.
  const now = useNow(true, 30_000);

  React.useEffect(() => {
    let cancelled = false;
    const fail = (error: string): void => {
      if (!cancelled) setChannelError(error);
    };
    window.api.updates
      .channel()
      .then((result) => {
        if (cancelled) return;
        // A broken db has no channel to read; the row says so rather than
        // claiming "stable" it cannot verify.
        if (result.ok) setChannel(result.channel);
        else fail(result.error);
      })
      .catch((error: unknown) => fail(errorMessage(error)));
    return () => {
      cancelled = true;
    };
  }, [reads]);

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
          icon={DownloadSimpleIcon}
          title={`Volli ${state?.targetVersion} is ready`}
          detail="It installs the next time you quit."
          actions={
            <Button size="xs" variant="outline" onClick={openDialog}>
              Restart now
            </Button>
          }
        />
      ) : null}
      {leftCanary ? (
        <Notice
          icon={DownloadSimpleIcon}
          title="Stable takes effect the next time Volli opens"
          detail={LEAVING_CANARY_DETAIL}
        />
      ) : null}

      <PrefSection title="Updates" icon={DownloadSimpleIcon}>
        <PrefRow
          label="Channel"
          htmlFor="update-channel"
          hint={
            <>
              Canary builds break more often, and an installed canary won&rsquo;t downgrade itself.
            </>
          }
        >
          {channelError === null ? (
            <Select
              value={channel ?? ""}
              disabled={channel === null || saving}
              onValueChange={(next) => void choose(next as UpdateChannel)}
            >
              <SelectTrigger id="update-channel" className={CONTROL_W.md}>
                <SelectValue placeholder="Loading…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stable">Stable</SelectItem>
                <SelectItem value="canary">Canary</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <>
              <span title={channelError}>
                <Health state="error">Couldn&rsquo;t read the channel</Health>
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setChannelError(null);
                  setReads((count) => count + 1);
                }}
              >
                Retry
              </Button>
            </>
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
            onClick={requestCheck}
          >
            {state?.phase === "checking" ? "Checking…" : (status?.action ?? "Check now")}
          </Button>
        </PrefRow>
      </PrefSection>
    </>
  );
}
