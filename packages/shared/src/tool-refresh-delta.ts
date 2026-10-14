import { CAPABILITY_TOOL_IDS, type SessionToolId } from "./authority";
import { parseCodeModeSurface, type CodeModeSurface, type ToolRoute } from "./code-mode";
import { isMcpToolId, type McpToolDefinition } from "./mcp";
import type { SessionInput } from "./session-ledger";

type Surface = Extract<SessionInput, { kind: "tool-surface" }>;

/** Only additions and versioned declaration flips, never retained MCP schemas. */
export interface SessionToolRefreshDelta {
  mcpTools?: readonly McpToolDefinition[];
  routes?: Readonly<Record<string, ToolRoute>>;
  /** The declaration on first acquisition; routes travel separately. */
  codeMode?: Omit<CodeModeSurface, "routes">;
  descriptionVersion?: 2;
  askUserQuestions?: true;
  refreshDescriptions?: true;
}

/** Callers must prove the desired surface additive before deriving its delta. */
export function createToolRefreshDelta(current: Surface, next: Surface): SessionToolRefreshDelta {
  const added = new Set(next.tools.filter((tool) => !current.tools.includes(tool)));
  const mcpTools = (next.mcpTools ?? []).filter((tool) => added.has(tool.providerName));
  const routes = Object.fromEntries(
    Object.entries(next.codeMode?.routes ?? {}).filter(
      ([tool]) => current.codeMode === undefined || added.has(tool as SessionToolId),
    ),
  );
  const { routes: _routes, ...codeMode } = next.codeMode ?? {};
  return {
    ...(mcpTools.length === 0 ? {} : { mcpTools }),
    ...(Object.keys(routes).length === 0 ? {} : { routes }),
    ...(current.codeMode === undefined && next.codeMode !== undefined
      ? { codeMode: codeMode as Omit<CodeModeSurface, "routes"> }
      : {}),
    ...(current.codeMode !== undefined &&
    next.codeMode?.descriptionVersion === 2 &&
    current.codeMode.descriptionVersion !== 2
      ? { descriptionVersion: 2 as const }
      : {}),
    ...(current.askUserQuestions !== true && next.askUserQuestions === true
      ? { askUserQuestions: true as const }
      : {}),
    ...(current.refreshDescriptions !== true && next.refreshDescriptions === true
      ? { refreshDescriptions: true as const }
      : {}),
  };
}

function fail(): never {
  throw new Error("Malformed tool refresh delta");
}

/** Fold in canonical capability order, then retained/added verbs, then MCP.
 * Unknown future names remain in the state: the host chooses the last bindable
 * epoch, rather than silently rebinding a smaller surface on downgrade.
 */
export function applyToolRefreshDelta(
  current: Surface,
  refresh: { added: readonly string[]; delta: SessionToolRefreshDelta },
): Surface {
  const { added, delta } = refresh;
  if (
    new Set(added).size !== added.length ||
    added.some((tool) => current.tools.includes(tool as SessionToolId))
  )
    fail();
  const names = [...current.tools, ...added];
  const capabilities: readonly string[] = CAPABILITY_TOOL_IDS;
  const tools = [
    ...CAPABILITY_TOOL_IDS.filter((tool) => names.includes(tool)),
    ...names.filter((tool) => !capabilities.includes(tool) && !isMcpToolId(tool)),
    ...names.filter(isMcpToolId),
  ] as SessionToolId[];
  const definitions = delta.mcpTools ?? [];
  if (
    JSON.stringify(added.filter(isMcpToolId)) !==
    JSON.stringify(definitions.map((tool) => tool.providerName))
  )
    fail();
  if (
    delta.askUserQuestions !== undefined &&
    (delta.askUserQuestions !== true ||
      current.askUserQuestions === true ||
      !added.includes("ask_user"))
  )
    fail();
  if (
    delta.refreshDescriptions !== undefined &&
    (delta.refreshDescriptions !== true || current.refreshDescriptions === true)
  )
    fail();
  if (
    delta.descriptionVersion !== undefined &&
    (delta.descriptionVersion !== 2 ||
      current.codeMode === undefined ||
      current.codeMode.descriptionVersion === 2)
  )
    fail();
  if (
    delta.codeMode !== undefined &&
    (current.codeMode !== undefined ||
      !added.includes("codemode") ||
      Object.hasOwn(delta.codeMode, "routes"))
  )
    fail();
  const declaration = current.codeMode ?? delta.codeMode;
  if (declaration === undefined && (tools.includes("codemode") || delta.routes !== undefined))
    fail();
  const newRoutes = delta.routes ?? {};
  if (
    Object.keys(newRoutes).some(
      (tool) => tool === "codemode" || (current.codeMode !== undefined && !added.includes(tool)),
    )
  )
    fail();
  const codeMode =
    declaration === undefined
      ? undefined
      : parseCodeModeSurface(
          {
            ...declaration,
            ...(delta.descriptionVersion === undefined
              ? {}
              : { descriptionVersion: delta.descriptionVersion }),
            routes: { ...current.codeMode?.routes, ...newRoutes },
          },
          tools,
          "tool refresh codeMode",
        );
  const mcpTools = [...(current.mcpTools ?? []), ...definitions];
  return {
    ...current,
    tools,
    ...(mcpTools.length === 0 && current.mcpTools === undefined ? {} : { mcpTools }),
    ...(codeMode === undefined ? {} : { codeMode }),
    ...(delta.askUserQuestions === undefined ? {} : { askUserQuestions: true as const }),
    ...(delta.refreshDescriptions === undefined ? {} : { refreshDescriptions: true as const }),
  };
}
