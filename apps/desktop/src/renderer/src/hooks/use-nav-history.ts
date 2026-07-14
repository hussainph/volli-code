/**
 * Wires the pure nav-history reducer (lib/nav-history.ts) to the live app: it
 * is the single choke point that RECORDS navigation, APPLIES ←/→ steps back to
 * the stores, and binds the ⌘[ / ⌘] / ⌥⌘B shortcuts.
 *
 * A "location" is derived from two stores — the selected project (projects
 * store) and that project's nav page + open ticket (workspace store). Rather
 * than instrument every navigating action across both stores, we subscribe to
 * both and record whenever the derived location changes. That catches every
 * path uniformly: project switch, sidebar nav change, ticket open, and
 * Escape/programmatic ticket close all just move the same derived location.
 *
 * Applying a history step must NOT record (that would clobber the forward
 * stack), so application runs behind an `applying` guard the recorder honors.
 * The dedupe in recordNav is a second line of defense: after a step, the live
 * location already equals the step's snapshot, so even a leaked record no-ops.
 *
 * `navBack` / `navForward` are module-level (not hook-bound) so the chrome-bar
 * buttons can call them directly; the shortcuts and the recording subscription
 * are set up by `useNavHistory`, mounted once from the app shell.
 */
import * as React from "react";

import {
  isEditingTarget,
  isNavBackKeyEvent,
  isNavForwardKeyEvent,
  isRailToggleKeyEvent,
  sameSnapshot,
  type NavKeyEvent,
  type NavSnapshot,
} from "@renderer/lib/nav-history";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";
import { DEFAULT_WORKSPACE_UI, useWorkspaceStore } from "@renderer/stores/workspace";

/**
 * True while a history step is being applied to the stores, so the recorder
 * subscription ignores the resulting store writes instead of recording them as
 * fresh navigations. Module-level because both the applier and the subscriber
 * live here and must share it.
 */
let applying = false;

/**
 * The last location the recorder has seen. Lets the subscription short-circuit
 * the many store writes that DON'T change the location (board sort, expanded
 * dirs, sidebar width…) without churning the history reducer.
 */
let lastSnapshot: NavSnapshot | null = null;

/** Derive the current location from the live stores. */
function currentSnapshot(): NavSnapshot {
  const projectId = useProjectsStore.getState().selectedProjectId;
  const workspace = projectId ? useWorkspaceStore.getState().byProject[projectId] : undefined;
  return {
    projectId,
    nav: workspace?.nav ?? DEFAULT_WORKSPACE_UI.nav,
    openTicketId: workspace?.openTicketId ?? DEFAULT_WORKSPACE_UI.openTicketId,
  };
}

/** Record the live location as an organic navigation, unless mid-apply. */
function recordCurrentLocation(): void {
  if (applying) return;
  const snapshot = currentSnapshot();
  if (sameSnapshot(lastSnapshot, snapshot)) return;
  lastSnapshot = snapshot;
  useWorkspaceStore.getState().recordNav(snapshot);
}

/**
 * Apply a history snapshot to the live stores, behind the `applying` guard so
 * the writes don't re-enter the recorder. A snapshot whose project no longer
 * exists (removed since it was recorded) still consumes the history step but
 * touches no workspace state, so we never mint a phantom record for it.
 */
function applySnapshot(snapshot: NavSnapshot): void {
  applying = true;
  try {
    const projects = useProjectsStore.getState();
    const { projectId } = snapshot;
    const exists = projectId !== null && projects.projects.some((p) => p.id === projectId);
    if (projectId !== null && exists) {
      if (projects.selectedProjectId !== projectId) projects.select(projectId);
      const workspace = useWorkspaceStore.getState();
      workspace.setNav(projectId, snapshot.nav);
      if (snapshot.openTicketId !== null) workspace.openTicket(projectId, snapshot.openTicketId);
      else workspace.closeTicket(projectId);
    }
  } finally {
    applying = false;
    // The live location now equals the step's snapshot — sync lastSnapshot so
    // the next unrelated store write doesn't re-record it.
    lastSnapshot = snapshot;
  }
}

/** Step back one location (chrome-bar ← / ⌘[). No-op when the stack is empty. */
export function navBack(): void {
  const snapshot = useWorkspaceStore.getState().stepNavBack();
  if (snapshot !== null) applySnapshot(snapshot);
}

/** Step forward one location (chrome-bar → / ⌘]). No-op when the stack is empty. */
export function navForward(): void {
  const snapshot = useWorkspaceStore.getState().stepNavForward();
  if (snapshot !== null) applySnapshot(snapshot);
}

/**
 * Mounted once (app shell). Seeds the initial location, records every later
 * navigation via store subscriptions, and binds the nav shortcuts:
 *   - ⌘[ / ⌘] → back / forward, suppressed inside inputs / CodeMirror (where
 *     ⌘[ means outdent).
 *   - ⌥⌘B → toggle the ticket-detail right rail. Bound in the CAPTURE phase and
 *     stops propagation so it preempts the left-sidebar ⌘B handler in
 *     ui/sidebar.tsx (a plain window listener we don't own).
 */
export function useNavHistory(): void {
  React.useEffect(() => {
    recordCurrentLocation();
    const unsubProjects = useProjectsStore.subscribe(recordCurrentLocation);
    const unsubWorkspace = useWorkspaceStore.subscribe(recordCurrentLocation);
    return () => {
      unsubProjects();
      unsubWorkspace();
    };
  }, []);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const nav = event as unknown as NavKeyEvent;
      if (isNavBackKeyEvent(nav)) {
        if (isEditingTarget(event.target)) return;
        event.preventDefault();
        navBack();
      } else if (isNavForwardKeyEvent(nav)) {
        if (isEditingTarget(event.target)) return;
        event.preventDefault();
        navForward();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  React.useEffect(() => {
    // Capture phase: run before ui/sidebar.tsx's bubble-phase ⌘B listener and
    // halt the event so ⌥⌘B never doubles as a left-sidebar toggle.
    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (!isRailToggleKeyEvent(event as unknown as NavKeyEvent)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      useUiStore.getState().toggleRailCollapsed();
    };
    window.addEventListener("keydown", onKeyDownCapture, true);
    return () => window.removeEventListener("keydown", onKeyDownCapture, true);
  }, []);
}
