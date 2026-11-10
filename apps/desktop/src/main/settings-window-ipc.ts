import type { WebContents } from "electron";
import type {
  SettingsWindowNavigation,
  SettingsWindowOpenInput,
  VolliIpcEvent,
  WorkspaceWindowNavigation,
} from "../ipc/contract";
import { SETTINGS_WINDOW_IPC } from "./ipc-descriptors";
import { registerGuardedIpcHandlers } from "./ipc-registry";

/** Native window ownership stays in main's composition root, not the transport. */
export interface SettingsWindowIpcPorts {
  open(input: SettingsWindowOpenInput, requester: WebContents): void | Promise<void>;
  /**
   * Read before mounting React, after subscribing to onNavigate. The controller
   * verifies this is its Settings WebContents and returns the current intent
   * without revealing the window or marking the renderer ready.
   */
  pendingNavigation(
    requester: WebContents,
  ): SettingsWindowNavigation | null | Promise<SettingsWindowNavigation | null>;
  /**
   * Called after React paints appliedRevision. The controller verifies the
   * requester and compares that revision with its current navigation. A stale
   * acknowledgement returns the latest intent without revealing the window;
   * the renderer applies it and acknowledges again after the next paint. Reveal
   * only when the current revision is acknowledged and native ready-to-show has
   * happened. Subsequent opens use sendSettingsWindowNavigation; a reload resets
   * the readiness latch. Clients ignore stale/already-consumed intent revisions.
   */
  ready(
    appliedRevision: number,
    requester: WebContents,
  ): SettingsWindowNavigation | null | Promise<SettingsWindowNavigation | null>;
  openWorkspace(input: WorkspaceWindowNavigation, requester: WebContents): void | Promise<void>;
  /**
   * The workspace renderer subscribes before calling this. The controller
   * verifies the requester, marks its listener ready, and consumes any parked
   * navigation. Later requests target that renderer with the send helper.
   */
  pendingWorkspaceNavigation(
    requester: WebContents,
  ): WorkspaceWindowNavigation | null | Promise<WorkspaceWindowNavigation | null>;
}

/** Desktop-only, DB-independent guard → body → failure envelope. */
export function registerSettingsWindowIpcHandlers(ports: SettingsWindowIpcPorts): void {
  registerGuardedIpcHandlers(SETTINGS_WINDOW_IPC, {
    "volli:settings-window-open": async (input, requester) => {
      await ports.open(input, requester);
      return { ok: true };
    },
    "volli:settings-window-pending-navigation": async (requester) => ({
      ok: true,
      navigation: await ports.pendingNavigation(requester),
    }),
    "volli:settings-window-ready": async (appliedRevision, requester) => ({
      ok: true,
      navigation: await ports.ready(appliedRevision, requester),
    }),
    "volli:settings-window-open-workspace": async (input, requester) => {
      await ports.openWorkspace(input, requester);
      return { ok: true };
    },
    "volli:settings-window-pending-workspace-navigation": async (requester) => ({
      ok: true,
      navigation: await ports.pendingWorkspaceNavigation(requester),
    }),
  });
}

/** One chosen Settings window, never a broadcast to workspace windows. */
export function sendSettingsWindowNavigation(
  target: WebContents,
  navigation: SettingsWindowNavigation,
): void {
  target.send("volli:settings-window-navigate" satisfies VolliIpcEvent, navigation);
}

/** Reveal in one workspace renderer, not in the Settings renderer or every window. */
export function sendWorkspaceWindowNavigation(
  target: WebContents,
  navigation: WorkspaceWindowNavigation,
): void {
  target.send("volli:workspace-window-navigate" satisfies VolliIpcEvent, navigation);
}
