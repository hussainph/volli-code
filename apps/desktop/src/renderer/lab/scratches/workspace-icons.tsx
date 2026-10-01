/**
 * VC-489 — prototype only. The rail is an index of workspaces, not an inbox:
 * identity stays on the tile; selection lives outside it; unseen conversation
 * gets the upper corner; the most actionable Session state gets the lower one.
 *
 * Two materials share those semantics so changing a drawing never changes what
 * a dot means. The canvas preview resolves the DESTINATION's canvas/appearance,
 * while both notification marks retain the CURRENT window's status tokens.
 * Never scope a StatusDot under a workspace thumbnail's custom theme.
 *
 * Input > recovery > activity follows the existing Session attention rank.
 * All counts survive on hover and in the accessible name. No aggregate read,
 * no reordering on activity, no production data writes, and no idle green dots.
 */
import * as React from "react";
import { ArchiveIcon } from "@phosphor-icons/react/dist/csr/Archive";
import { CodeIcon } from "@phosphor-icons/react/dist/csr/Code";
import { FlameIcon } from "@phosphor-icons/react/dist/csr/Flame";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { ScrollIcon } from "@phosphor-icons/react/dist/csr/Scroll";
import { TreeIcon } from "@phosphor-icons/react/dist/csr/Tree";
import { canvasBackground, canvasInk, monogram, projectColor } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import { StatusDot } from "@renderer/components/ui/status-dot";
import { sessionAttentionRank } from "@renderer/components/ui/session-activity-status";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/utils";
import { useThemeStore } from "@renderer/stores/theme";
import { resolveActiveTheme } from "@renderer/theme/apply";

import {
  readWorkspaceSession,
  visibleWorkspaceSessions,
  workspaceFixtures,
  workspaceSummary,
  workspaceSummaryLabel,
  type WorkspaceFixture,
  type WorkspaceScenario,
} from "./workspace-icons-model";

export const title = "Workspace icons · identity & attention";
export const note = "Canvas tile / quiet stamp — independent unread and state marks (VC-489)";

type Material = "canvas" | "stamp";
type Identity = "initials" | "glyph";
const GLYPHS = {
  volli: CodeIcon,
  canopy: TreeIcon,
  paper: ScrollIcon,
  cinder: FlameIcon,
  archive: ArchiveIcon,
  long: GitBranchIcon,
};
const SCENARIOS: Record<WorkspaceScenario, string> = {
  mixed: "Mixed",
  quiet: "Quiet",
  busy: "All working",
  collision: "Input + unread",
};
const STATE_LABEL = {
  working: "Working",
  setup: "Setup",
  waiting: "Needs input",
  interrupted: "Needs recovery",
  idle: "Idle",
  stopped: "Stopped",
};

function useThumbnail(workspace: WorkspaceFixture): React.CSSProperties {
  // Primitive/reference selectors remain stable under Zustand v5. Inherited
  // thumbnails follow the lab's live canvas editor, not a mount-time sample.
  const canvas = useThemeStore((state) => state.preview ?? state.globalCanvas);
  const appearance = useThemeStore((state) => state.previewAppearance ?? state.globalAppearance);
  const systemPrefersDark = useThemeStore((state) => state.systemPrefersDark);
  return React.useMemo(() => {
    const theme = resolveActiveTheme(
      canvas,
      appearance,
      {
        canvas: workspace.canvas,
        appearance: workspace.appearance,
        terminalThemeName: null,
      },
      systemPrefersDark,
    );
    return {
      "--workspace-canvas": canvasBackground(theme.canvas.value, theme.resolved),
      "--workspace-ink": canvasInk(theme.canvas.value, theme.resolved).ink,
    } as React.CSSProperties;
  }, [canvas, appearance, systemPrefersDark, workspace.canvas, workspace.appearance]);
}

