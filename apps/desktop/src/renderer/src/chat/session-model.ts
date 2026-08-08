/**
 * Pure chat-session rules for model selection, agent visibility, and composer
 * keystrokes. No React or transport — every rule is testable without mounting
 * a session.
 */
import type { SessionCapabilityState } from "@volli/shared";

export interface RuntimeSelection {
  providerId: string;
  modelId: string;
  variant: string;
  agent: string;
}

/**
 * Structural on purpose: the live session owns the catalog shape while this
 * rule needs only the fields required to settle an available selection.
 */
interface SelectableModel {
  providerId: string;
  modelId: string;
  state: SessionCapabilityState;
  variants: readonly string[];
}

interface SelectableAgent extends AgentVisibility {
  id: string;
  state: SessionCapabilityState;
}

export function resolveRuntimeSelection(
  catalog: { models: readonly SelectableModel[]; agents: readonly SelectableAgent[] },
  current: RuntimeSelection,
): RuntimeSelection {
  const currentModel = catalog.models.find(
    (model) =>
      model.providerId === current.providerId &&
      model.modelId === current.modelId &&
      model.state === "available",
  );
  const model = currentModel ?? catalog.models.find((candidate) => candidate.state === "available");
  // A default must be an agent a person could have chosen, so the fallback
  // walks the primary list — never `compaction` merely because it sorted first.
  const available = catalog.agents.filter((candidate) => candidate.state === "available");
  const agent =
    available.find((candidate) => candidate.id === current.agent) ??
    primaryAgents(available)[0] ??
    available[0];
  return {
    providerId: model?.providerId ?? "",
    modelId: model?.modelId ?? "",
    variant: model?.variants.includes(current.variant)
      ? current.variant
      : (model?.variants[0] ?? ""),
    agent: agent?.id ?? "",
  };
}

/* ------------------------------------------------------------------ agents */

/**
 * The two flags that decide whether an agent is a person's to pick. Structural
 * rather than tied to one catalog type: the shared `RuntimeCatalogAgent` does
 * not carry `hidden` yet, and an agent that omits the flag must read as visible
 * instead of failing to type-check.
 */
export interface AgentVisibility {
  mode: string | null;
  hidden?: boolean | null;
}

/**
 * What the composer needs from an agent.
 *
 * Deliberately wider than the shared `RuntimeCatalogAgent`, which carries
 * `mode` but not `hidden`: the adapter reads both off OpenCode and the flag is
 * dropped at the catalog boundary, so today the live picker filters subagents
 * and still shows `compaction`. Widening here means the renderer is already
 * correct and the fix is one field on the shared type.
 */
export interface ComposerAgent extends AgentVisibility {
  id: string;
  label: string;
  state: SessionCapabilityState;
}

/**
 * Which agents the composer offers — a harness-declared fact, never a denylist.
 *
 * OpenCode marks `compaction` / `title` / `summary` with `hidden: true` and
 * `general` / `explore` with `mode: "subagent"`, and its own picker applies
 * exactly this rule. Filtering on declared flags means harness #2 gets correct
 * behavior with no code change, where a name list would need editing per
 * harness and would rot silently the first time one renamed a helper.
 */
export function isPrimaryAgent(agent: AgentVisibility): boolean {
  return agent.mode !== "subagent" && agent.hidden !== true;
}

export function primaryAgents<T extends AgentVisibility>(agents: readonly T[]): T[] {
  return agents.filter((agent) => isPrimaryAgent(agent));
}

/**
 * A mode control is a choice between alternatives. One survivor is not a
 * choice, and zero is a harness that does not have modes — both render nothing
 * rather than a disabled control explaining itself.
 */
export function offersAgentChoice(agents: readonly AgentVisibility[]): boolean {
  return primaryAgents(agents).length >= 2;
}

/* ---------------------------------------------------------------- composer */

/**
 * What ⏎ means right now.
 *
 * Delivery is session state, not a control: idle, ⏎ sends; while a turn is live
 * ⏎ queues behind it and ⌘⏎ steers the turn already running. The same keystroke
 * carries a different meaning because the Session is in a different state,
 * which is why five delivery options in a `<select>` was the wrong shape.
 */
export type ComposerIntent = "send" | "queue" | "steer";

export function composerIntent(state: { working: boolean; steer: boolean }): ComposerIntent {
  if (!state.working) return "send";
  return state.steer ? "steer" : "queue";
}

export interface QueuedMessage {
  id: string;
  text: string;
}

/** Blank text is not a message; it never reaches the queue. */
export function enqueueMessage(
  queue: readonly QueuedMessage[],
  message: QueuedMessage,
): QueuedMessage[] {
  const text = message.text.trim();
  return text.length === 0 ? [...queue] : [...queue, { id: message.id, text }];
}

export function removeQueued(queue: readonly QueuedMessage[], id: string): QueuedMessage[] {
  return queue.filter((entry) => entry.id !== id);
}

/**
 * `⌫` on an empty box. The newest queued message comes back to the textarea
 * rather than vanishing, so unqueue and edit are the same gesture and neither
 * one can lose typing.
 */
export function unqueueLast(
  queue: readonly QueuedMessage[],
): { queue: QueuedMessage[]; text: string } | null {
  const last = queue[queue.length - 1];
  if (last === undefined) return null;
  return { queue: queue.slice(0, -1), text: last.text };
}

/** Pull one specific entry back for editing. Same rule as {@link unqueueLast}. */
export function takeQueued(
  queue: readonly QueuedMessage[],
  id: string,
): { queue: QueuedMessage[]; text: string } | null {
  const found = queue.find((entry) => entry.id === id);
  if (found === undefined) return null;
  return { queue: removeQueued(queue, id), text: found.text };
}

/**
 * The queued message to release now, if any. A queue drains only into an idle
 * Session and only one at a time: the release starts the next turn, which makes
 * the Session busy again and re-arms this rule for the one after it.
 */
export function nextRelease(
  queue: readonly QueuedMessage[],
  state: { working: boolean; ready: boolean },
): QueuedMessage | null {
  if (state.working || !state.ready) return null;
  return queue[0] ?? null;
}
