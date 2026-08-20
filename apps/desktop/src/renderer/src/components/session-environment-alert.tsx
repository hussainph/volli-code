import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { useEffect, useState } from "react";

import {
  sessionEnvironmentAlert,
  type SessionEnvironmentAlertState,
} from "@renderer/components/session-environment-alert-model";
import { Button } from "@renderer/components/ui/button";
import { Notice } from "@renderer/components/ui/notice";
import { useUiStore } from "@renderer/stores/ui";

/**
 * The one global environment fault surface.
 *
 * A toast expires before someone starts the Session that needs these tools; a
 * modal blocks a product that may still be usable. This persistent, non-modal
 * notice is the smallest middle ground: it says the failure at first use and
 * stays until the launch that measured it ends, without interrupting work.
 */
export function SessionEnvironmentAlert() {
  const [alert, setAlert] = useState<SessionEnvironmentAlertState | null>(null);
  const terminalFocused = useUiStore((state) => state.terminalFocusTarget !== null);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);

  useEffect(() => {
    let current = true;
    void window.api.cli
      .status()
      .then((result) => {
        if (current && result.ok) setAlert(sessionEnvironmentAlert(result.status));
      })
      .catch(() => {
        // This read cannot establish a PATH failure, so it must not invent one.
      });
    return () => {
      current = false;
    };
  }, []);

  if (terminalFocused || alert === null) return null;

  return (
    <div className="shrink-0 px-2 pt-2">
      <SessionEnvironmentNotice alert={alert} onReview={() => setSettingsOpen(true, "cli")} />
    </div>
  );
}

/** Exported drawing seam: the request state above is deliberately not part of a visual test. */
export function SessionEnvironmentNotice({
  alert,
  onReview,
}: {
  alert: SessionEnvironmentAlertState;
  onReview(): void;
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
        <Button size="xs" variant="outline" onClick={onReview}>
          <TerminalWindowIcon />
          Review CLI
        </Button>
      }
    />
  );
}
