import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  sessionEnvironmentAlert,
  type SessionEnvironmentAlertState,
} from "@renderer/components/session-environment-alert-model";
import { Button } from "@renderer/components/ui/button";
import { Notice } from "@renderer/components/ui/notice";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { useUiStore } from "@renderer/stores/ui";

/**
 * The one global environment fault surface.
 *
 * A toast expires before someone starts the Session that needs these tools; a
 * modal blocks a product that may still be usable. This persistent, non-modal
 * notice is the smallest middle ground: it says the failure at first use and
 * stays visible without interrupting work. Two escapes keep it honest rather
 * than nagging: the measurement is re-taken whenever the window regains focus
 * (repairs happen in a terminal, outside this window — a cleared fault must
 * not keep wearing its alert), and Dismiss hides exactly the fault it named —
 * a different fault, or the same one after a relaunch, comes back.
 */
export function SessionEnvironmentAlert() {
  const [alert, setAlert] = useState<SessionEnvironmentAlertState | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const project = useSelectedProject();
  const projectCwd = project?.path;
  const projectName = project?.name;
  const terminalFocused = useUiStore((state) => state.terminalFocusTarget !== null);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);
  // Token-guarded like the Settings pane's read: the answer that lands is the
  // one asked for last, whether the ask came from selection or from refocus.
  const fetchToken = useRef(0);

  const load = useCallback(() => {
    const token = ++fetchToken.current;
    const input = projectCwd === undefined ? undefined : { cwd: projectCwd };
    void window.api.cli
      .status(input)
      .then((result) => {
        if (fetchToken.current !== token || !result.ok) return;
        setAlert(
          sessionEnvironmentAlert(
            result.status,
            projectName === undefined ? null : { name: projectName },
          ),
        );
      })
      .catch(() => {
        // This read cannot establish a PATH failure, so it must not invent one.
      });
  }, [projectCwd, projectName]);

  useEffect(() => {
    // A project becomes selected in the same state change that adds it, so this
    // is the onboarding check. It deliberately shares this notice rather than
    // growing a second Configure pane while VC-109 owns that repair surface.
    setAlert(null);
    load();
  }, [load]);

  useEffect(() => {
    // Repairs happen outside this window — volli doctor --fix or an install in
    // a terminal — so returning focus to the app is the moment to re-measure.
    const onFocus = (): void => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const alertKey = alert === null ? null : `${alert.title}\n${alert.detail}`;
  if (terminalFocused || alert === null || alertKey === dismissedKey) return null;

  return (
    <div className="shrink-0 px-2 pt-2">
      <SessionEnvironmentNotice
        alert={alert}
        onReview={() => setSettingsOpen(true, "cli")}
        onDismiss={() => setDismissedKey(alertKey)}
      />
    </div>
  );
}

/** Exported drawing seam: the request state above is deliberately not part of a visual test. */
export function SessionEnvironmentNotice({
  alert,
  onReview,
  onDismiss,
}: {
  alert: SessionEnvironmentAlertState;
  onReview(): void;
  onDismiss(): void;
}) {
  return (
    <Notice
      announce
      layout="stack"
      tone="error"
      icon={WarningIcon}
      title={alert.title}
      detail={alert.detail}
      actions={
        <>
          <Button size="xs" variant="outline" onClick={onReview}>
            <TerminalWindowIcon />
            Review CLI
          </Button>
          <Button size="xs" variant="ghost" onClick={onDismiss}>
            <XIcon />
            Dismiss
          </Button>
        </>
      }
    />
  );
}
