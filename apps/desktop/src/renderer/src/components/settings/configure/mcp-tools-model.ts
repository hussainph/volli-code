/**
 * What Configure → MCP Servers decides without drawing anything: how a
 * server's tools are found, grouped and selected in bulk, and what a server's
 * row says about its health. Pure, so the rules are tested as rules.
 *
 * THE SELECTION RULES, from the research behind this pane (VC-470). Every app
 * that let a person pick tools one at a time with no bulk control drew the
 * same complaint — a 40-tool GitHub server toggled by hand — and the two that
 * did it well (VS Code's tool picker, Claude's connector permissions) agree on
 * the shape:
 *
 *  1. **Select all acts on what is listed.** With a filter typed, "all" means
 *     the tools that match it, never the hidden rest: a control reading "these
 *     five" that quietly changed forty would be a lie (the same rule
 *     `DataTable`'s `bulk` slot keeps).
 *  2. **A group says which way one click goes.** Each group's checkbox is
 *     checked, clear or mixed over the tools it can change; from mixed or
 *     clear it selects them all, from checked it clears them.
 *  3. **A tool that cannot be offered is never selected** — not by a click,
 *     not by select all. Its definition failed Volli's checks, so there is
 *     nothing to offer.
 *  4. **Read-only first, when the server says which those are.** Turning on
 *     every read in one move and weighing each write is the decision a person
 *     is actually making. The labels are the server's own (`McpToolHints`), so
 *     a server that says nothing gets one plain list rather than a guess.
 */
import type { McpCatalogTool, McpServerAccess, McpServerRecord } from "@volli/shared";

import type { StatusDotState } from "@renderer/components/ui/status-dot";

/** Which tools the picker lists, beside the text filter. */
export type McpToolShow = "all" | "on" | "off";

export type McpToolGroupKey = "read-only" | "writes" | "tools" | "unavailable";

export interface McpToolGroup {
  key: McpToolGroupKey;
  /** The group's heading, or `null` for the one plain list of a server that labels nothing. */
  label: string | null;
  tools: readonly McpCatalogTool[];
}

/** Whether every tool, some, or none of the ones a control can change is selected. */
export type McpSelection = "all" | "some" | "none";

/** A tool Volli can offer to a Session: its definition passed every check. */
export function isSelectable(tool: McpCatalogTool): boolean {
  return tool.definition !== null;
}

/**
 * What a row leads with: the server's title when it gave one, with the exact
 * name beside it — the name is what an agent and the audit log say, so it is
 * never hidden behind a friendlier word.
 */
export function toolLabel(
  tool: McpCatalogTool,
  names: ReadonlySet<string> = new Set(),
): { title: string; name: string | null } {
  const title = tool.hints?.title;
  // A title that is another tool's name would put one tool's identity on
  // another's row — `delete_all` titled "list_items" — so it is not used.
  if (title === undefined || (names.has(title) && title !== tool.name)) {
    return { title: tool.name, name: null };
  }
  return { title, name: tool.name };
}

/** Case-insensitive, over the name, the title and the description. */
export function matchesToolQuery(tool: McpCatalogTool, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return [tool.name, tool.hints?.title ?? "", tool.description].some((text) =>
    text.toLowerCase().includes(needle),
  );
}

/**
 * The tools the picker lists: those matching the query and, while *On* or
 * *Off* is chosen, those that were on (or off) WHEN it was chosen. Membership
 * is frozen at that moment so a row does not vanish from under the pointer
 * the instant it is toggled. `null` lists everything that matches.
 */
export function listedTools(
  catalog: readonly McpCatalogTool[],
  query: string,
  members: ReadonlySet<string> | null,
): readonly McpCatalogTool[] {
  return catalog.filter(
    (tool) => matchesToolQuery(tool, query) && (members === null || members.has(tool.name)),
  );
}

/** The tools the picker lists for a query and a show filter, in the server's order. */
export function visibleTools(
  catalog: readonly McpCatalogTool[],
  query: string,
  show: McpToolShow,
  selected: ReadonlySet<string>,
): readonly McpCatalogTool[] {
  return catalog.filter((tool) => {
    if (!matchesToolQuery(tool, query)) return false;
    if (show === "on") return selected.has(tool.name);
    if (show === "off") return !selected.has(tool.name);
    return true;
  });
}

