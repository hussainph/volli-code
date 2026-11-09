/**
 * Micro-shot · plug in any MCP server.
 *
 * Real: the separate Settings window's `SettingsPage` → MCP Servers.
 * Simulated wiring: `window.api.mcp` answers invented servers, and scene time
 * presses the real Figma switch in either seek direction. Local mode's MCP
 * inventory is global, not a Configure pane inside the workspace.
 *
 * Invented servers only: `*.example` hosts, no tokens, no local paths.
 */
import * as React from "react";
import { Surface } from "@webprodigies/flute";
import type { McpCatalogTool, McpServerRecord } from "@volli/shared";
import { mcpProviderToolName, UNKNOWN_MCP_PROVENANCE } from "@volli/shared";

import { SettingsPage } from "@renderer/components/pages/settings-page";

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
export const CARD = { width: 1320, height: 820 };
/** The pane is laid out at this zoom, so server names read at phone size. */
const ZOOM = 1.3;

/** Beats (scene ms). */
const T = { on: 640 };

const NOW = Date.parse("2026-03-01T12:00:00Z");

function tools(serverId: string, names: string[], enabled = true): McpCatalogTool[] {
  return names.map((name) => ({
    name,
    description: `${name.replaceAll("_", " ")}.`,
    enabled,
    error: null,
    definition: {
      serverId,
      toolName: name,
      providerName: mcpProviderToolName(serverId, serverId, name),
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
    projectId: "",
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
    list: () => ok({ servers: servers(false), operations: [] }),
    test: () => Promise.resolve({ ok: false, error: "Not part of this fixture." }),
    save: () => Promise.resolve({ ok: false, error: "Not part of this fixture." }),
    refresh: () => Promise.resolve({ ok: false, error: "Not part of this fixture." }),
    setEnabled: (input: { serverId: string; enabled: boolean }) =>
      ok({
        server: {
          ...servers(input.enabled).find((entry) => entry.id === input.serverId)!,
          enabled: input.enabled,
        },
      }),
    setTools: () => Promise.resolve({ ok: false, error: "Not part of this fixture." }),
    remove: () => Promise.resolve({ ok: false, error: "Not part of this fixture." }),
  },
});

/**
 * The separate Settings window's real rail, scope picker and MCP page. Scene
 * time presses the actual switch (including when seeking backwards); only
 * the bridge is simulated. No invented Configure breadcrumb or table chrome.
 */
function Card({ t }: { t: number }) {
  const root = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const sync = () => {
      const control = element.querySelector<HTMLButtonElement>(
        '[role="switch"][aria-label="figma enabled"]',
      );
      if (
        control &&
        !control.disabled &&
        (control.getAttribute("aria-checked") === "true") !== t >= T.on
      ) {
        control.click();
      }
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-checked", "disabled"],
    });
    return () => observer.disconnect();
  }, [t]);
  return (
    <div
      ref={root}
      className="settings-window flex overflow-hidden rounded-container text-foreground shadow-overlay"
      style={{ width: CARD.width / ZOOM, height: CARD.height / ZOOM, zoom: ZOOM }}
    >
      <SettingsPage initialCategoryKey="mcp" initialProjectId={project.id} />
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
