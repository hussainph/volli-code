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
 */
import * as React from "react";
import { DownloadSimpleIcon } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { errorMessage } from "@volli/shared";

import type { UpdateChannel } from "../../../../../ipc/contract";
import { CONTROL_W, PrefRow, PrefSection } from "@renderer/components/settings/kit";
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

const ENTER_CANARY_WARNING =
  "Canary builds ship the newest work first and break more often. You can switch back, but an installed canary won't downgrade itself. Continue?";

export function UpdatesPane() {
  const state = useUpdateStore((store) => store.state);
  const openDialog = useUpdateStore((store) => store.openDialog);
  const [channel, setChannel] = React.useState<UpdateChannel | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void window.api.updates
      .channel()
      .then((result) => {
        if (cancelled) return;
        // A dev run has no db-backed channel; the row simply stays unreadable
        // rather than claiming "stable" it cannot verify.
        if (result.ok) setChannel(result.channel);
      })
      .catch(() => {
        /* Reported by the row's own disabled state. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
      setChannel(result.channel);
    } catch (error) {
      toastError(`Couldn't change the release channel: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  const ready = state?.phase === "downloaded" && state.targetVersion !== null;

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

      <PrefSection title="Updates" icon={DownloadSimpleIcon}>
        <PrefRow
          label="Channel"
          htmlFor="update-channel"
          hint={<>Canary updates break more often, and you can&rsquo;t go back to stable.</>}
        >
          <Select
            value={channel ?? "stable"}
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
        </PrefRow>

        <PrefRow label="Current version">
          <span className="text-ui text-muted-foreground">
            {state?.currentVersion ?? "Unknown"}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={state?.supported !== true || state.phase === "checking"}
            onClick={() => void window.api.updates.check()}
          >
            {state?.phase === "checking" ? "Checking…" : "Check now"}
          </Button>
        </PrefRow>
      </PrefSection>
    </>
  );
}
