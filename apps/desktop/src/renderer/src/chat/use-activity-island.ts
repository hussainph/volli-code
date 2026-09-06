/**
 * The Activity Island's composition seam (VC-268).
 *
 * The island is fed by four independent sources — Browser Tabs, subagents,
 * the plan, background shells — each arriving on its own ticket from its own
 * runtime. This is the one place they meet: one feed module per element,
 * each returning its slice of the model and its verbs, spread over the empty
 * island and the unwired verbs. `chat-plane.tsx` calls this and hands the
 * result to `ActivityIsland`; nothing else composes an island.
 *
 * HOW A FEED PLUGS IN, and why the shape is what it is. A feed is a hook
 * `useIslandX(sessionId, …, push)` returning `{ model, actions }` where
 * `model` is a `Pick` of {@link ActivityIslandModel} and `actions` a `Pick`
 * of {@link ActivityIslandActions}. Adding one is one import and one spread
 * into each of the two objects below — literally, which is the point: the
 * two remaining feeds (subagents, VC-269; shells, VC-270) should each land
 * as a two-line change here and nothing else in this file. The plan feed
 * predates the shape and returns its plan bare; it is assigned rather than
 * spread, and that is the whole of the exception.
 *
 * THE NOW CHANNEL IS SHARED. One {@link useIslandFlash} for the island, and
 * every feed is handed its `push`. Latest wins; the feeds never join the two
 * registers. What the island holds for how long is the island's business.
 *
 * Lives in `src/chat/`, not `components/chat/`, beside `use-island-plan.ts`
 * and `use-session-controller.ts`: these are bindings, not components (VC-6).
 */
import * as React from "react";

import {
  type ActivityIslandActions,
  type ActivityIslandModel,
  EMPTY_ACTIVITY_ISLAND,
} from "@volli/session-presentation";

import { useIslandFlash } from "./use-island-flash";
import { useIslandPlan } from "./use-island-plan";
import { useIslandTabs } from "./use-island-tabs";
import type { ChatSessionsStore } from "./use-session-controller";

export interface ActivityIslandBinding {
  model: ActivityIslandModel;
  actions: ActivityIslandActions;
}

/**
 * Every verb, unwired. A feed overrides the ones it owns; the rest stay here
 * and are UNREACHABLE by construction rather than by promise — no row on the
 * island calls a verb whose feed is not mounted, because the cluster that
 * would draw the row is not in the model either. The plan's `jumpStep` is
 * the one verb whose cluster IS live and whose rows still do not call it: the
 * plan card draws its rows inert (see `activity-island-ui.tsx`, `PlanCard`).
 * A no-op here is therefore never a silent no-op on screen.
 */
const UNWIRED_ACTIONS: ActivityIslandActions = {
  closeTab() {},
  promoteTab() {},
  peekAgent() {},
  promoteAgent() {},
  stopAgent() {},
  openShell() {},
  killShell() {},
  jumpStep() {},
};

export function useActivityIsland(
  sessionId: string,
  projectId: string,
  store?: ChatSessionsStore,
): ActivityIslandBinding {
  const { flash, push } = useIslandFlash();
  const tabs = useIslandTabs(sessionId, projectId, push);
  const plan = useIslandPlan(sessionId, store);
  // VC-269: `const agents = useIslandAgents(sessionId, push);`
  // VC-270: `const shells = useIslandShells(sessionId, push);`

  const model = React.useMemo<ActivityIslandModel>(
    () => ({
      ...EMPTY_ACTIVITY_ISLAND,
      ...tabs.model,
      // VC-269: `...agents.model,`
      // VC-270: `...shells.model,`
      plan,
      flash,
    }),
    [flash, plan, tabs.model],
  );
  const actions = React.useMemo<ActivityIslandActions>(
    () => ({
      ...UNWIRED_ACTIONS,
      ...tabs.actions,
      // VC-269: `...agents.actions,`
      // VC-270: `...shells.actions,`
    }),
    [tabs.actions],
  );
  return React.useMemo(() => ({ model, actions }), [model, actions]);
}
