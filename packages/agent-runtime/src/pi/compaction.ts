/**
 * Context compaction: the mechanism, not the policy.
 *
 * Pi 0.84.1 ships compaction's primitives and its durable data model but no
 * orchestrator — `shouldCompact`, `prepareCompaction` and `compact` are exported
 * and nothing in the package ever calls them, and `AgentHarness`, which would
 * have owned the loop, rejects every operation with `HarnessNotImplemented`.
 * Volli builds on the lower-level `Agent` regardless. So this module is the
 * caller Pi does not have, and deliberately no more than that: every decision it
 * makes is Pi's own rule invoked, never a rule restated here.
 *
 * The policy those rules are run under — whether a Session compacts on its own,
 * and what reserve a given model keeps free — is `CompactionPolicy` in
 * `@volli/shared`, resolved into the `CompactionSettings` this module is handed
 * by whoever calls it. Nothing here reads it, and nothing here defaults it.
 *
 * Three things are worth stating plainly, because each is a place a
 * reimplementation would drift.
 *
 * **Compaction is linear.** It appends a `CompactionEntry` as a child of the
 * current leaf. Nothing on disk is rewritten and nothing is deleted: the
 * pre-compaction history stays exactly where it was, as the ancestor path, and
 * is only dropped from the payload sent to the provider.
 *
 * **The elision rule is Pi's**, taken from `session/context.js` rather than
 * copied: the last compaction entry, then everything after it. {@link
 * contextMessages} is a one-line call into `buildSessionContext` for exactly
 * that reason — the live message array and a restart-time replay must apply one
 * rule, and two spellings of it would be one rule until the first time they
 * disagreed.
 *
 * **Occupancy is measured, never estimated.** Pi's own `estimateContextTokens`
 * mixes the last measured usage with a character heuristic for everything after
 * it; {@link occupiedContextTokens} takes only the measured half. A model that
 * has never reported usage has no occupancy here, and a Session with no
 * occupancy never trips the threshold — which is the direction to be wrong in,
 * since the alternative is compacting a conversation on the strength of a guess.
 */

