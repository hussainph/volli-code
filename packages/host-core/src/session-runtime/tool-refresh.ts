/** Effective surfaces are additive facts; the birth input remains N−1-readable. */
import {
  CODING_TOOL_IDS,
  NON_CODING_TOOL_IDS,
  isCodeCallableRoute,
  isDeclaredRoute,
  isVerbToolKey,
  isSessionToolId,
  routeOf,
  applyToolRefreshDelta,
  type RuntimeToolRefreshAnnouncement,
  REFRESH_DESCRIPTION_TOOL_IDS,
  type CodeModeSurface,
  type SessionEvent,
  type SessionInput,
  type SessionToolId,
} from "@volli/shared";

type Surface = Extract<SessionInput, { kind: "tool-surface" }>;
type Trigger = "cold-turn" | "warm-turn" | "compaction" | "model-switch" | "code-mode";

/** Keep folding unknown future additions, but bind only the last compatible epoch. */
export function foldToolRefreshes(events: readonly SessionEvent[]): {
  effective: Surface | null;
  declared: Surface | null;
  future: boolean;
  announcements: readonly RuntimeToolRefreshAnnouncement[];
} {
  let folded: Surface | null = null;
  let effective: Surface | null = null;
  let declared: Surface | null = null;
  const announcements: RuntimeToolRefreshAnnouncement[] = [];
  for (const event of events) {
    const payload = event.payload;
    if (payload.kind === "session.input.recorded" && payload.input.kind === "tool-surface") {
      folded ??= payload.input;
      effective ??= payload.input;
      declared ??= payload.input;
    } else if (payload.kind === "session.tools.refreshed" && folded !== null) {
      folded = applyToolRefreshDelta(folded, payload);
      if (!folded.tools.every(isSessionToolId)) continue;
      effective = folded;
      if (["cold-turn", "compaction", "model-switch"].includes(payload.trigger)) declared = folded;
      if (["warm-turn", "code-mode"].includes(payload.trigger) && payload.added.length > 0) {
        const counts = new Map<string, number>();
        for (const tool of payload.added) {
          const definition = folded.mcpTools?.find((candidate) => candidate.providerName === tool);
          const name = definition === undefined ? "volli" : `mcp:${definition.serverId}`;
          counts.set(name, (counts.get(name) ?? 0) + 1);
        }
        announcements.push({
          id: event.id,
          namespaces: [...counts].map(([name, count]) => ({ name, count })),
        });
      }
    }
  }
  return {
    effective,
    declared,
    future: folded !== null && !folded.tools.every(isSessionToolId),
    announcements,
  };
}

/** Birth is immutable; executable additions and paid declarations are distinct folds. */
export function effectiveToolSurface(events: readonly SessionEvent[]): Surface | null {
  return foldToolRefreshes(events).effective;
}

export function declarationToolSurface(events: readonly SessionEvent[]): Surface | null {
  return foldToolRefreshes(events).declared;
}

/** Existing schemas and routes are retained; only the explicit image capability is widened.
 * The engine guard independently proves this policy at the durable write door;
 * tool-refresh.test.ts pins their agreement for every trigger and retained MCP copy.
 */
export function additiveToolRefresh(
  current: Surface,
  candidate: Surface,
  trigger: Trigger,
  declared: Surface = current,
): {
  surface: Surface;
  added: readonly SessionToolId[];
  changed: readonly string[];
} {
  const cold = trigger === "cold-turn" || trigger === "compaction" || trigger === "model-switch";
  const added = candidate.tools.filter((tool) => {
    if (current.tools.includes(tool)) return false;
    if (cold) return true;
    if (current.codeMode === undefined || tool === "codemode") return false;
    const route = routeOf(candidate.codeMode, tool);
    return isCodeCallableRoute(route) && !isDeclaredRoute(route);
  });
  const membership = new Set<SessionToolId>([...current.tools, ...added]);
  const mcpTools = [
    ...(current.mcpTools ?? []),
    ...(candidate.mcpTools ?? []).filter((tool) => added.includes(tool.providerName)),
  ];
  // Match sessionToolBindings' canonical capability order. Existing verb and
  // MCP order remains intact; new names trail each respective group.
  const verbs = [...current.tools.filter(isVerbToolKey), ...added.filter(isVerbToolKey)];
  const tools: SessionToolId[] = [
    ...CODING_TOOL_IDS.filter((tool) => membership.has(tool)),
    ...NON_CODING_TOOL_IDS.filter((tool) => membership.has(tool)),
    ...verbs,
    ...mcpTools.map((tool) => tool.providerName),
  ];
  const changed: string[] = [];
  let codeMode: CodeModeSurface | undefined = current.codeMode;
  if (membership.has("codemode")) {
    const base = current.codeMode ?? candidate.codeMode;
    if (base === undefined) throw new Error("A Code Mode refresh requires recorded routes.");
    const routes = { ...current.codeMode?.routes };
    for (const tool of current.tools) {
      if (tool !== "codemode") routes[tool] = routeOf(current.codeMode, tool);
    }
    for (const tool of tools) {
      if (tool !== "codemode" && routes[tool] === undefined)
        routes[tool] = routeOf(candidate.codeMode, tool);
    }
    codeMode = { ...base, routes };
    if (cold && current.codeMode !== undefined && current.codeMode.descriptionVersion !== 2) {
      codeMode = { ...codeMode, descriptionVersion: 2 };
      changed.push("codemode");
    }
  }
  // Flat ask_user is not widened: today's questions schema does not accept all
  // flat inputs. Its name and declaration remain unchanged in older Sessions.
  const surface: Surface = {
    ...current,
    tools,
    ...(mcpTools.length === 0 ? {} : { mcpTools }),
    ...(codeMode === undefined ? {} : { codeMode }),
    ...(added.includes("ask_user") && candidate.askUserQuestions === true
      ? { askUserQuestions: true }
      : {}),
    ...(cold &&
    tools.some((tool) => (REFRESH_DESCRIPTION_TOOL_IDS as readonly string[]).includes(tool))
      ? { refreshDescriptions: true as const }
      : {}),
  };
  if (surface.refreshDescriptions === true && current.refreshDescriptions !== true) {
    changed.push(...REFRESH_DESCRIPTION_TOOL_IDS.filter((tool) => current.tools.includes(tool)));
  }
  if (
    cold &&
    current.codeMode !== undefined &&
    JSON.stringify(declared) !== JSON.stringify(surface) &&
    !changed.includes("codemode")
  )
    changed.push("codemode");
  return { surface, added, changed };
}