/**
 * The listed tools in their groups: read-only, then writes, when the server
 * marked any tool read-only; otherwise one unlabelled list. Tools that cannot
 * be offered go last, in a group of their own. Empty groups are left out.
 */
export function groupTools(tools: readonly McpCatalogTool[]): readonly McpToolGroup[] {
  const offered = tools.filter(isSelectable);
  const unavailable = tools.filter((tool) => !isSelectable(tool));
  const labelled = offered.some((tool) => tool.hints?.readOnly === true);
  const groups: McpToolGroup[] = labelled
    ? [
        {
          key: "read-only",
          label: "Read-only",
          tools: offered.filter((tool) => tool.hints?.readOnly === true),
        },
        {
          key: "writes",
          label: "Can make changes",
          tools: offered.filter((tool) => tool.hints?.readOnly !== true),
        },
      ]
    : [{ key: "tools", label: null, tools: offered }];
  groups.push({ key: "unavailable", label: "Unavailable", tools: unavailable });
  return groups.filter((group) => group.tools.length > 0);
}

/** Where a set of tools stands, counting only the ones that can be selected. */
export function selectionOf(
  tools: readonly McpCatalogTool[],
  selected: ReadonlySet<string>,
): McpSelection {
  const selectable = tools.filter(isSelectable);
  const on = selectable.filter((tool) => selected.has(tool.name)).length;
  if (on === 0) return "none";
  return on === selectable.length ? "all" : "some";
}

/**
 * One click on a group's (or the whole list's) checkbox: from checked it
 * clears those tools, otherwise it selects every one of them. Tools outside
 * `tools` keep whatever they were.
 */
export function toggleTools(
  tools: readonly McpCatalogTool[],
  selected: ReadonlySet<string>,
): Set<string> {
  const turnOn = selectionOf(tools, selected) !== "all";
  const next = new Set(selected);
  for (const tool of tools) {
    if (!isSelectable(tool)) continue;
    if (turnOn) next.add(tool.name);
    else next.delete(tool.name);
  }
  return next;
}

/** One tool's click. A tool that cannot be offered stays off. */
export function toggleTool(tool: McpCatalogTool, selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  if (next.has(tool.name)) next.delete(tool.name);
  else if (isSelectable(tool)) next.add(tool.name);
  return next;
}

/** How many tools a pending selection turns on or off, against what is saved. */
export function changedTools(saved: ReadonlySet<string>, pending: ReadonlySet<string>): number {
  let changed = 0;
  for (const name of pending) if (!saved.has(name)) changed += 1;
  for (const name of saved) if (!pending.has(name)) changed += 1;
  return changed;
}

/** The names a catalog has on. */
export function enabledToolNames(catalog: readonly McpCatalogTool[]): string[] {
  return catalog.filter((tool) => tool.enabled && isSelectable(tool)).map((tool) => tool.name);
}

/**
 * The arguments a tool takes, from its input schema: each property's name,
 * whether it is required, and its JSON type when it states a single one.
 * What a person needs to judge a tool they have never used, read off the
 * definition Volli already checked rather than any prose the server wrote.
 */
export function toolParameters(
  tool: McpCatalogTool,
): readonly { name: string; required: boolean; type: string | null }[] {
  const schema = tool.definition?.inputSchema;
  const properties = schema?.["properties"];
  if (properties === undefined || properties === null || typeof properties !== "object") {
    return [];
  }
  if (Array.isArray(properties)) return [];
  const required = new Set(
    Array.isArray(schema?.["required"])
      ? schema["required"].filter((name): name is string => typeof name === "string")
      : [],
  );
  return Object.entries(properties).map(([name, property]) => {
    const type =
      property !== null &&
      typeof property === "object" &&
      !Array.isArray(property) &&
      typeof (property as Record<string, unknown>)["type"] === "string"
        ? ((property as Record<string, unknown>)["type"] as string)
        : null;
    return { name, required: required.has(name), type };
  });
}

