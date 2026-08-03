/**
 * The pure half of the chat session surface: what the runtime catalog offers,
 * which of its agents a person may pick, and what the composer's keystrokes
 * mean right now. No React, no transport — every rule here is a function of its
 * arguments so it is testable without mounting a session.
 */
import type { SessionCapabilitySnapshot, SessionCapabilityState } from "@volli/shared";

export interface RuntimeModel {
  id: string;
  label: string;
  state: SessionCapabilityState;
  providerId: string;
  modelId: string;
  variants: readonly string[];
}

export interface RuntimeAgent {
  id: string;
  label: string;
  state: SessionCapabilityState;
  mode: string | null;
  /** Declared by the harness for agents it runs but never offers. */
  hidden: boolean | null;
  description: string | null;
}

export interface RuntimeCatalog {
  providers: readonly string[];
  models: readonly RuntimeModel[];
  agents: readonly RuntimeAgent[];
}

export interface RuntimeSelection {
  providerId: string;
  modelId: string;
  variant: string;
  agent: string;
}

export function deriveRuntimeCatalog(snapshot: SessionCapabilitySnapshot | null): RuntimeCatalog {
  const models = (snapshot?.catalog ?? []).flatMap((item): RuntimeModel[] => {
    if (item.kind !== "model" || !isRecord(item.detail)) return [];
    const providerId = recordString(item.detail, "providerId");
    const modelId = recordString(item.detail, "modelId");
    if (!providerId || !modelId) return [];
    return [
      {
        id: item.id,
        label: item.label,
        state: item.state,
        providerId,
        modelId,
        variants: recordStrings(item.detail, "variants"),
      },
    ];
  });
  const agents = (snapshot?.catalog ?? []).flatMap((item): RuntimeAgent[] => {
    if (item.kind !== "agent") return [];
    const detail = isRecord(item.detail) ? item.detail : null;
    return [
      {
        id: item.id,
        label: item.label,
        state: item.state,
        mode: detail ? recordString(detail, "mode") : null,
        hidden: detail ? recordBoolean(detail, "hidden") : null,
        description: detail ? recordString(detail, "description") : null,
      },
    ];
  });
  return {
    providers: [
      ...new Set(
        models.filter((model) => model.state === "available").map((model) => model.providerId),
      ),
    ],
    models,
    agents,
  };
}

/**
 * Structural on purpose: the same rule resolves a catalog derived here from a
 * capability snapshot and the server-side `RuntimeCatalogChoices` the live
 * session receives. Neither is the authority on the other's shape.
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

/* -------------------------------------------------------------- approvals */

/** What the approval card offers. Deliberately narrower than what a harness may declare. */
export type ApprovalDecision = "allow" | "deny" | "steer";

/**
 * The open interaction a transcript row's gate belongs to.
 *
 * The row carries the harness's own permission id (`part.approval.id`); the
 * command needs the Session's interaction id. The adapter happens to mint the
 * latter as `permission:<native>`, but reconstructing that string here would
 * make the renderer depend on a naming convention it cannot see change. The
 * projection already publishes both, so matching on `native.id` is the honest
 * lookup and stays correct for a harness that numbers its interactions
 * differently.
 */
export function findInteractionByNativeId<T extends { native: { id: string | null } }>(
  interactions: readonly T[],
  nativeId: string,
): T | null {
  // A null native id belongs to an interaction the harness never correlated to a
  // call, so it can match no row — and must never match by being equally absent.
  return interactions.find((interaction) => interaction.native.id === nativeId) ?? null;
}

/**
 * Which declared option a decision means.
 *
 * Option *polarity* is not a declared fact yet — `SessionInteractionOption` has
 * an id, a label and a description, and nothing that says "this one is the no".
 * So the vocabulary below is the seam where that fact belongs when a harness
 * starts stating it, and until then it is matched against the ids the harness
 * actually declared rather than assumed. OpenCode declares `once` / `always` /
 * `reject`; a harness declaring none of these still resolves, because the
 * fallback keeps a rejection from ever being read as consent: an unrecognized
 * allow is a no-op, an unrecognized deny is the last option.
 *
 * `steer` denies. It is a rejection with a follow-up instruction, and the
 * instruction is an ordinary message — OpenCode has no "reject with a reason"
 * reply, and inventing one here would make the transcript claim the harness saw
 * text it never received.
 */
const ALLOW_OPTION_IDS = ["once", "allow", "approve", "accept", "yes"];
const DENY_OPTION_IDS = ["reject", "deny", "decline", "no", "cancel"];

export function approvalOptionId(
  options: readonly { id: string }[],
  decision: ApprovalDecision,
): string | null {
  const vocabulary = decision === "allow" ? ALLOW_OPTION_IDS : DENY_OPTION_IDS;
  const declared = options.find((option) => vocabulary.includes(option.id.toLowerCase()));
  if (declared) return declared.id;
  if (decision === "allow") return null;
  return options[options.length - 1]?.id ?? null;
}

/* ------------------------------------------------------------------ shared */

function recordString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordBoolean(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

function recordStrings(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
