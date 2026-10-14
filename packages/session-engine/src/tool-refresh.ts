import {
  routeOf,
  isSessionToolId,
  REFRESH_DESCRIPTION_TOOL_IDS,
  type SessionEvent,
  type SessionInput,
} from "@volli/shared";
import { canonicalJson } from "./transcript-artifacts";

type Surface = Extract<SessionInput, { kind: "tool-surface" }>;
type Refresh = Extract<SessionEvent["payload"], { kind: "session.tools.refreshed" }>;

function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function fail(): never {
  throw new Error("Tool refresh must preserve existing names, routes and compatible declarations");
}

/** Internal ledger guard. Runtime policy cannot weaken the additions-only contract. */
export function assertAdditiveToolRefresh(
  current: Surface,
  refresh: Refresh,
  declared: Surface = current,
): void {
  const next = refresh.surface;
  const cold = ["cold-turn", "compaction", "model-switch"].includes(refresh.trigger);
  const added = next.tools.filter((tool) => !current.tools.includes(tool));
  const changed = new Set<string>();
  if (
    next.tools.some((tool) => !isSessionToolId(tool)) ||
    new Set(next.tools).size !== next.tools.length ||
    current.tools.some((tool) => !next.tools.includes(tool))
  )
    fail();
  if (!same(added.toSorted(), refresh.added.toSorted())) fail();
  if (current.mcpManagementNames !== next.mcpManagementNames) fail();
  for (const tool of current.tools) {
    if (routeOf(current.codeMode, tool) !== routeOf(next.codeMode, tool)) fail();
  }
  if (!cold && added.some((tool) => !["code", "deferred"].includes(routeOf(next.codeMode, tool))))
    fail();
  if (current.askUserQuestions !== next.askUserQuestions) {
    if (
      !cold ||
      current.tools.includes("ask_user") ||
      next.askUserQuestions !== true ||
      !next.tools.includes("ask_user")
    )
      fail();
  }
  if (current.refreshDescriptions !== next.refreshDescriptions) {
    if (!cold || current.refreshDescriptions === true || next.refreshDescriptions !== true) fail();
    for (const tool of REFRESH_DESCRIPTION_TOOL_IDS) {
      if (current.tools.includes(tool)) changed.add(tool);
    }
  }
  for (const old of current.mcpTools ?? []) {
    const replacement = next.mcpTools?.find((tool) => tool.providerName === old.providerName);
    // Equal schemas are a conservative proof: description-only edits accept
    // every old input. Arbitrary JSON Schema widening needs a separate proof.
    if (!replacement || !same({ ...old, description: "" }, { ...replacement, description: "" }))
      fail();
    if (replacement!.description !== old.description) {
      if (!cold) fail();
      changed.add(old.providerName);
    }
  }
  if (current.codeMode !== undefined) {
    if (next.codeMode === undefined) fail();
    const { routes: _oldRoutes, ...oldDeclaration } = current.codeMode;
    const { routes: _newRoutes, ...newDeclaration } = next.codeMode!;
    if (!same(oldDeclaration, newDeclaration)) {
      if (!cold) fail();
      // Image-capable Code Mode preserves every old program/input.
      const old = oldDeclaration as Record<string, unknown>;
      const updated = newDeclaration as Record<string, unknown>;
      if (updated.descriptionVersion !== old.descriptionVersion && updated.descriptionVersion !== 2)
        fail();
      const { descriptionVersion: _oldVersion, ...oldRest } = old;
      const { descriptionVersion: _newVersion, ...newRest } = updated;
      if (!same(oldRest, newRest)) fail();
      changed.add("codemode");
    }
  } else if (next.codeMode !== undefined && !added.includes("codemode")) fail();
  // A cold boundary may redeclare Code Mode's namespace/count description
  // after warm additions, even when executable membership is already current.
  if (
    cold &&
    current.codeMode !== undefined &&
    refresh.changed.includes("codemode") &&
    !same(declared, next)
  )
    changed.add("codemode");
  if (!same([...changed].toSorted(), refresh.changed.toSorted())) fail();
}
