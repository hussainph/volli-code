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
 * over its own store returning its slice of {@link ActivityIslandModel} and
 * its `Pick` of {@link ActivityIslandActions}. Adding one is one import and
 * one spread into each of the two objects below — literally, which is the
 * point: the subagent feed (VC-269) landed as exactly that. All four are
 * live:
 *
 *  • tabs   — `useIslandTabs` (this ticket), `{ model: { tabs }, actions }`.
 *  • agents — `useIslandAgents` (VC-269), the same shape; its two doors
 *             (peek, open as tab) come from the mount like the shells' does.
 *  • plan   — `useIslandPlan` (VC-6), which predates the shape and returns
 *             its plan bare; assigned rather than spread.
 *  • shells — `useIslandShells` (VC-270), `{ shells, flash, openShell,
 *             killShell }` flat. Its verbs spread; its shells assign.
 *
 * THE NOW CHANNEL IS SHARED. One {@link useIslandFlash} for the island, and
 * a feed announces through its `push`. Latest wins across feeds; no feed
 * joins the two registers. The shell feed keeps its own latest-transition
 * state (it was built before this channel existed), so the seam relays each
 * new one into the channel — one effect, keyed on the flash's id, so a
 * re-render that changed nothing re-announces nothing.
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

import { useIslandShells } from "@renderer/components/chat/island-shells";
import { useIslandAgents } from "./use-island-agents";
import { useIslandFlash } from "./use-island-flash";
import { useIslandPlan } from "./use-island-plan";
import { useIslandTabs } from "./use-island-tabs";
import type { ChatSessionsStore } from "./use-session-controller";

export interface ActivityIslandBinding {
  model: ActivityIslandModel;
  actions: ActivityIslandActions;
}

/** What the mount supplies: the lab's own store, and where each promotion opens. */
export interface ActivityIslandDeps {
  /** The UI lab's own chat-sessions store; omitted in the app. */
  store?: ChatSessionsStore;
  /**
   * Where `openShell` puts a shell's tail — the MOUNT's decision, not the
   * feed's (VC-270). Omitted means the verb opens nowhere, which the lab
   * accepts because it has no shells to open.
   */
  openShellOutput?: (shellId: string) => void;
  /** Where `peekAgent` opens a child: the plane's peek overlay (VC-269). */
  peekSession?: (sessionId: string) => void;
  /** Where `promoteAgent` opens a child: the host's own open-session door (VC-269). */
  openSession?: (sessionId: string) => void;
}

/**
 * The verbs NO feed owns yet. A verb a mounted feed supplies is not here —
 * it would be a no-op that nothing can ever reach, and the seam would then
 * carry a default whose correctness no test could show. What is left is
 * UNREACHABLE by construction rather than by promise: no row on the island
 * calls a verb whose feed is not mounted, because the cluster that would draw
 * the row is not in the model either.
 *
 * `jumpStep` is the one verb whose cluster IS live and whose rows still do
 * not call it: the plan card draws its rows inert (`activity-island-ui.tsx`,
 * `PlanCard`), so a no-op here is never a silent no-op on screen.
 *
 * The composed object below is annotated `ActivityIslandActions`, so the
 * compiler — not a comment — is what proves the eight verbs are all supplied.
 */
const VERBS_WITHOUT_A_FEED = {
  jumpStep() {},
} satisfies Partial<ActivityIslandActions>;

export function useActivityIsland(
  sessionId: string,
  projectId: string,
  deps: ActivityIslandDeps = {},
): ActivityIslandBinding {
  const { flash, push } = useIslandFlash();
  const tabs = useIslandTabs(sessionId, projectId, push);
  const plan = useIslandPlan(sessionId, deps.store);
  const shells = useIslandShells(sessionId, { openOutput: deps.openShellOutput });
  const agents = useIslandAgents(sessionId, projectId, push, {
    ...(deps.store === undefined ? {} : { store: deps.store }),
    ...(deps.peekSession === undefined ? {} : { peekSession: deps.peekSession }),
    ...(deps.openSession === undefined ? {} : { openSession: deps.openSession }),
  });

  // The shell feed's latest transition, relayed into the shared channel.
  const shellFlash = shells.flash;
  React.useEffect(() => {
    if (shellFlash !== null) push(shellFlash.event, shellFlash.payload);
  }, [push, shellFlash]);

  const model = React.useMemo<ActivityIslandModel>(
    () => ({
      ...EMPTY_ACTIVITY_ISLAND,
      ...tabs.model,
      ...agents.model,
      plan,
      shells: shells.shells,
      flash,
    }),
    [agents.model, flash, plan, shells.shells, tabs.model],
  );
  const { openShell, killShell } = shells;
  const actions = React.useMemo<ActivityIslandActions>(
    () => ({
      ...VERBS_WITHOUT_A_FEED,
      ...tabs.actions,
      ...agents.actions,
      openShell,
      killShell,
    }),
    [agents.actions, killShell, openShell, tabs.actions],
  );
  return React.useMemo(() => ({ model, actions }), [model, actions]);
}