import {
  buildSessionContext,
  calculateContextTokens,
  compact,
  estimateTokens,
  getLastAssistantUsage,
  getOrThrow,
  prepareCompaction,
  shouldCompact,
  type AgentMessage,
  type CompactionEntry,
  type CompactionSettings,
  type CustomEntry,
  type Entry,
  type MessageEntry,
  type ProvisionedEntry,
  type Session,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { sanitizeDiagnostic } from "./transcript";

/**
 * A model's usable window, or nothing when the catalog does not report one.
 *
 * Pi types `contextWindow` as required, but a gateway entry can still carry 0 or
 * garbage, and "no window" must stay distinguishable from a zero-token one: a
 * model with no known window never trips the threshold, where a model whose
 * window read as zero would trip it on its first reply. Shared with Model
 * Access, which sanitizes the same field for the same reason.
 */
export function contextWindowOf(model: { readonly contextWindow: number }): number | undefined {
  return Number.isFinite(model.contextWindow) && model.contextWindow > 0
    ? Math.floor(model.contextWindow)
    : undefined;
}

/**
 * The context the model was actually holding when it last answered.
 *
 * Two of Pi's own functions and nothing between them: `getLastAssistantUsage`
 * picks the message — newest first, skipping the aborted and errored replies
 * whose usage describes a request that never completed — and
 * `calculateContextTokens` reads the occupancy off it, preferring the
 * provider's own `totalTokens` and falling back to the four fields the
 * transcript records per message (`usageOf`) summed. Cache reads and writes
 * belong in that sum: they are prompt tokens the model held, and counting
 * `input` alone understates a cached turn to the point of uselessness.
 *
 * Summing the four here by hand would be close enough to look right and would
 * still be a second rule. It is the one Pi applies to compute the
 * `tokensBefore` this feature reports, so a hand-rolled sum would put the
 * number that DECIDES to compact and the number that DESCRIBES the compaction
 * on different definitions of one quantity — agreeing for every provider that
 * totals the way we assumed, and silently disagreeing for the first that does
 * not.
 */
export function occupiedContextTokens(path: readonly Entry[]): number | undefined {
  const usage = getLastAssistantUsage([...path]);
  return usage === undefined ? undefined : calculateContextTokens(usage);
}

/**
 * Pi's reserve rule, unchanged: `used > window − reserve`.
 *
 * Not a percentage of the window. Seventy percent of Gemini's million-token
 * window would strand three hundred thousand tokens of usable headroom, while
 * the same fraction of a small window would leave too little room for the reply.
 * A reserve is the quantity that actually has to fit.
 *
 * The window is required, not optional: "this model reports no usable window"
 * is {@link contextWindowOf} returning nothing, and a caller holding nothing has
 * already been told the answer. Unmeasured occupancy is the case that genuinely
 * belongs here, because it is a property of the conversation rather than of the
 * model, and it never compacts.
 */
export function compactionDue(
  occupied: number | undefined,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  return occupied !== undefined && shouldCompact(occupied, contextWindow, settings);
}

/**
 * How to read the two things only the runtime knows about its own sidecar.
 *
 * The sidecar is not a plain transcript. A user message delivered through an
 * accepted command is persisted inside that command's own durable marker rather
 * than as a message entry, so a reader that understood only `message` entries
 * would summarize a conversation with every user turn missing from it. And a
 * message entry is not automatically replayable — an assistant reply that was
 * aborted mid-stream stays on disk as the honest record of what happened and
 * must not be fed back to the model as if it had been said.
 */
export interface ConversationReader {
  /** The user message a durable acceptance marker carries, when it carries one. */
  acceptedMessage: (entry: CustomEntry) => AgentMessage | undefined;
  /** Whether a persisted message entry may re-enter the live context. */
  replayable: (entry: MessageEntry) => boolean;
}

/**
 * The durable branch as Pi's own compaction and context primitives read it.
 *
 * Acceptance markers become the message entries they always were; unreplayable
 * messages drop out; everything else — compaction entries above all — passes
 * through untouched, because Pi knows what to do with entry types this runtime
 * never writes and guessing on its behalf would be the drift this module exists
 * to avoid.
 *
 * Parent links on the synthesized entries are the originals' and are not
 * repaired after a drop. Nothing downstream walks them: `prepareCompaction`,
 * `findCutPoint` and `buildSessionContext` all read this as an ordered array.
 */
export function conversationPath(entries: readonly Entry[], reader: ConversationReader): Entry[] {
  return entries.flatMap<Entry>((entry) => {
    if (entry.type === "custom") {
      const accepted = reader.acceptedMessage(entry);
      if (accepted === undefined) return [];
      return [
        {
          type: "message",
          id: entry.id,
          seq: entry.seq,
          parentId: entry.parentId,
          timestamp: entry.timestamp,
          message: accepted,
        },
      ];
    }
    if (entry.type === "message") return reader.replayable(entry) ? [entry] : [];
    return [entry];
  });
}

/**
 * What a context is expected to occupy before anything has measured it.
 *
 * Pi's per-message character heuristic, summed — deliberately not its
 * `estimateContextTokens`, which would start from the newest measured usage in
 * the list. On a *compacted* context that measurement is the one number this
 * must not use: the retained tail still carries the usage of the reply that
 * overflowed, and reading it back would report the window as full immediately
 * after emptying it.
 *
 * This is the one estimate in this module and it decides nothing. Compaction
 * still triggers on measurement alone ({@link occupiedContextTokens}); an
 * estimate is only what can honestly be said about a context the model has not
 * answered on yet.
 */
export function estimatedContextTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

/**
 * The live provider context for one durable path — Pi's elision rule applied.
 *
 * `buildSessionContext` scans for the *last* compaction entry and returns it
 * followed by everything after it, then expands that entry into its summary
 * message and its retained tail. Called on every path, compacted or not, so the
 * attachment has one way of turning history into messages rather than one for
 * the ordinary case and another for the compacted one.
 */
export function contextMessages(path: readonly Entry[]): AgentMessage[] {
  return buildSessionContext(path).messages;
}

/** What one compaction attempt did. Only `compacted` changes anything. */
export type CompactionOutcome =
  | { kind: "compacted"; entry: CompactionEntry; messages: AgentMessage[] }
  /** Pi found nothing to compact — an empty path, or one already ending in a compaction. */
  | { kind: "skipped" }
  /** The summarization call failed or was aborted. Nothing was written. */
  | { kind: "failed"; message: string };

export interface CompactionInput {
  /** The Pi session this attachment owns; the entry is appended to its main lane. */
  sidecar: Session;
  /** The durable branch, already read through {@link conversationPath}. */
  path: readonly Entry[];
  models: Models;
  /** The model currently selected in this Session's chat. */
  model: Model<Api>;
  /** The executor's rule, already resolved from the configured policy. */
  settings: CompactionSettings;
  /** Extra focus for the summary. Only an explicit request carries any. */
  customInstructions?: string;
  signal?: AbortSignal;
}

/**
 * Summarize the compactable history and append the result as a durable entry.
 *
 * The whole operation is Pi's: `prepareCompaction` chooses the cut point and
 * decides whether there is anything to do, `compact` generates the summary and
 * reports what the call cost, and the entry is the type Pi's own storage,
 * context builder and cut-point search already understand. The one thing added
 * here is the JSON round trip — Pi's session storage rejects a payload
 * containing `undefined`, and a provider's usage block carries optional fields
 * that are exactly that.
 *
 * No reasoning level is passed. A summarizer is asked to restructure text it has
 * been handed, not to think about it, and paying for reasoning tokens on
 * context maintenance would add cost without improving the checkpoint.
 */
export async function compactSession(input: CompactionInput): Promise<CompactionOutcome> {
  // `getOrThrow`, not a failure arm. `prepareCompaction` is pure and has no path
  // to an error in 0.84.1, so a handled branch here would be untestable
  // decoration; this way a future version that does fail reaches the caller as a
  // thrown error rather than being filed as "nothing to compact".
  const prepared = getOrThrow(prepareCompaction([...input.path], input.settings));
  if (prepared === undefined) return { kind: "skipped" };

  const result = await compact(
    prepared,
    input.models,
    input.model,
    input.customInstructions,
    input.signal,
  );
  if (!result.ok) return { kind: "failed", message: sanitizeDiagnostic(result.error.message) };

  const compacted = result.value;
  const provisioned: ProvisionedEntry<CompactionEntry> = {
    type: "compaction",
    id: input.sidecar.idGenerator.next(),
    summary: compacted.summary,
    retainedTail: compacted.retainedTail,
    tokensBefore: compacted.tokensBefore,
    usage: compacted.usage,
    details: compacted.details,
  };
  const entry = await input.sidecar.appendEntry<CompactionEntry>(durableJson(provisioned), "main");
  return { kind: "compacted", entry, messages: contextMessages([...input.path, entry]) };
}

/**
 * Pi's session storage rejects a payload containing `undefined` outright, and a
 * provider's usage block carries optional fields that are exactly that. One
 * round trip over the whole entry drops them — absent keys rather than present
 * ones holding nothing — which is also how an absent optional stays absent.
 */
function durableJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
