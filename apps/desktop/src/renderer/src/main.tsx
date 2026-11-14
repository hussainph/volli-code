import "@fontsource/space-mono/400.css";
import "@fontsource/space-mono/700.css";
import "@fontsource-variable/mona-sans/wght.css";
import "@fontsource-variable/mona-sans/wght-italic.css";
import "./globals.css";
import "./typeset.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { errorMessage } from "@volli/shared";
import { toast } from "sonner";
import { PauseCircleIcon, PlayCircleIcon } from "@renderer/components/ui/icon";

import App from "./App";
import { BootErrorPanel } from "./components/boot-error-panel";
import {
  announcePendingArmedRunSettlement,
  receivePendingArmedRuns,
} from "./components/automations/armed-run";
import { interruptToastModel } from "./components/sessions/interrupt-toast";
import { activateNotificationTarget } from "./lib/notification-activation";
import { desktopNotificationSurface } from "./lib/notification-surface";
import {
  SessionStartToastTitle,
  sessionStartToastModel,
} from "./components/sessions/session-start-toast";
import { chatTabId } from "./components/ticket/ticket-chat-tab";
import {
  boot,
  refreshPlanningData,
  startBoardProtocolIfEnabled,
  startCloudBoard,
} from "./lib/boot";
import { installRendererLogForwarding } from "./lib/renderer-log";
import { installRendererStallSignals } from "./lib/renderer-stalls";
import { bindRemoteSessionsWhileCloud } from "@renderer/lib/remote-sessions";
import { bindCloudSessions } from "@renderer/lib/cloud-sessions";
import { toastError } from "./lib/toast";
import { useBoardStore } from "./stores/board";
import { useChatSessionsStore } from "./stores/chat-sessions";
import { useProjectsStore } from "./stores/projects";
import { startStylePreferences } from "./stores/style";
import { useThemeStore } from "./stores/theme";
import { useExperimentsStore } from "./stores/experiments";
import { launchStore } from "./stores/launch";
import { attachThisMacWhileCloud } from "./stores/host-sources";
import { attachRemoteHostsWhileCloud } from "./stores/remote-host-source";
import { attachRemoteLogSourcesForPage } from "./components/logs/remote-log-sources";
import { useUpdateStore } from "./stores/update";
import { useProjectUiStore } from "./stores/project-ui";
import { watchSystemAppearance } from "./theme/canvas-paint";
import { initTerminalAppearance } from "./terminal/appearance";
import {
  acceptSettingsNavigation,
  installSettingsWindowRouting,
  isSettingsWindow,
} from "./lib/settings-window";
import { startWindowPreferenceSync } from "./lib/window-preferences";
import { acceptWorkspaceNavigation } from "./lib/workspace-window-navigation";

/** Interrupt toasts outlive sonner's ~4s default: an automated de-escalation
 *  must be seen, not glimpsed (same reasoning as `toastError`'s longer window). */
const INTERRUPT_TOAST_DURATION_MS = 8000;

