/**
 * The fleet: the release film's "dozens of agents" fixture (hook, sessions).
 *
 * Forty-odd invented chat Sessions over the lab's Voltaic / Atlas / Harbor
 * projects, most of them live — working (the travelling ring) or waiting on a
 * person (the ring standing still) — seeded through the same stores and bridge
 * answer the real sidebar reads (`useProjectSessionsStore`, `sessions.list`,
 * `useChatSessionsStore`), the way the lab's `sidebar-performance` scratch
 * seeds them. Every row is project-scoped (no ticket), so nothing here names a
 * ticket, and every path goes through `rehome`.
 */
import * as React from "react";
import {
  EMPTY_SESSION_USAGE_SUMMARY,
  PERSON_STARTED,
  type ChatSessionRecord,
  type SessionListingRow,
} from "@volli/shared";
import { seedSlice } from "@volli/session-presentation";

import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";

import type { ApiOverrides } from "../../renderer/lab/fake-api";
import { NOW } from "../../renderer/lab/fixtures";
import { projects, rehome, seedShell, shellApi, sessionRows } from "./split-shell";

const MINUTE = 60_000;

type State = "working" | "waiting" | "recent" | "done";

/** [title, state] per Session in the selected project (Voltaic), top to bottom-ish. */
const VOLTAIC: readonly (readonly [string, State])[] = [
  ["Fix flaky checkout test", "waiting"],
  ["Migrate auth to passkeys", "working"],
  ["Draft release notes", "working"],
  ["Profile slow search query", "working"],
  ["Add retry to webhook sender", "waiting"],
  ["Split the billing service", "working"],
  ["Cache avatar thumbnails", "working"],
  ["Port settings page to forms v2", "working"],
  ["Trace memory leak in worker pool", "waiting"],
  ["Dark mode for the editor", "working"],
  ["Rate-limit the public API", "working"],
  ["Dedupe analytics events", "working"],
  ["Write e2e for onboarding", "working"],
  ["Upgrade to Postgres 17", "waiting"],
  ["Stream CSV exports", "working"],
  ["Fix timezone bug in reports", "working"],
  ["Lazy-load the dashboard charts", "working"],
  ["Refactor the pricing table", "working"],
  ["Add SSO for workspaces", "working"],
  ["Shrink the bundle below 200 kB", "working"],
  ["Audit error boundaries", "waiting"],
  ["Index the orders table", "working"],
  ["Localize checkout into German", "working"],
  ["Batch push notifications", "working"],
  ["Fix scroll jank on mobile", "working"],
  ["Rewrite the image uploader", "working"],
  ["Tighten CSP headers", "recent"],
  ["Paginate the audit log", "recent"],
  ["Review the queue backpressure", "recent"],
  ["Clean up feature flags", "recent"],
  ["Add keyboard shortcuts to search", "done"],
  ["Explain the cache invalidation", "done"],
  ["Bump React to 19", "done"],
  ["Sketch the usage dashboard", "done"],
  ["Fix broken links in docs", "done"],
  ["Rename the sync job", "done"],
  ["Triage the crash reports", "done"],
  ["Speed up CI caching", "done"],
];

const ATLAS: readonly (readonly [string, State])[] = [
  ["Map tiles render twice", "working"],
  ["Offline mode for field app", "working"],
  ["Geocode import in batches", "waiting"],
  ["Tune the route solver", "working"],
  ["Migrate storage to S3", "done"],
];

const HARBOR: readonly (readonly [string, State])[] = [
  ["Container health checks", "working"],
  ["Rotate deploy keys", "waiting"],
  ["Canary rollout script", "working"],
];

function fleetRecord(
  projectId: string,
  prefix: string,
  index: number,
  [title, state]: readonly [string, State],
): ChatSessionRecord {
  const live = state === "working" || state === "waiting";
  const lastActivityAt =
    state === "done"
      ? NOW - (50 + index * 7) * MINUTE
      : state === "recent"
        ? NOW - (4 + index) * MINUTE
        : NOW - (index + 1) * 4_000;
  return {
    sessionId: `fleet-${prefix}-${index + 1}`,
    projectId,
    ticketId: null,
    title,
    createdAt: lastActivityAt - 40 * MINUTE,
    adapterId: "claude-code",
    live,
    activity: state === "working" ? "working" : state === "waiting" ? "waiting" : "idle",
    waitingOn: state === "waiting" ? (index % 2 === 0 ? "question" : "permission") : null,
    outcome: null,
    bornTicketless: true,
    role: "project",
    parentSessionId: null,
    model: { providerId: "anthropic", modelId: "sonnet-4.5", reasoningLevel: "medium" },
    lastActivityAt,
  };
}

const byName = (name: string) => projects.find((p) => p.name === name)?.id ?? projects[0]!.id;

export const fleetChats: ChatSessionRecord[] = rehome([
  ...VOLTAIC.map((row, i) => fleetRecord(byName("Voltaic"), "v", i, row)),
  ...ATLAS.map((row, i) => fleetRecord(byName("Atlas"), "a", i, row)),
  ...HARBOR.map((row, i) => fleetRecord(byName("Harbor"), "h", i, row)),
]);

/** The fleet plus the shell's own terminal rows (so the shell's other surfaces stay whole). */
export const fleetRows: SessionListingRow[] = [
  ...sessionRows.filter((row) => row.kind === "terminal"),
  ...fleetChats.map((record): SessionListingRow => ({
    kind: "chat",
    record,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    provenance: PERSON_STARTED,
  })),
];

const ok = <T extends object>(value: T) => Promise.resolve({ ok: true as const, ...value });

/** `shellApi`, answering `sessions.list` with the fleet. */
export function fleetApi(overrides: ApiOverrides = {}): ApiOverrides {
  return shellApi({
    ...overrides,
    sessions: {
      list: (input?: { projectId?: string }) =>
        ok({
          sessions: fleetRows.filter(
            (row) => input?.projectId === undefined || row.record.projectId === input.projectId,
          ),
        }),
      ...(overrides.sessions as Record<string, unknown> | undefined),
    },
  });
}

/** `seedShell`, then the sidebar's stores filled with the fleet. */
export function seedFleet(): void {
  seedShell();
  const byProject: Record<
    string,
    { terminal: never[]; chat: ChatSessionRecord[]; provenance: {} }
  > = {};
  for (const chat of fleetChats) {
    const entry = (byProject[chat.projectId] ??= { terminal: [], chat: [], provenance: {} });
    entry.chat.push(chat);
  }
  useProjectSessionsStore.setState({
    byProject,
    listingState: Object.fromEntries(Object.keys(byProject).map((id) => [id, "loaded" as const])),
  });
  const live = fleetChats.filter((chat) => chat.live);
  useChatSessionsStore.setState({
    sessions: Object.fromEntries(
      live.map((chat) => [
        chat.sessionId,
        seedSlice(chat.activity === "working" ? "working" : "ready"),
      ]),
    ),
  });
}

/**
 * Drives the sidebar's scrollport from scene time: `offset(t)` in CSS px
 * (clamped to the list's overflow). Render inside `ShellWindow` as a child.
 */
export function SidebarScroll({ top }: { top: number }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  React.useLayoutEffect(() => {
    const shell = ref.current?.closest(".film-shell");
    const sidebar = shell?.querySelector('[data-sidebar-presentation="expanded"]');
    if (!sidebar) return;
    for (const el of Array.from(sidebar.querySelectorAll<HTMLElement>("*"))) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 4) {
        el.scrollTop = Math.min(top, el.scrollHeight - el.clientHeight);
        return;
      }
    }
  });
  return <span ref={ref} hidden />;
}