/** What a server row says about its health, and the one fix it offers. */
export interface McpServerHealth {
  state: StatusDotState;
  label: string;
  /** The one action that fixes this state, drawn beside the label. */
  fix: "sign-in" | "cancel-sign-in" | "credentials" | "retry" | null;
  /** What is wrong, in a sentence, when the label alone cannot say it. */
  detail: string | null;
}

/**
 * A server's health, worst first. A server that is off says only that: what
 * else is wrong with it waits until someone turns it back on.
 */
export function serverHealth(
  server: McpServerRecord,
  access: McpServerAccess | undefined,
  signingIn: boolean,
): McpServerHealth {
  if (!server.enabled) return { state: "stopped", label: "Off", fix: null, detail: null };
  if (signingIn) {
    return { state: "starting", label: "Signing in…", fix: "cancel-sign-in", detail: null };
  }
  if (access?.signIn === "needs-sign-in") {
    return { state: "waiting", label: "Needs sign-in", fix: "sign-in", detail: null };
  }
  const missing = access?.missingSecrets ?? [];
  if (missing.length > 0) {
    return {
      state: "waiting",
      label: "Missing credential",
      fix: "credentials",
      detail: `Missing ${missing.join(", ")}`,
    };
  }
  if (server.error !== null) {
    return { state: "error", label: "Refresh failed", fix: "retry", detail: server.error };
  }
  if (access?.signIn === "signed-in") {
    return { state: "ready", label: "Signed in", fix: null, detail: null };
  }
  return { state: "ready", label: "Ready", fix: null, detail: null };
}

/**
 * What identifies a connection's ENDPOINT — a remote URL, or a local command
 * and its arguments — as opposed to its name or credentials. Tools chosen on
 * one endpoint are not carried to another: the same tool name on a different
 * server is a different tool.
 */
export function endpointKey(transport: McpServerRecord["transport"]): string {
  return transport.type === "stdio"
    ? ["stdio", transport.command.trim(), ...transport.args.map((arg) => arg.trim())].join("\u0000")
    : `http\u0000${transport.url.trim()}`;
}

/**
 * Where a server lives, as one short line: a remote server's host and path,
 * or a local server's command line.
 */
export function endpointLabel(transport: McpServerRecord["transport"]): string {
  if (transport.type === "stdio") {
    return [transport.command, ...transport.args].filter((part) => part.length > 0).join(" ");
  }
  try {
    const url = new URL(transport.url);
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.host}${path}`;
  } catch {
    return transport.url;
  }
}

/** Labels a host carries that say nothing about whose server it is. */
const GENERIC_HOST_LABELS = new Set(["mcp", "www", "api", "app", "server", "localhost"]);

/**
 * A name for a server nobody has named yet: the meaningful part of a remote
 * server's host (`mcp.linear.app` → `Linear`), or a local command's package
 * (`npx -y @acme/notes-mcp` → `notes-mcp`). Offered as the Name field's
 * placeholder and used if the field is left empty; never better than what a
 * person types.
 */
export function suggestedServerName(transport: McpServerRecord["transport"]): string {
  if (transport.type === "stdio") {
    const words = [transport.command, ...transport.args]
      .map((word) => word.trim())
      .filter((word) => word.length > 0 && !word.startsWith("-"));
    const last = words.at(-1);
    if (last === undefined) return "";
    const base = last.slice(last.lastIndexOf("/") + 1);
    return base.replace(/@[^@]*$/, "") || base;
  }
  let host: string;
  try {
    host = new URL(transport.url).hostname;
  } catch {
    return "";
  }
  if (host === "localhost" || host === "[::1]" || /^127(\.\d+){3}$/.test(host)) {
    return "Local server";
  }
  // Any other address is its own best name: there is no word in it to pick.
  if (/^[\d.]+$/.test(host) || host.startsWith("[")) return host;
  const labels = host.split(".");
  const meaningful = labels
    .slice(0, labels.length > 1 ? -1 : undefined)
    .filter((label) => !GENERIC_HOST_LABELS.has(label.toLowerCase()));
  // `split` always yields at least one label, so the fallback is never empty-handed.
  const pick = meaningful.at(-1) ?? labels[0]!;
  return pick.length === 0 ? "" : pick[0]!.toUpperCase() + pick.slice(1);
}
