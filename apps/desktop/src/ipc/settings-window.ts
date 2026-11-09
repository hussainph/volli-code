import type { Result } from "@volli/shared";

/** Desktop-local presentation intent, never provider configuration or credentials. */
export interface SettingsWindowOpenInput {
  category?: string;
  configureCategory?: string;
  signInProviderId?: string;
  projectId?: string | null;
  workspaceId?: string;
}

/**
 * Main assigns a monotonic revision to every open. The Settings renderer can
 * ignore a repeated ready reply after consuming the same sign-in/configure
 * intent, and discard an older pending read after receiving a newer push.
 */
export interface SettingsWindowNavigation extends SettingsWindowOpenInput {
  revision: number;
}

export type SettingsWindowPendingNavigationResult =
  | { ok: true; navigation: SettingsWindowNavigation | null }
  | Extract<Result, { ok: false }>;

/** Settings can reveal a file or Ticket in a workspace window, never edit either. */
export type WorkspaceWindowNavigation =
  | { kind: "file"; projectId: string; relPath: string; workspaceId?: string }
  | { kind: "ticket"; projectId: string; ticketId: string; workspaceId?: string };

export type WorkspaceWindowPendingNavigationResult =
  | { ok: true; navigation: WorkspaceWindowNavigation | null }
  | Extract<Result, { ok: false }>;
