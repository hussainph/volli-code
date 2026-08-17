import "@fontsource-variable/geist-mono/wght.css";
import "@fontsource-variable/mona-sans/wght.css";
import "@fontsource-variable/mona-sans/wght-italic.css";
import "./globals.css";
import "./typeset.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { errorMessage } from "@volli/shared";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { toast } from "sonner";

import App from "./App";
import { interruptToastModel } from "./components/sessions/interrupt-toast";
import { sessionStartToastModel } from "./components/sessions/session-start-toast";
import { chatTabId } from "./components/ticket/ticket-chat-tab";
import { boot, refreshPlanningData } from "./lib/boot";
import { toastError } from "./lib/toast";
import { useBoardStore } from "./stores/board";
import { useChatSessionsStore } from "./stores/chat-sessions";
import { useProjectsStore } from "./stores/projects";
import { useThemeStore } from "./stores/theme";
import { useUpdateStore } from "./stores/update";
import { useWorkspaceStore } from "./stores/workspace";
import { watchSystemAppearance } from "./theme/canvas-paint";
import { initTerminalAppearance } from "./terminal/appearance";

/** Interrupt toasts outlive sonner's ~4s default: an automated de-escalation
 *  must be seen, not glimpsed (same reasoning as `toastError`'s longer window). */
const INTERRUPT_TOAST_DURATION_MS = 8000;

/** Full-window failure panel — mirrors the app's empty-state styling (see files-page.tsx). */
function BootErrorPanel({ error }: { error: string }) {
  return (
    <div className="flex h-svh w-full flex-col items-center justify-center gap-2 bg-background text-center">
      <WarningCircleIcon className="size-8 text-muted-foreground" />
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

  // Same reasoning for the terminal/editor half of the theme state: it is a db
  // read with no dependency on the bootstrap payload, so fetching it
  // concurrently only narrows the window where a non-default value hasn't
  // landed yet. The CANVAS half rides in on the bootstrap payload instead and
  // is adopted in boot() — there is deliberately no second read path for it.
  void useThemeStore.getState().hydrate();
  // The `auto` half of the appearance setting: a real OS flip, pushed from main
  // because this process cannot see one (its own `prefers-color-scheme` query
  // answers from the mode the app stamped — see theme/canvas-paint.ts).
  // Registered here rather than at import time in canvas-paint.ts so the
  // listener's lifetime belongs to the app rather than to whoever happened to
  // import the module first.
  watchSystemAppearance((prefersDark) => {
    useThemeStore.getState().noteSystemAppearance(prefersDark);
  });
  // The broadcast is global-scope by contract (main/ghostty-config.ts), so it
  // is handed to the store as such — a project scope re-reads its own layered
  // resolution instead of adopting global values under a project's label.
  window.api.terminal.onGhosttyConfigChanged((payload) => {
    useThemeStore.getState().acceptGlobalTerminal(payload);
  });

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
              // Route through the nav-intent seam, not bare openTicket: the toast
              // can fire from any nav (Files/Sessions), and detail only renders on
              // the Board — openTicketWorkspace switches nav so the ticket actually
              // appears (the same fix the composer kickoff needed).
              onClick: () =>
                useWorkspaceStore.getState().openTicketWorkspace(target.projectId, target.ticketId),
            },
          }),
    });
  });

  // Socket-originated Session starts (VC-13): the app must not navigate or
  // steal focus when a `volli session start` lands — the toast names the actor
  // and ticket, and its action is the only door into the new session's tab
  // (the same adopt + open pair the sidebar's chat rows make).
  window.api.sessions.onStarted((notice) => {
    const model = sessionStartToastModel(notice);
    const target = model.target;
    toast(model.message, {
      duration: INTERRUPT_TOAST_DURATION_MS,
      action: {
        label: "Open session",
        onClick: () => {
          const chat = useChatSessionsStore.getState();
          chat.adoptChatSession(target.sessionId);
          chat.openChatTab(target.ticketId, target.sessionId);
          useWorkspaceStore.getState().openTicketWorkspace(target.projectId, target.ticketId, {
            tabId: chatTabId(target.sessionId),
          });
        },
      },
    });
  });

  // Self-update state (VC-59): subscribe FIRST, then prime with a one-time
  // read — a download that finished before this window existed must still
  // light the badge. The prime only fills an empty store: a push that raced
  // ahead of it is newer by construction and must not be clobbered.
  window.api.updates.onState((state) => useUpdateStore.getState().receive(state));
  window.api.updates
    .state()
    .then((read) => {
      if (read.ok && useUpdateStore.getState().state === null) {
        useUpdateStore.getState().receive(read.state);
      }
    })
    .catch(() => {
      // A failed boot read leaves the icon unrendered; the next push heals it.
    });

  window.api.data.onChanged((event) => {
    // Forward the payload's scope (affected ticket/project, or untargeted) so
    // per-ticket surfaces can skip a refetch that's provably for another ticket.
    void refreshPlanningData({ ticketId: event.ticketId, projectId: event.projectId })
      .then((refreshResult) => {
        if (!refreshResult.ok) {
          toastError(`Couldn't refresh agent changes: ${refreshResult.error}`);
        }
      })
      .catch((error: unknown) => {
        toastError(`Couldn't refresh agent changes: ${errorMessage(error)}`);
      });
  });
}

void main();
