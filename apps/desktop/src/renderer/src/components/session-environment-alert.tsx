import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { WrenchIcon } from "@phosphor-icons/react/dist/csr/Wrench";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useCallback, useEffect, useRef, useState } from "react";

import { errorMessage } from "@volli/shared";

import {
  sessionEnvironmentAlert,
  type SessionEnvironmentAlertState,
} from "@renderer/components/session-environment-alert-model";
import { Button } from "@renderer/components/ui/button";
import { Notice } from "@renderer/components/ui/notice";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { toastError } from "@renderer/lib/toast";
import { useUiStore } from "@renderer/stores/ui";

/**
 * The one global environment fault surface.
 *
 * A toast expires before someone starts the Session that needs these tools; a
 * modal blocks a product that may still be usable. This persistent, non-modal
 * notice is the smallest middle ground: it says the failure at first use and
 * stays visible without interrupting work. Three things keep it honest rather
 * than nagging:
 *
 * - the measurement is re-taken whenever the window regains focus (repairs
 *   happen outside this window too — a cleared fault must not keep wearing its
 *   alert);
 * - **Fix now** does the repair here, in-process, instead of telling somebody
 *   to type `volli doctor --fix` (VC-159/R7). Same work, one press;
 * - Dismiss puts away the FAULT KIND, durably (`app_state`, through the ui
 *   store), and the dismissal is dropped again the moment that fault stops
 *   being measured. It used to be component state keyed on the alert's exact
 *   sentence, which is why it came back at every relaunch. A project-readiness
 *   notice has no fault kind and is still dismissed for the view only: it is
 *   the project's onboarding state, not an app fault, and VC-156 owns retiring
 *   it altogether.
 */
export function SessionEnvironmentAlert() {
  const [alert, setAlert] = useState<SessionEnvironmentAlertState | null>(null);
  const [dismissedDetail, setDismissedDetail] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const project = useSelectedProject();
  const projectCwd = project?.path;
  const projectName = project?.name;
  const terminalFocused = useUiStore((state) => state.terminalFocusTarget !== null);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);
  const dismissedFaults = useUiStore((state) => state.dismissedEnvironmentFaults);
  const dismissEnvironmentFault = useUiStore((state) => state.dismissEnvironmentFault);
  const retainEnvironmentFaultDismissals = useUiStore(
    (state) => state.retainEnvironmentFaultDismissals,
  );
  // Token-guarded like the Settings pane's read: the answer that lands is the
  // one asked for last, whether the ask came from selection or from refocus.
  const fetchToken = useRef(0);

  /**
   * Re-measures. Resolves with what the measurement found, or `undefined` when
   * this read could not establish anything — a superseded token, a failed
   * status call. The two are NOT the same answer, and Fix now depends on the
   * difference: "the fault is gone" and "nobody could tell" must never be
   * reported to the user as the same outcome.
   */
  const load = useCallback(async (): Promise<SessionEnvironmentAlertState | null | undefined> => {
    const token = ++fetchToken.current;
    const input = projectCwd === undefined ? undefined : { cwd: projectCwd };
    try {
      const result = await window.api.cli.status(input);
      if (fetchToken.current !== token || !result.ok) return undefined;
      const measured = sessionEnvironmentAlert(
        result.status,
        projectName === undefined ? null : { name: projectName },
      );
      setAlert(measured);
      // The "cleared when the fault clears" half of the dismissal contract:
      // this measurement is the authority on which faults still exist, so a
      // dismissal for anything else is dropped here rather than lingering to
      // silence the same fault the next time it happens.
      const fault = measured === null ? null : measured.fault;
      retainEnvironmentFaultDismissals(fault === null ? [] : [fault]);
      return measured;
    } catch {
      // This read cannot establish a PATH failure, so it must not invent one.
      return undefined;
    }
  }, [projectCwd, projectName, retainEnvironmentFaultDismissals]);

  useEffect(() => {
    // A project becomes selected in the same state change that adds it, so this
    // is the onboarding check. It deliberately shares this notice rather than
    // growing a second Configure pane while VC-109 owns that repair surface.
    setAlert(null);
    void load();
  }, [load]);

  useEffect(() => {
    // Repairs happen outside this window too — an install in a terminal, a
    // profile edit — so returning focus to the app is the moment to re-measure.
    const onFocus = (): void => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  /**
   * Fix now: main re-runs both PATH passes (the work `volli doctor --fix`
   * does), then this re-measures.
   *
   * Both ways it can disappoint are said out loud. A repair that FAILED is a
   * failed mutation and toasts as one. A repair that ran and left the fault
   * standing is the quieter failure: the banner alone would look like a button
   * that did nothing, so the re-measurement's own verdict is reported.
   */
  const fix = useCallback(async () => {
    setFixing(true);
    try {
      const result = await window.api.cli.repair();
      // Re-measure either way: a repair that reported failure may still have
      // changed the world before it stopped.
      const measured = await load();
      if (!result.ok) {
        toastError(`Couldn't repair the Session PATH: ${result.error}`);
      } else if (measured !== undefined && measured !== null && measured.fault !== null) {
        toastError(
          "Volli still couldn't read your terminal's PATH. Review details for what it found.",
        );
      }
    } catch (error) {
      toastError(`Couldn't repair the Session PATH: ${errorMessage(error)}`);
    } finally {
      setFixing(false);
    }
  }, [load]);

  if (terminalFocused || alert === null) return null;
  const dismissed =
    alert.fault === null ? alert.detail === dismissedDetail : dismissedFaults.includes(alert.fault);
  if (dismissed) return null;

  return (
    <div className="shrink-0 px-2 pt-2">
      <SessionEnvironmentNotice
        alert={alert}
        fixing={fixing}
        onFix={alert.fault === null ? undefined : () => void fix()}
        onReview={() => setSettingsOpen(true, "cli")}
        onDismiss={() => {
          if (alert.fault === null) setDismissedDetail(alert.detail);
          else dismissEnvironmentFault(alert.fault);
        }}
      />
    </div>
  );
}

/** Exported drawing seam: the request state above is deliberately not part of a visual test. */
export function SessionEnvironmentNotice({
  alert,
  fixing = false,
  onFix,
  onReview,
  onDismiss,
}: {
  alert: SessionEnvironmentAlertState;
  /** The repair is running; the button says so and cannot be pressed twice. */
  fixing?: boolean;
  /** Present only for an app fault — a project's missing dependencies are not Volli's to repair. */
  onFix?: (() => void) | undefined;
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
          {onFix === undefined ? null : (
            <Button size="xs" variant="outline" disabled={fixing} onClick={onFix}>
              <WrenchIcon />
              {fixing ? "Fixing…" : "Fix now"}
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={onReview}>
            <TerminalWindowIcon />
            Review details
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
