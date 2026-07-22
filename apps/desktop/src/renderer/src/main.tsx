import "@fontsource-variable/geist-mono/wght.css";
import "@fontsource-variable/mona-sans/wght.css";
import "./globals.css";
import "./typeset.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { errorMessage } from "@volli/shared";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { toast } from "sonner";

import App from "./App";
import { interruptToastModel } from "./components/sessions/interrupt-toast";
import { boot, refreshPlanningData } from "./lib/boot";
import { toastError } from "./lib/toast";
import { useBoardStore } from "./stores/board";
import { useProjectsStore } from "./stores/projects";
import { useWorkspaceStore } from "./stores/workspace";
import { initTerminalAppearance } from "./terminal/appearance";

/** Interrupt toasts outlive sonner's ~4s default: an automated de-escalation
 *  must be seen, not glimpsed (same reasoning as `toastError`'s longer window). */
const INTERRUPT_TOAST_DURATION_MS = 8000;

/** Full-window failure panel — mirrors the app's empty-state styling (see files-page.tsx). */
function BootErrorPanel({ error }: { error: string }) {
  return (
    <div className="flex h-svh w-full flex-col items-center justify-center gap-2 bg-background text-center">
      <WarningCircleIcon weight="fill" className="size-8 text-muted-foreground" />
      <h2 className="text-heading font-semibold text-foreground">Volli couldn't load its data</h2>
      <p className="max-w-md text-sm text-muted-foreground">{error}</p>
    </div>
  );
}

async function main() {
  const root = createRoot(document.getElementById("root")!);

  // Kick off the Ghostty-config fetch immediately, CONCURRENT with boot() —
  // it has no dependency on the SQLite bootstrap, and gating it behind the
  // boot round-trip needlessly widens the window where a terminal's first
  // paint lands on the token fallback (they re-theme live either way).
  void initTerminalAppearance();

  // boot() returns { ok: false } for a failed bootstrap; the catch covers the
  // unexpected throw (e.g. a corrupt pref blob exploding during rehydrate) so
  // a boot failure can never strand a blank window.
  let result: Awaited<ReturnType<typeof boot>>;
  try {
    result = await boot();
  } catch (error) {
    result = { ok: false, error: errorMessage(error) };
  }
  if (!result.ok) {
    root.render(<BootErrorPanel error={result.error} />);
    return;
  }

  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  // Backward-move interrupt announcements (issue #78, CONCEPT #20): automation
  // only ever de-escalates, and never silently — the move that Esc'd live
  // agent sessions toasts where the mover is looking, with a jump-to-ticket
  // action. Fired for BOTH move choke points (renderer drag and socket/CLI).
  window.api.sessions.onInterrupted((event) => {
    const model = interruptToastModel(
      event,
      useBoardStore.getState().ticketsByProject,
      useProjectsStore.getState().projects,
    );
    const target = model.target;
    toast(model.message, {
      duration: INTERRUPT_TOAST_DURATION_MS,
      ...(target === null
        ? {}
        : {
            action: {
              label: "View ticket",
              onClick: () =>
                useWorkspaceStore.getState().openTicket(target.projectId, target.ticketId),
            },
          }),
    });
  });

  window.api.data.onChanged(() => {
    void refreshPlanningData()
      .then((refreshResult) => {
        if (!refreshResult.ok) {
          toastError(`Could not refresh agent changes: ${refreshResult.error}`);
        }
      })
      .catch((error: unknown) => {
        toastError(`Could not refresh agent changes: ${errorMessage(error)}`);
      });
  });
}

void main();