async function main() {
  // This window's warnings and errors join main's log (VC-699).
  installRendererLogForwarding();
  // Its long frames and slow inputs, labelled by interaction (VC-1091).
  installRendererStallSignals();
  const root = createRoot(document.getElementById("root")!);
  const settingsWindow = isSettingsWindow();
  // Settings is a plain native pane (VC-1228); globals.css keys its palette
  // and opaque overlays on this, including overlays portalled outside it.
  if (settingsWindow) document.documentElement.dataset.window = "settings";
  installSettingsWindowRouting();
  const preferences = startWindowPreferenceSync();
  window.addEventListener("pagehide", preferences.stop, { once: true });

  // Kick off the Ghostty-config fetch immediately, CONCURRENT with boot() —
  // it has no dependency on the SQLite bootstrap, and gating it behind the
  // boot round-trip needlessly widens the window where a terminal's first
  // paint lands on the token fallback (they re-theme live either way).
  void initTerminalAppearance();

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
    if (settingsWindow) {
      // A broken bootstrap must be visible too, not an indefinitely hidden window.
      void (async () => {
        let pending = await window.api.settingsWindow.pendingNavigation();
        while (pending.ok && pending.navigation !== null) {
          const revision = pending.navigation.revision;
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          pending = await window.api.settingsWindow.ready(revision);
          if (!pending.ok || pending.navigation?.revision === revision) break;
        }
      })().catch((error: unknown) =>
        console.warn("[volli] couldn't show Settings failure:", error),
      );
    }
    return;
  }

  // boot() installs the stored canvas/appearance before its restored-project
  // listener requests that scope's theme state. A concurrent global request
  // could instead paint the default `auto` mode over preload's first-paint
  // hint, exposing one dark frame in a stored-light launch. With no project,
  // there is no selection announcement, so request the global terminal chain
  // here. The independent Ghostty-config warmup above remains concurrent.
  if (useProjectsStore.getState().selectedProjectId === null) {
    void useThemeStore.getState().hydrate();
  }
  await startStylePreferences();
  preferences.activate();
  if (settingsWindow) {
    window.api.settingsWindow.onNavigate(acceptSettingsNavigation);
    const pending = await window.api.settingsWindow.pendingNavigation();
    if (!pending.ok) {
      root.render(<BootErrorPanel error={pending.error} />);
      return;
    }
    if (pending.navigation !== null) acceptSettingsNavigation(pending.navigation);
  } else {
    let received = false;
    window.api.settingsWindow.onWorkspaceNavigate((navigation) => {
      received = true;
      acceptWorkspaceNavigation(navigation);
    });
    const pending = await window.api.settingsWindow.pendingWorkspaceNavigation();
    if (!pending.ok) toastError(`Couldn't open workspace: ${pending.error}`);
    else if (!received && pending.navigation !== null)
      acceptWorkspaceNavigation(pending.navigation);
  }

  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  // A cloud launch (VC-889): the board is Volli Cloud's, read by this
  // window's own client. A local launch with the `cloud` flag on follows a
  // remote host's projects over the board protocol (VC-711); with the flag
  // off this reads the flag and does nothing else.
  const cloudLaunch = launchStore() === "cloud";
  if (cloudLaunch) {
    if (!settingsWindow) {
      const stopSessions = bindCloudSessions();
      window.addEventListener("pagehide", stopSessions, { once: true });
    }
    void startCloudBoard();
  } else void startBoardProtocolIfEnabled();

  // Backward-move interrupt announcements (issue #78, CONCEPT #20): automation
  // only ever de-escalates, and never silently — the move that Esc'd live
  // agent sessions toasts where the mover is looking, with a jump-to-ticket
  // action. Fired for BOTH move choke points (renderer drag and socket/CLI).
  window.api.sessions.onInterrupted((event) => {
    if (cloudLaunch || settingsWindow) return;
    const model = interruptToastModel(
      event,
      useBoardStore.getState().ticketsByProject,
      useProjectsStore.getState().projects,
    );
    const target = model.target;
    toast(model.message, {
      icon: <PauseCircleIcon aria-hidden className="size-4" />,
      duration: INTERRUPT_TOAST_DURATION_MS,
      ...(target === null
        ? {}
        : {
            action: {
              label: "View ticket",
              // Route through the nav-intent seam, not bare openTicket: the toast
              // can fire from any nav (Files/Sessions), and detail only renders on
              // the Board — openTicketView switches nav so the ticket actually
              // appears (the same fix the composer kickoff needed).
              onClick: () =>
                useProjectUiStore.getState().openTicketView(target.projectId, target.ticketId),
            },
          }),
    });
  });

  // Socket-originated Session starts (VC-13): the app must not navigate or
  // steal focus when a `volli session start` lands — the toast names the new
  // Session separately from its starter; only its action opens the new tab
  // (the same adopt + open pair the sidebar's chat rows make).
  window.api.sessions.onStarted((notice) => {
    if (cloudLaunch || settingsWindow) return;
    const model = sessionStartToastModel(notice);
    const target = model.target;
    toast(<SessionStartToastTitle notice={notice} />, {
      description: model.description,
      icon: <PlayCircleIcon aria-hidden className="size-4" />,
      duration: INTERRUPT_TOAST_DURATION_MS,
      action: {
        label: "Open session",
        onClick: () => {
          const chat = useChatSessionsStore.getState();
          chat.adoptChatSession(target.sessionId);
          chat.openChatTab(target.ticketId, target.sessionId);
          useProjectUiStore.getState().openTicketView(target.projectId, target.ticketId, {
            tabId: chatTabId(target.sessionId),
          });
        },
      },
    });
  });

  // A clicked native alert (VC-295). Main has already brought this window
  // forward; what the target MEANS on screen — select the Session, then reveal
  // the question or failure it named, or say why that item is gone — is the
  // renderer's own knowledge, so the routing lives here.
  //
  // Subscribe FIRST, then collect anything parked: a click that arrived with
  // every window closed opened this one, and its target has been waiting in
  // main ever since. Ordering the other way would drop a push that landed
  // between the read and the listener.
  if (!settingsWindow) {
    window.api.notifications.onActivated(
      (target) => void activateNotificationTarget(target, desktopNotificationSurface),
    );
    window.api.notifications
      .pendingActivation()
      .then((pending) => {
        if (pending.ok && pending.target !== null)
          void activateNotificationTarget(pending.target, desktopNotificationSurface);
      })
      .catch((error: unknown) => {
        // A click whose target could not be collected leaves the window open on
        // whatever it was showing — which is where the click brought it anyway.
        // There is no route the person can retry, but retain the diagnostic rather
        // than silently losing the failure.
        console.warn("[volli] couldn't collect notification activation:", error);
      });
  }

  // Self-update state (VC-59): subscribe FIRST, then prime with a one-time
  // read — a download that finished before this window existed must still
  // light the badge. The prime only fills an empty store: a push that raced
  // ahead of it is newer by construction and must not be clobbered.
  window.api.updates.onState((state) => useUpdateStore.getState().receive(state, !settingsWindow));
  window.api.updates
    .state()
    .then((read) => {
      if (read.ok && useUpdateStore.getState().state === null) {
        useUpdateStore.getState().receive(read.state, !settingsWindow);
      }
    })
    .catch(() => {
      // A failed boot read leaves the icon unrendered; the next push heals it.
    });

  // The host's experiment flags (VC-576): what flagged surfaces such as the
  // title bar's host chip read. Off until the answer lands; a failure stays off.
  void useExperimentsStore.getState().ensure();
  // This Mac, the in-process host, feeds the host-connection store while
  // `cloud` is on, and nothing is attached while it is off; VC-700's registry
  // attaches remote hosts beside it. Only flagged surfaces read it.
  // A cloud launch shows Volli Cloud's projects only: its one host is Volli
  // Cloud (attached by `startCloudBoard`), and no remote host's is shown.
  if (!cloudLaunch) {
    attachThisMacWhileCloud();
    attachRemoteHostsWhileCloud();
    // Sessions on a remote host (VC-713): their chat, listing and re-reads go
    // over each project's Workspace link while `cloud` is on; off, nothing is
    // registered and every Session is This Mac's.
    if (!settingsWindow) bindRemoteSessionsWhileCloud();
    // Each connected remote host's log, in the one log viewer (VC-712): only
    // hosts that store lists, so nothing registers while `cloud` is off. The
    // page owns it: pagehide unregisters every source and stops its readings.
    attachRemoteLogSourcesForPage({ shown: () => useProjectsStore.getState().selectedProjectId });
  }

  // Main owns one durable armed-column countdown per move (VC-226). Subscribe
  // before priming so a window opened mid-countdown cannot miss a replacement
  // between its read and listener registration. Every window receives the same
  // whole snapshot; Cancel travels back to main with the exact arrival id.
  // Cloud arrivals come from the renderer’s Convex source. Never read or
  // subscribe to this Mac’s frozen countdowns in a cloud window.
  if (!cloudLaunch && !settingsWindow) {
    window.api.automations.onPendingArmedRunsChanged(receivePendingArmedRuns);
    window.api.automations.onPendingArmedRunSettled(announcePendingArmedRunSettlement);
    window.api.automations
      .pendingArmedRuns()
      .then((pending) => {
        if (pending.ok) {
          receivePendingArmedRuns(pending.pending);
          // A failed expiry can outlive every renderer and the app process. Its
          // retained command id stays in main; a newly opened window restores
          // the retry action from this renderer-safe projection.
          for (const failure of pending.failures) {
            announcePendingArmedRunSettlement({ kind: "failed", ...failure });
          }
        } else toastError(`Couldn't load pending automations: ${pending.error}`);
      })
      .catch((error: unknown) => {
        toastError(`Couldn't load pending automations: ${errorMessage(error)}`);
      });
  }

  window.api.data.onChanged((event) => {
    // Forward the payload's scope (affected ticket/project, or untargeted) so
    // per-ticket surfaces can skip a refetch that's provably for another ticket.
    // `kind` rides along for the one reader that acts on it: a `worktree` change
    // moved a ticket's CHECKOUT, and its cached working copy reading belongs to the
    // checkout it was taken in (VC-286).
    void refreshPlanningData({
      ticketId: event.ticketId,
      projectId: event.projectId,
      kind: event.kind,
    })
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
