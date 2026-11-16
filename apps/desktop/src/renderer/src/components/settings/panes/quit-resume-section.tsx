/**
 * Settings → Agents → Restart (VC-1245): whether a turn a deliberate quit cut
 * short resumes on its own at the next launch. Off by default. The switch only
 * sets the host's setting; the restart-resume verdict decides each turn, and a
 * quit with a tool in flight waits for the person whichever way it is set.
 */
import * as React from "react";
import { errorMessage } from "@volli/shared";

import { PrefRow, PrefSection } from "@renderer/components/settings/kit";
import { RefreshIcon } from "@renderer/components/ui/icon";
import { Notice } from "@renderer/components/ui/notice";
import { Switch } from "@renderer/components/ui/switch";
import { toastError } from "@renderer/lib/toast";

type ReadState =
  | { status: "loading" }
  | { status: "ready"; autoResume: boolean }
  | { status: "error"; message: string };

export function QuitResumeSection() {
  const [state, setState] = React.useState<ReadState>({ status: "loading" });

  React.useEffect(() => {
    let live = true;
    // Asked inside the chain, so a door that is not there reads as a failed
    // read rather than throwing out of the effect.
    void Promise.resolve()
      .then(() => window.api.quitResume.get())
      .then(
        (result) => {
          if (!live) return;
          setState(
            result.ok
              ? { status: "ready", autoResume: result.autoResume }
              : { status: "error", message: result.error },
          );
        },
        (error: unknown) => {
          if (live) setState({ status: "error", message: errorMessage(error) });
        },
      );
    return () => {
      live = false;
    };
  }, []);

  async function save(autoResume: boolean): Promise<void> {
    const previous = state;
    setState({ status: "ready", autoResume });
    try {
      const result = await window.api.quitResume.set(autoResume);
      if (!result.ok) {
        setState(previous);
        toastError(`Couldn't save that: ${result.error}`);
        return;
      }
      setState({ status: "ready", autoResume: result.autoResume });
    } catch (error) {
      setState(previous);
      toastError(`Couldn't save that: ${errorMessage(error)}`);
    }
  }

  return (
    <PrefSection title="Restart" icon={RefreshIcon}>
      {state.status === "error" ? (
        <Notice tone="error" title="Couldn't read restart settings" detail={state.message} />
      ) : (
        <PrefRow label="Resume after quit" testId="quit-resume">
          <Switch
            aria-label="Resume after quit"
            checked={state.status === "ready" && state.autoResume}
            disabled={state.status !== "ready"}
            onCheckedChange={(next) => void save(next)}
          />
        </PrefRow>
      )}
    </PrefSection>
  );
}