function WorkspaceTile({
  workspace,
  material,
  identity,
  selected,
  index,
  onSelect,
}: {
  workspace: WorkspaceFixture;
  material: Material;
  identity: Identity;
  selected: boolean;
  index: number;
  onSelect(): void;
}) {
  const thumbnail = useThumbnail(workspace);
  const { signal, unread } = workspaceSummary(workspace);
  const Glyph = GLYPHS[workspace.id as keyof typeof GLYPHS] ?? CodeIcon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A 44px hit target contains the existing 36px drawing. The 6/8px
            markers occupy opposite corners without covering its identity. */}
        <button
          type="button"
          data-workspace={workspace.id}
          aria-current={selected ? "page" : undefined}
          aria-label={`${workspace.name} · ${workspaceSummaryLabel(workspace)}`}
          onClick={onSelect}
          className="group relative flex size-11 shrink-0 items-center justify-center rounded-control outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
        >
          {selected && (
            <span aria-hidden className="absolute -left-1 h-4 w-0.5 rounded-full bg-foreground" />
          )}
          <span
            aria-hidden
            style={thumbnail}
            data-material={material}
            className={cn(
              "relative flex size-9 items-center justify-center overflow-hidden rounded-control border text-sm font-semibold",
              material === "canvas"
                ? "border-foreground/30 [background:var(--workspace-canvas)] [color:var(--workspace-ink)]"
                : "border-border bg-card text-foreground group-hover:bg-accent",
            )}
          >
            {material === "stamp" && (
              <span className="absolute inset-x-0 bottom-0 h-1 [background:var(--workspace-canvas)]" />
            )}
            {identity === "initials" ? monogram(workspace.name) : <Glyph className="size-5" />}
          </span>
          {unread > 0 && (
            <span
              aria-hidden
              data-workspace-unread
              className="pointer-events-none absolute top-0.5 right-0.5 size-1.5 rounded-full bg-info ring-2 ring-rail"
            />
          )}
          {signal !== null && (
            <span
              className="pointer-events-none absolute right-0 bottom-0 flex size-4 items-center justify-center rounded-full bg-rail"
              data-workspace-signal={signal}
            >
              <StatusDot state={signal} size="md" />
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-72">
        <div className="flex items-center justify-between gap-2 font-medium">
          <span>{workspace.name}</span>
          <kbd className="shrink-0 text-label">⌘{index + 1}</kbd>
        </div>
        <div className="text-ui">{workspaceSummaryLabel(workspace)}</div>
        <div className="text-label">
          {workspace.canvas === null ? "Inherited canvas" : "Workspace canvas"} ·{" "}
          {workspace.appearance ?? "Inherited appearance"}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function Comparison({
  material,
  identity,
  workspaces,
  selectedId,
  openedSessionId,
  onSelect,
  onOpen,
}: {
  material: Material;
  identity: Identity;
  workspaces: readonly WorkspaceFixture[];
  selectedId: string;
  openedSessionId: string | null;
  onSelect(id: string): void;
  onOpen(workspaceId: string, sessionId: string): void;
}) {
  const selected = workspaces.find((workspace) => workspace.id === selectedId) ?? workspaces[0]!;
  const sessions = visibleWorkspaceSessions(selected).toSorted(
    (a, b) => sessionAttentionRank(a.state) - sessionAttentionRank(b.state),
  );
  const opened = sessions.find((session) => session.id === openedSessionId);
  return (
    <section className="flex min-w-0 flex-1 basis-80 flex-col gap-2">
      <h2 className="text-ui font-medium">
        {material === "canvas" ? "01 · Canvas tile" : "02 · Quiet stamp"}
      </h2>
      <div className="flex min-h-96 overflow-hidden rounded-xl border border-border bg-rail">
        <nav
          aria-label={`${material} workspaces`}
          className="flex w-14 shrink-0 flex-col items-center gap-2 py-4"
        >
          {workspaces.map((workspace, index) => (
            <WorkspaceTile
              key={workspace.id}
              workspace={workspace}
              material={material}
              identity={identity}
              selected={workspace.id === selected.id}
              index={index}
              onSelect={() => onSelect(workspace.id)}
            />
          ))}
          <span
            aria-hidden
            className="flex size-11 items-center justify-center text-muted-foreground"
          >
            <PlusIcon className="size-4" />
          </span>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-4 border-l border-border bg-sidebar p-4">
          <header className="flex min-w-0 flex-col gap-1">
            <h3 className="truncate text-heading" title={selected.name}>
              {selected.name}
            </h3>
            <span className="text-ui text-muted-foreground">{workspaceSummaryLabel(selected)}</span>
          </header>
          <div className="flex flex-col gap-1">
            <h4 className="text-label uppercase text-muted-foreground">Sessions</h4>
            {sessions.length === 0 && (
              <span className="py-4 text-ui text-muted-foreground">No sessions</span>
            )}
            {sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                data-session={session.id}
                aria-label={`Open ${session.title}${session.unread ? " · unread" : ""}`}
                onClick={() => onOpen(selected.id, session.id)}
                className={cn(
                  "flex min-w-0 flex-col gap-1 rounded-lg p-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/45",
                  opened?.id === session.id && "bg-accent",
                )}
              >
                <span className="flex items-center gap-2 text-ui">
                  <span className="min-w-0 flex-1 truncate">{session.title}</span>
                  {session.unread && (
                    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info" />
                  )}
                </span>
                <span className="flex items-center gap-2 text-label text-muted-foreground">
                  <StatusDot state={session.state} />
                  <span>{STATE_LABEL[session.state]}</span>
                  <span>· {session.scope}</span>
                </span>
              </button>
            ))}
          </div>
          {opened && (
            <div
              className="flex flex-col gap-2 rounded-lg border border-border bg-background p-4"
              role="status"
            >
              <span className="text-label uppercase text-muted-foreground">
                Conversation opened
              </span>
              <span className="text-ui">{opened.title}</span>
              <span className="text-ui text-muted-foreground">{STATE_LABEL[opened.state]}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export default function WorkspaceIconsScratch() {
  const [scenario, setScenario] = React.useState<WorkspaceScenario>("mixed");
  const [identity, setIdentity] = React.useState<Identity>("initials");
  const [workspaces, setWorkspaces] = React.useState(() => workspaceFixtures("mixed"));
  const [selectedId, setSelectedId] = React.useState("volli");
  const [openedSessionId, setOpenedSessionId] = React.useState<string | null>(null);

  function reset(next: WorkspaceScenario) {
    setScenario(next);
    setWorkspaces(workspaceFixtures(next));
    setOpenedSessionId(null);
  }
  function onSelect(id: string) {
    setSelectedId(id);
    setOpenedSessionId(null);
  }
  function onOpen(workspaceId: string, sessionId: string) {
    setOpenedSessionId(sessionId);
    setWorkspaces((current) => readWorkspaceSession(current, workspaceId, sessionId));
  }

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-ui">
            Scenario
            <select
              aria-label="Scenario"
              value={scenario}
              onChange={(event) => reset(event.target.value as WorkspaceScenario)}
              className="h-7 rounded-full border border-border bg-card px-2"
            >
              {Object.entries(SCENARIOS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-ui">
            Identity
            <select
              aria-label="Identity"
              value={identity}
              onChange={(event) => setIdentity(event.target.value as Identity)}
              className="h-7 rounded-full border border-border bg-card px-2"
            >
              <option value="initials">Initials</option>
              <option value="glyph">Glyph study</option>
            </select>
          </label>
          <Button variant="outline" size="sm" onClick={() => reset(scenario)}>
            Reset receipts
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-ui text-muted-foreground">
          <span className="flex items-center gap-2">
            <span aria-hidden className="size-1.5 rounded-full bg-info" />
            Unread · upper corner
          </span>
          <span className="flex items-center gap-2">
            <StatusDot state="working" size="md" />
            Active
          </span>
          <span className="flex items-center gap-2">
            <StatusDot state="waiting" size="md" />
            Needs input
          </span>
          <span className="flex items-center gap-2">
            <StatusDot state="interrupted" size="md" />
            Needs recovery
          </span>
        </div>
        <div className="flex flex-wrap gap-6">
          {(["canvas", "stamp"] as const).map((material) => (
            <Comparison
              key={material}
              material={material}
              identity={identity}
              workspaces={workspaces}
              selectedId={selectedId}
              openedSessionId={openedSessionId}
              onSelect={onSelect}
              onOpen={onOpen}
            />
          ))}
        </div>
        <section className="flex flex-col gap-2">
          <h2 className="text-label uppercase text-muted-foreground">
            Today · fixed palette, selection ring, no session signals
          </h2>
          <div
            aria-label="Current tile reference"
            className="flex flex-wrap items-center gap-4 rounded-xl bg-rail p-4"
          >
            {workspaces.map((workspace) => (
              <span
                key={workspace.id}
                aria-label={workspace.name}
                style={{ backgroundColor: projectColor(workspace.colorIndex) }}
                className={cn(
                  "flex size-9 items-center justify-center rounded-control text-sm font-semibold text-white",
                  selectedId === workspace.id &&
                    "ring-2 ring-foreground/90 ring-offset-[3px] ring-offset-transparent",
                )}
              >
                {monogram(workspace.name)}
              </span>
            ))}
          </div>
        </section>
        <div className="flex max-w-content flex-col gap-2 text-ui text-muted-foreground">
          <p>
            Workspace selection keeps unread. Open a Session to read only that conversation. Input
            and recovery stay lit until addressed.
          </p>
          <p>
            Canvas comes from the destination; dots come from this window. Paper Trail is pinned
            light. Archive inherits the lab theme. Matching initials test identity without color.
          </p>
          <p>
            Input → recovery → active, following the Session roster. Hover retains every count.
            Glyphs are fixture-only; nothing here changes workspace settings or real receipts.
          </p>
        </div>
      </div>
    </TooltipProvider>
  );
}
