/**
 * Micro-shot · plug in any MCP server.
 *
 * Real: Settings → Configure → MCP (`McpPane`), reading invented servers
 * through a fixture `window.api.mcp`. The pane owns its server list as state
 * loaded once on mount, so the switch is filmed deterministically: two real
 * panes are mounted from frame 0, one reading a project where Figma is off and
 * one where it is on, and the shot cuts between them at `T.on` (a seek in
 * either direction lands on the right one).
 *
 * Invented servers only: `*.example` hosts, no tokens, no local paths.
 */
import { Surface } from "@webprodigies/flute";
import type { McpCatalogTool, McpServerRecord, Project } from "@volli/shared";
import { UNKNOWN_MCP_PROVENANCE } from "@volli/shared";

import { McpPane } from "@renderer/components/settings/configure/mcp-pane";

import { ease, mix, progress } from "../kit/clock";
import {
  FrameLayer,
  Supers,
  useFilm,
  useFixtures,
  Vignette,
  type Cue,
  type Format,
} from "../kit/film";
import { project, seedShell, shellApi } from "../kit/split-shell";
import { Backdrop, useFilmTheme } from "../kit/world";

/** The settings card, in lab CSS px. The rig in scripts/film/shots/mcp.mjs mirrors it. */
export const CARD = { width: 1100, height: 700 };
/** The pane is laid out at this zoom, so server names read at phone size. */
const ZOOM = 1.45;

/** Beats (scene ms). */
const T = { on: 640, glowTo: 1100 };

const OFF: Project = { ...project, id: `${project.id}-mcp-off` };
const ON: Project = { ...project, id: `${project.id}-mcp-on` };

const NOW = Date.now();

function tools(serverId: string, names: string[], enabled = true): McpCatalogTool[] {
  return names.map((name) => ({
    name,
    description: `${name.replaceAll("_", " ")}.`,
    enabled,
    error: null,
    definition: {
      serverId,
      toolName: name,
      providerName: `mcp__${serverId}__${name}`,
      description: `${name.replaceAll("_", " ")}.`,
      inputSchema: { type: "object" },
    },
  }));
}

function server(
  id: string,
  name: string,
  transport: McpServerRecord["transport"],
  names: string[],
  enabled: boolean,
): McpServerRecord {
  return {
    id,
    name,
    enabled,
    transport,
    projectId: project.id,
    provenance: UNKNOWN_MCP_PROVENANCE,
    catalog: tools(id, names),
    stale: false,
    error: null,
    refreshedAt: NOW - 3 * 60_000,
    createdAt: NOW - 9 * 86_400_000,
    updatedAt: NOW - 3 * 60_000,
  };
}

function servers(figmaOn: boolean): McpServerRecord[] {
  return [
    server(
      "linear",
      "linear",
      { type: "streamable-http", url: "https://mcp.linear.example/mcp" },
      ["list_issues", "get_issue", "create_issue", "update_issue", "add_comment", "list_teams"],
      true,
    ),
    server(
      "sentry",
      "sentry",
      { type: "streamable-http", url: "https://mcp.sentry.example/mcp" },
      ["search_issues", "get_event", "list_releases", "resolve_issue"],
      true,
    ),
    server(
      "figma",
      "figma",
      { type: "streamable-http", url: "https://mcp.figma.example/mcp" },
      ["get_frame", "get_components", "export_node", "get_variables", "list_comments"],
      figmaOn,
    ),
    server(
      "postgres",
      "postgres",
      { type: "stdio", command: "postgres-mcp", args: ["--host", "db.atlas.example"] },
      ["query", "list_tables", "describe_table"],
      true,
    ),
  ];
}

const ok = <T,>(value: T) => Promise.resolve({ ok: true as const, ...value });

const API = shellApi({
  mcp: {
    list: (input: { projectId: string }) =>
      ok({ servers: servers(input.projectId === ON.id), operations: [] }),
    test: () => Promise.resolve({ ok: false, error: "Not part of this fixture." }),
    save: () => Promise.resolve({ ok: false, error: "Not part of this fixture." }),
    refresh: () => Promise.resolve({ ok: false, error: "Not part of this fixture." }),
    setEnabled: () => Promise.resolve({ ok: false, error: "Not part of this fixture." }),
    setTools: () => Promise.resolve({ ok: false, error: "Not part of this fixture." }),
    remove: () => Promise.resolve({ ok: false, error: "Not part of this fixture." }),
  },
});

/** One real pane, shown or held invisible in place (both stay mounted). */
function Pane({ of, shown }: { of: Project; shown: boolean }) {
  return (
    <div
      className="absolute inset-0 px-8 pt-7"
      style={{ visibility: shown ? "visible" : "hidden", zoom: ZOOM }}
    >
      <McpPane project={of} />
    </div>
  );
}

/** The settings card: Configure → MCP heading over the real pane. */
function Card({ t }: { t: number }) {
  const on = t >= T.on;
  const glow = progress(t, T.on - 40, T.glowTo, ease.outCubic);
  return (
    <div
      className="relative overflow-hidden rounded-container border bg-background text-foreground shadow-overlay"
      style={{
        // Explicit: the Surface's content wrapper has no height of its own.
        width: CARD.width,
        height: CARD.height,
        boxShadow:
          glow > 0 && glow < 1
            ? `0 0 0 ${mix(1, 3, 1 - glow)}px color-mix(in oklab, var(--ring) ${Math.round(
                70 * (1 - glow),
              )}%, transparent), 0 40px 120px rgb(0 0 0 / 0.45)`
            : "0 40px 120px rgb(0 0 0 / 0.45)",
      }}
    >
      <div
        className="flex h-14 items-center gap-2 border-b border-border/60 px-8 text-ui text-muted-foreground"
        style={{ zoom: ZOOM }}
      >
        <span>Settings</span>
        <span>/</span>
        <span>Configure</span>
        <span>/</span>
        <span className="font-medium text-foreground">MCP</span>
      </div>
      <div className="absolute inset-x-0 bottom-0" style={{ top: 56 * ZOOM }}>
        <Pane of={OFF} shown={!on} />
        <Pane of={ON} shown={on} />
      </div>
    </div>
  );
}

const CUE: Cue = {
  at: 100,
  until: 1300,
  lines: ["Plug in", "any MCP server."],
  weights: [320, 800],
};

const CUES: Record<Format, Cue[]> = {
  landscape: [{ ...CUE, place: "lower" }],
  portrait: [{ ...CUE, place: "upper" }],
};

export function McpShot({ format }: { format: Format }) {
  const t = useFilm();
  useFilmTheme("cobalt");
  useFixtures({ api: API, seed: seedShell });

  return (
    <>
      <Surface
        id="card"
        style={{
          position: "absolute",
          left: `calc(50% - ${CARD.width / 2}px)`,
          top: `calc(50% - ${CARD.height / 2}px)`,
          width: CARD.width,
          height: CARD.height,
        }}
        content={<Card t={t} />}
      />
      <Backdrop t={t} theme="cobalt" focus={format === "landscape" ? [0.5, 0.75] : [0.5, 0.25]} />
      <FrameLayer format={format}>
        <Vignette strength={0.4} />
        <Supers cues={CUES[format]} t={t} format={format} />
      </FrameLayer>
    </>
  );
}
