import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { PackageIcon } from "@phosphor-icons/react/dist/csr/Package";
import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { errorMessage } from "@volli/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import type { CliToolStatus } from "../../../ipc/contract";

import { startProjectTerminal } from "@renderer/components/sessions/session-create";
import { Button } from "@renderer/components/ui/button";
import { Notice } from "@renderer/components/ui/notice";
import { workspaceDependenciesOffer } from "@renderer/components/workspace-dependencies-offer-model";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { toastError } from "@renderer/lib/toast";
import { useUiStore } from "@renderer/stores/ui";
import { useWorkspaceStore } from "@renderer/stores/workspace";

/**
 * The offer that replaced the dependency banner (VC-156).
 *
 * A fresh checkout without `node_modules` used to arrive as a red "Sessions
 * aren't ready" the moment the project was added. It was never a fault — it is
 * the ordinary state of a clone nobody has installed yet — and the app that was
 * reporting it is an app whose entire premise is doing that sort of thing for
 * you. So the notice is neutral, one line, and every part of it is an action:
 * the state's remedy IS the surface, which is the shape Conductor and the Codex
 * app both settled on (they run setup at workspace creation and show progress
 * in the workspace; neither ships a pre-flight warning).
 *
 * Three ways out, and no fourth. RUN types the workspace's own lockfile-derived
 * command into a real Session terminal, where its output is visible and
 * interruptible, and waits for the sentinel so the offer can withdraw itself
 * the moment the install lands. SET A SETUP COMMAND goes to Configure, where a
 * project's setup command already exists and will run this automatically for
 * every future worktree. IGNORE is a persisted per-project answer — unlike the
 * banner's string-keyed component state, which came back on every relaunch and
 * every wording change.
 *
 * Measurement follows the alert's proven shape: token-guarded reads, re-taken
 * whenever the window regains focus, because an install run outside this window
 * must not leave a stale offer on screen. It takes its OWN reading rather than
 * sharing the alert's, which costs one extra `cli.status` per project change
 * and buys the thing worth more here: two surfaces that answer different
 * questions and can be reshaped without touching each other.
 */
export function WorkspaceDependenciesOffer() {
  // The measurement, not the verdict. Dismissal is folded in at render, so
  // waving the offer off never throws away what was measured behind it.
  const [measured, setMeasured] = useState<Pick<CliToolStatus, "environment"> | null>(null);
  const [running, setRunning] = useState(false);
  const project = useSelectedProject();
  const projectId = project?.id;
  const projectCwd = project?.path;
  const dismissed = useWorkspaceStore((state) =>
    projectId === undefined
      ? true
      : (state.byProject[projectId]?.dependencyOfferDismissed ?? false),
  );
  const terminalFocused = useUiStore((state) => state.terminalFocusTarget !== null);
  const dismiss = useWorkspaceStore((state) => state.dismissDependencyOffer);
  const setNav = useWorkspaceStore((state) => state.setNav);
  // The answer that lands is the one asked for last, whether the ask came from
  // selection, from refocus, or from an install this surface itself ran.
  const fetchToken = useRef(0);

  const load = useCallback(() => {
    const token = ++fetchToken.current;
    if (projectCwd === undefined) {
      setMeasured(null);
      return;
    }
    void window.api.cli
      .status({ cwd: projectCwd })
      .then((result) => {
        if (fetchToken.current !== token || !result.ok) return;
        setMeasured(result.status);
      })
      .catch(() => {
        // A failed read cannot establish that a workspace needs installing, so
        // it must not invent an offer. The next focus asks again.
      });
  }, [projectCwd]);

  useEffect(() => {
    setMeasured(null);
    load();
  }, [load]);

  useEffect(() => {
    // Installs happen in terminals, including ones this surface never started,
    // so returning focus to the app is the moment to re-measure.
    const onFocus = (): void => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const offer = measured === null ? null : workspaceDependenciesOffer(measured, dismissed);
  const installCommand = offer?.installCommand ?? null;

  const runInstall = useCallback(async () => {
    if (projectId === undefined || installCommand === null) return;
    setRunning(true);
    try {
      // A real Session terminal, not a hidden child process: the user watches
      // the install, can interrupt it, and keeps the shell afterwards. A failed
      // start has already toasted its own reason.
      const sessionId = await startProjectTerminal(projectId);
      if (sessionId === null) return;
      const result = await window.api.terminal.run(sessionId, installCommand);
      if (!result.ok) toastError(`Couldn't run ${installCommand}: ${result.error}`);
      // A non-zero exit is NOT toasted: the command's own output is on screen
      // in the terminal that ran it, which says more than any toast could, and
      // the offer stays because the workspace still needs installing.
    } catch (error) {
      toastError(`Couldn't run ${installCommand}: ${errorMessage(error)}`);
    } finally {
      setRunning(false);
      load();
    }
  }, [installCommand, load, projectId]);

  if (terminalFocused || projectId === undefined || installCommand === null) return null;

  return (
    <div className="shrink-0 px-2 pt-2">
      <WorkspaceDependenciesNotice
        installCommand={installCommand}
        running={running}
        onRun={() => void runInstall()}
        onConfigureSetup={() => setNav(projectId, "configure")}
        onIgnore={() => dismiss(projectId)}
      />
    </div>
  );
}

/** Exported drawing seam: the request state above is deliberately not part of a visual test. */
export function WorkspaceDependenciesNotice({
  installCommand,
  running,
  onRun,
  onConfigureSetup,
  onIgnore,
}: {
  installCommand: string;
  running: boolean;
  onRun(): void;
  onConfigureSetup(): void;
  onIgnore(): void;
}) {
  return (
    <Notice
      tone="neutral"
      icon={PackageIcon}
      title={running ? `Running ${installCommand}…` : "Dependencies aren't installed yet"}
      actions={
        <>
          <Button size="xs" variant="outline" disabled={running} onClick={onRun}>
            <PlayIcon />
            Run {installCommand}
          </Button>
          <Button size="xs" variant="ghost" disabled={running} onClick={onConfigureSetup}>
            <GearSixIcon />
            Set a setup command
          </Button>
          <Button size="xs" variant="ghost" disabled={running} onClick={onIgnore}>
            <XIcon />
            Ignore
          </Button>
        </>
      }
    />
  );
}
