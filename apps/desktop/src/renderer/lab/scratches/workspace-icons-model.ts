/** Lab-only fixtures and aggregation; no production stores or read receipts. */
import { DEFAULT_CANVAS, type Appearance, type Canvas } from "@volli/shared";

import { sessionAttentionRank } from "@renderer/components/ui/session-activity-status";

export type WorkspaceSessionState =
  | "working"
  | "setup"
  | "waiting"
  | "interrupted"
  | "idle"
  | "stopped";
export interface WorkspaceSession {
  id: string;
  title: string;
  scope: string;
  state: WorkspaceSessionState;
  unread: boolean;
  /** A helper has no standalone row; its work is represented by its parent. */
  role?: "subagent";
}
export interface WorkspaceFixture {
  id: string;
  name: string;
  colorIndex: number;
  canvas: Canvas | null;
  appearance: Appearance | null;
  sessions: readonly WorkspaceSession[];
}
export type WorkspaceScenario = "mixed" | "quiet" | "busy" | "collision";
export type WorkspaceSignal = "waiting" | "interrupted" | "working" | null;

function canvas(first: string, second: string): Canvas {
  return {
    ...DEFAULT_CANVAS,
    stops: [
      { hex: first, x: 0.2, y: 0.2 },
      { hex: second, x: 0.85, y: 0.8 },
    ],
  };
}

// Authored fixture canvases, not UI palette colors. Identical initials and an
// inherited canvas deliberately make color insufficient as identity.
const WORKSPACES: readonly WorkspaceFixture[] = [
  {
    id: "volli",
    name: "Volli Code",
    colorIndex: 0,
    canvas: null,
    appearance: null,
    sessions: [
      {
        id: "v1",
        title: "Workspace icon exploration",
        scope: "VC-489",
        state: "working",
        unread: false,
      },
      { id: "v2", title: "Permission policy", scope: "VC-472", state: "waiting", unread: true },
      { id: "v3", title: "Release planning", scope: "Home", state: "idle", unread: true },
    ],
  },
  {
    id: "canopy",
    name: "Canopy",
    colorIndex: 2,
    canvas: canvas("#4f977c", "#678bbc"),
    appearance: null,
    sessions: [
      { id: "c1", title: "Index the repository", scope: "CN-18", state: "working", unread: true },
      { id: "c2", title: "Prepare the checkout", scope: "CN-19", state: "setup", unread: false },
    ],
  },
  {
    id: "paper",
    name: "Paper Trail",
    colorIndex: 1,
    canvas: canvas("#c49461", "#b37394"),
    appearance: "light",
    sessions: [
      { id: "p1", title: "Write release notes", scope: "Home", state: "idle", unread: true },
    ],
  },
  {
    id: "cinder",
    name: "Cinder",
    colorIndex: 3,
    canvas: canvas("#9773be", "#528ca8"),
    appearance: null,
    sessions: [
      { id: "d1", title: "Recover deployment", scope: "CD-7", state: "interrupted", unread: false },
      { id: "d2", title: "Choose a rollout window", scope: "Home", state: "waiting", unread: true },
    ],
  },
  { id: "archive", name: "Archive", colorIndex: 4, canvas: null, appearance: null, sessions: [] },
  {
    id: "long",
    name: "Volli Companion — a very long workspace name",
    colorIndex: 5,
    canvas: canvas("#bf785d", "#789b83"),
    appearance: null,
    sessions: [
      { id: "l1", title: "Completed migration", scope: "CP-12", state: "stopped", unread: false },
    ],
  },
];

export function workspaceFixtures(scenario: WorkspaceScenario): readonly WorkspaceFixture[] {
  return WORKSPACES.map((workspace) =>
    Object.assign({}, workspace, {
      sessions: workspace.sessions.map<WorkspaceSession>((session) => {
        if (scenario === "quiet") return { ...session, state: "idle", unread: false };
        if (scenario === "busy") return { ...session, state: "working", unread: false };
        if (scenario === "collision") return { ...session, state: "waiting", unread: true };
        return { ...session };
      }),
    }),
  );
}

export function visibleWorkspaceSessions(workspace: WorkspaceFixture): readonly WorkspaceSession[] {
  return workspace.sessions.filter((session) => session.role !== "subagent");
}

/** One state mark, with unread retained as an independent axis. No idle dots. */
export function workspaceSummary(workspace: WorkspaceFixture) {
  const sessions = visibleWorkspaceSessions(workspace);
  const recovery = sessions.filter((session) => session.state === "interrupted").length;
  const waiting = sessions.filter((session) => session.state === "waiting").length;
  const working = sessions.filter(
    (session) => session.state === "working" || session.state === "setup",
  ).length;
  const unread = sessions.filter((session) => session.unread).length;
  const candidates: Exclude<WorkspaceSignal, null>[] = [];
  if (working > 0) candidates.push("working");
  if (waiting > 0) candidates.push("waiting");
  if (recovery > 0) candidates.push("interrupted");
  const signal: WorkspaceSignal =
    candidates.toSorted((a, b) => sessionAttentionRank(a) - sessionAttentionRank(b))[0] ?? null;
  return { recovery, waiting, working, unread, signal };
}

export function workspaceSummaryLabel(workspace: WorkspaceFixture): string {
  const { recovery, waiting, working, unread } = workspaceSummary(workspace);
  const parts = [
    waiting > 0 ? `${waiting} needs input` : null,
    recovery > 0 ? `${recovery} needs recovery` : null,
    working > 0 ? `${working} active` : null,
    unread > 0 ? `${unread} unread` : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" · ") : "No activity or unread sessions";
}

/** Navigation alone never reads a conversation. Only the explicitly opened row. */
export function readWorkspaceSession(
  workspaces: readonly WorkspaceFixture[],
  workspaceId: string,
  sessionId: string,
): readonly WorkspaceFixture[] {
  return workspaces.map((workspace) =>
    workspace.id !== workspaceId
      ? workspace
      : {
          ...workspace,
          sessions: workspace.sessions.map((session) =>
            session.id === sessionId ? { ...session, unread: false } : session,
          ),
        },
  );
}
