/** Effective surfaces are additive facts; the birth input remains N−1-readable. */
import {
  CODING_TOOL_IDS,
  NON_CODING_TOOL_IDS,
  isCodeCallableRoute,
  isDeclaredRoute,
  isVerbToolKey,
  isSessionToolId,
  routeOf,
  REFRESH_DESCRIPTION_TOOL_IDS,
  type CodeModeSurface,
  type SessionEvent,
  type SessionInput,
  type SessionToolId,
} from "@volli/shared";

type Surface = Extract<SessionInput, { kind: "tool-surface" }>;
type Trigger = "cold-turn" | "warm-turn" | "compaction" | "model-switch" | "code-mode";

/** Read the latest effective fact without modifying the first, birth-only input. */
export function effectiveToolSurface(events: readonly SessionEvent[]): Surface | null {
  let surface: Surface | null = null;
  for (const event of events) {
    if (
      event.payload.kind === "session.input.recorded" &&
      event.payload.input.kind === "tool-surface"
    ) {
      surface ??= event.payload.input;
    } else if (
      event.payload.kind === "session.tools.refreshed" &&
      event.payload.surface.tools.every(isSessionToolId)
    ) {
      // A future writer may add names this build cannot bind. Keep the last
      // compatible epoch, rather than failing every read/attach of the Session.
      surface = event.payload.surface;
    }
  }
  return surface;
}

/** The last paid/cold epoch, independent of warm executable additions. */
export function declarationToolSurface(events: readonly SessionEvent[]): Surface | null {
  let surface: Surface | null = null;
  for (const event of events) {
    if (
      event.payload.kind === "session.input.recorded" &&
      event.payload.input.kind === "tool-surface"
    )
      surface ??= event.payload.input;
    else if (
      event.payload.kind === "session.tools.refreshed" &&
      ["cold-turn", "compaction", "model-switch"].includes(event.payload.trigger) &&
      event.payload.surface.tools.every(isSessionToolId)
    )
      surface = event.payload.surface;
  }
  return surface;
}

/** Existing schemas and routes are retained; only the explicit image capability is widened. */
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
