/**
 * The real app window for the release film's montage shots (VC-464: split,
 * palette, rail). One `AppShell`, seeded the way the lab's `app-shell` and
 * `split-view-tab-bar` scratches seed it (seedApp/appApi), with two film-only
 * changes:
 *
 *   • Privacy. The lab fixtures live under `/Users/demo/…`; every project
 *     path, worktree path and Session cwd is re-homed under `/work/…` before
 *     any store or bridge answer sees it, so nothing under /Users can render
 *     (or sit in a title attribute the capture audit reads).
 *   • Quiet. The bridge channels the shell reaches for on the way up that the
 *     lab leaves failing (automations, browser tabs, shells) are answered with
 *     honest empties, so no "Not stubbed in the UI lab" toast lands in frame.
 *
 * The shell is laid out in a fixed box rather than the viewport: `AppShell`
 * sizes itself with `h-svh`, which in a 9:16 capture would be a 1920px-tall
 * window. The override pins the provider to its box; nothing else about the
 * layout is touched.
 */
import * as React from "react";
import {
  EMPTY_SESSION_USAGE_SUMMARY,
  PERSON_STARTED,
  type Project,
  type SessionListingRow,
  type Ticket,
} from "@volli/shared";
import type { BrowserTabState } from "../../ipc/contract";

import { AppShell } from "@renderer/components/app-shell";
import { useBoardStore } from "@renderer/stores/board";
import { useProjectsStore } from "@renderer/stores/projects";

import type { ApiOverrides } from "../../renderer/lab/fake-api";
import {
  chatSessions as labChatSessions,
  labels,
  project as labProject,
  projects as labProjects,
  sessions as labSessions,
  signals,
  tickets as labTickets,
} from "../../renderer/lab/fixtures";
import { appApi, seedApp } from "../../renderer/lab/seed";

/** Every `/Users/demo/code/…` string in a fixture, re-homed under `/work/…`. */
export function rehome<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replaceAll("/Users/demo/code/", "/work/")) as T;
}

export const project: Project = rehome(labProject);
export const projects: Project[] = rehome(labProjects);
export const tickets: Ticket[] = rehome(labTickets);
export const sessions = rehome(labSessions);
export const chatSessions = rehome(labChatSessions);

export const sessionRows: SessionListingRow[] = [
  ...sessions.map((record): SessionListingRow => ({
    kind: "terminal",
    record,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    provenance: PERSON_STARTED,
  })),
  ...chatSessions.map((record): SessionListingRow => ({
    kind: "chat",
    record,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    provenance: PERSON_STARTED,
  })),
];

const ok = <T extends object>(value: T) => Promise.resolve({ ok: true as const, ...value });

/** The app's bridge for the montage shots: the lab's, made quiet and path-safe. */
export function shellApi(
  overrides: ApiOverrides = {},
  browserTabs: BrowserTabState[] = [],
): ApiOverrides {
  const base = appApi as Record<string, Record<string, unknown>>;
  const merge = (namespace: string, extra: Record<string, unknown>) => ({
    ...base[namespace],
    ...extra,
    ...(overrides[namespace] as Record<string, unknown> | undefined),
  });
  return {
    ...appApi,
    ...overrides,
    sessions: merge("sessions", {
      list: (input?: { projectId?: string }) =>
        ok({
          sessions: sessionRows.filter(
            (row) => input?.projectId === undefined || row.record.projectId === input.projectId,
          ),
        }),
      listForTicket: (input: { ticketId: string }) =>
        ok({ sessions: sessionRows.filter((row) => row.record.ticketId === input.ticketId) }),
    }),
    tickets: merge("tickets", {
      latestSignals: () => ok({ signals }),
      statusEntries: () => ok({ entries: [] }),
    }),
    automations: merge("automations", {
      list: () => ok({ automations: [] }),
      armings: () => ok({ armings: [] }),
      enablement: () => ok({ enabledAutomationIds: [] }),
      columnOrders: () => ok({ orders: [] }),
      runsForTicket: () => ok({ runs: [] }),
      runsForProject: () => ok({ runs: [] }),
    }),
    shells: merge("shells", { list: () => ok({ shells: [] }) }),
    browser: merge("browser", {
      list: () => ok({ tabs: browserTabs }),
      show: () => ok({}),
      hide: () => ok({}),
      setBounds: () => ok({}),
      capture: () => ok({ frames: [] }),
    }),
  };
}

/** `seedApp`, then the same stores re-seeded from the path-safe fixtures. */
export function seedShell(): void {
  seedApp();
  useProjectsStore.setState({ projects, selectedProjectId: project.id });
  useBoardStore.setState({
    ticketsByProject: { [project.id]: tickets },
    labelsByProject: { [project.id]: labels },
  });
}

/**
 * `AppShell` in a fixed window-sized box, on the app's own canvas. The box is
 * the containing block for the shell's `fixed` layers (they sit inside a
 * transformed Surface), so the shell's toasts and overlays stay in the window.
 */
export function ShellWindow({
  width,
  height,
  className,
  children,
}: {
  width: number;
  height: number;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`film-shell relative overflow-hidden rounded-[14px] ${className ?? ""}`}
      style={{ width, height, background: "var(--canvas)" }}
    >
      <style>{SHELL_CSS}</style>
      <AppShell />
      {children}
    </div>
  );
}

const SHELL_CSS = `
  .film-shell [data-slot="sidebar-wrapper"] {
    height: 100% !important;
    min-height: 0 !important;
  }
  .film-shell [data-slot="sidebar-container"] {
    height: 100% !important;
  }
  .film-shell [data-sonner-toaster] { display: none !important; }
`;
