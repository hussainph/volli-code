/**
 * Durable context compaction. Volli owns request-boundary scheduling and
 * model-aware budgeting; Pi supplies local summary generation and the linear
 * compaction entry. History stays on disk and only provider context is elided.
 */

import {
  compact,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  insertEntry,
  setValue,
  shouldCompact,
  type AgentMessage,
  type CompactionEntry,
  type CompactionSettings,
  type CustomEntry,
  type Entry,
  type MessageEntry,
  type JsonValue,
  type NewEntry,
  type Session,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models, Tool, Usage } from "@earendil-works/pi-ai";
import type { SessionUsage } from "@volli/shared";
import { prepareModelCompaction } from "./compaction-preparation";
import {
  compactProviderNative,
  nativeCompactionAvailable,
  nativeCompactionSupport,
  providerCompactionFromDetails,
  readProviderCompaction,
  type NativeRequestObservation,
  type ProviderCompactionState,
} from "./provider-compaction";
import { estimateContextTokens, projectedContextTokens } from "./token-counting";
import { piContext, type Context } from "./pi-context";
import { withoutReasoning } from "./reasoning";
import { MAIN_BRANCH_TIP } from "./sidecar-storage";
import { sanitizeDiagnostic, sessionUsageFrom } from "./transcript";

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

/** Apply the resolved reserve policy to measured-plus-estimated request occupancy. */
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

/** An unmeasured post-compaction estimate, never a billed token count. */
export function estimatedContextTokens(
  messages: readonly AgentMessage[],
  model: Model<Api>,
): number {
  return estimateContextTokens(messages, model);
}

/**
 * The durable branch as the CURRENT route can actually replay it.
 *
 * A provider-native checkpoint is opaque state bound to one model on one
 * endpoint, not a portable prose summary, so an entry holding one survives this
 * filter only when the model, the API family and the resolved route all still
 * match. Everything it replaces is still on disk, so dropping the entry does
 * not lose the conversation — it rebuilds it.
 *
 * Three ways an entry fails to survive, and they are not the same fact:
 *
 * - **Another model or API.** Expected, and silent: switching models is a
 *   thing people do, and the original history is exactly what should be sent.
 * - **A route that cannot replay it.** The catalog said `api.anthropic.com`
 *   and the credential that actually resolves is an OAuth subscription or an
 *   endpoint override, so the checkpoint would be replayed at a backend that
 *   never minted it. Also silent; also rebuilt.
 * - **An unreadable checkpoint.** Reported, because nothing about it is
 *   expected. The Session still attaches and still runs on its original
 *   history: fail-closed belongs on the OUTGOING projection, where sending the
 *   empty placeholder would ask a model to continue from nothing, and refusing
 *   to open the Session at all would answer a corrupt entry with a corrupt
 *   product (VC-331).
 */
export interface ModelCompactionPath {
  path: Entry[];
  /** Sanitized notices for checkpoints that could not be read at all. */
  discarded: readonly string[];
}

export function compactionPathForModel(
  path: readonly Entry[],
  model: Model<Api>,
  nativeRouteAvailable: boolean,
): ModelCompactionPath {
  const discarded: string[] = [];
  const kept = path.filter((entry) => {
    if (entry.type !== "compaction") return true;
    const read = readProviderCompaction(entry.details);
    if (read.kind === "absent") return true;
    if (read.kind === "malformed") {
      discarded.push(read.reason);
      return false;
    }
    // The catalog check is re-applied rather than trusted from the caller: the
    // flag says whether the RESOLVED credential can replay a checkpoint, and
    // this function must still be correct about the model it was handed.
    return (
      read.state.kind === model.api &&
      read.state.model === model.id &&
      nativeRouteAvailable &&
      nativeCompactionSupport(model).supported
    );
  });
  return { path: kept, discarded };
}

function withoutNativeCompactions(path: readonly Entry[]): Entry[] {
  return path.filter(
    (entry) =>
      entry.type !== "compaction" || readProviderCompaction(entry.details).kind === "absent",
  );
}

/**
 * The live provider context for one durable path — Pi's elision rule applied.
 *
 * `buildSessionContext` scans for the *last* compaction entry and returns it
 * followed by everything after it, then expands that entry into its summary
 * message and its retained tail. Called on every path, compacted or not, so the
 * attachment has one way of turning history into messages rather than one for
 * the ordinary case and another for the compacted one.
 *
 * **The retained tail is expanded without its reasoning.** Pi's compaction is
 * keep-tail: the summary replaces the older history and the most recent turns
 * are replayed verbatim behind it. Their reasoning blocks were produced
 * against the history the summary replaced, and a provider that binds a
 * `thinking` block to everything sent before it (Claude's preserved thinking)
 * refuses exactly that shape. The doc's repair is to strip `thinking` and
 * `redacted_thinking` from every turn carried across and keep `text` and
 * `tool_use`, which is what happens here — at the read rather than the write,
 * so a compaction entry persisted before this rule existed is expanded under
 * it too, and the durable entry stays exactly what Pi wrote (VC-242).
 */
export function contextMessages(path: readonly Entry[]): AgentMessage[] {
  const elided = path.map(withoutRetainedReasoning);
  return contextEntries(elided).flatMap(entryToContextMessages);
}

/**
 * The last compaction entry and everything after it; the whole path when there
 * is none.
 *
 * PI-RESTATED(0.85.0): Pi's `buildContextEntries`. Until 0.85.0 this module called Pi's
 * own function — `buildSessionContext` — precisely so that one rule existed in
 * one place. 0.85.0 made that module private: it is still there, at
 * `harness/session/context.js`, but the package's `exports` map no longer
 * offers any path that reaches it, and the root re-export was dropped. So the
 * rule is restated here, under protest, and the tests that used to prove this
 * module agreed with Pi now prove it against Pi's documented behaviour instead.
 *
 * Kept deliberately literal against the upstream source rather than tidied, so
 * the next bump can diff the two by eye. The one thing NOT carried across is
 * `SessionContextBuildOptions.entryProjectors`, which Pi applies to `custom`
 * entries: this runtime passed none, so custom entries contributed nothing then
 * and contribute nothing now. Volli's own acceptance markers are already
 * message entries by the time they reach here — {@link conversationPath} does
 * that — which is why dropping them at this step loses no user turn.
 */
function contextEntries(path: readonly Entry[]): Entry[] {
  for (let index = path.length - 1; index >= 0; index--) {
    const entry = path[index];
    if (entry?.type === "compaction") return [entry, ...path.slice(index + 1)];
  }
  return [...path];
}

/**
 * Whether a persisted message may be replayed to a model at all.
 *
 * Pi's `isContextMessage`: a reply that errored, was aborted, or is still
 * deferred is an honest record of what happened and not something to send back
 * as if it had been said. Note that pi-ai's `transformMessages` drops the same
 * three at the wire, which is what makes this filter and the resume filter
 * agree instead of merely coincide (VC-242).
 */
function replayableMessage(message: AgentMessage): boolean {
  return (
    message.role !== "assistant" ||
    (message.stopReason !== "error" &&
      message.stopReason !== "aborted" &&
      message.stopReason !== "deferred")
  );
}

/** Pi's `sessionEntryToContextMessages`, restated for the reason above. */
function entryToContextMessages(entry: Entry): AgentMessage[] {
  switch (entry.type) {
    case "message":
      return replayableMessage(entry.message) ? [entry.message] : [];
    case "compaction": {
      const native = providerCompactionFromDetails(entry.details);
      const summary =
        native?.kind === "openai-responses" ? openAIWindowStandIn(native) : entry.summary;
      return [
        createCompactionSummaryMessage(summary, entry.tokensBefore, entry.timestamp),
        ...entry.retainedTail.filter(replayableMessage).map(withoutRetainedUsage),
      ];
    }
    case "branch_summary":
      return entry.summary
        ? [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)]
        : [];
    case "custom":
      return [];
  }
}

/**
 * How much of a request an OpenAI canonical window occupies, before anything
 * has measured it.
 *
 * The checkpoint's own text placeholder is a sentence; the window it stands for
 * is not, and counting the sentence would tell a Session it had emptied a
 * context it had not. So the window is serialized and estimated — exactly, for
 * the ordinary items OpenAI retained, which are real text this runtime can
 * tokenize.
 *
 * **The opaque part is bounded rather than tokenized whole.** `encrypted_content`
 * is ciphertext with no published local token count and no fixed ratio to what
 * it encodes; a multi-megabyte blob run through a tokenizer produces a number
 * that is not an estimate of anything, and a request budget built on it would
 * conclude a freshly compacted Session had no room left — the exact failure
 * compaction exists to prevent. So the blob counts up to a ceiling and no
 * further: small checkpoints cost what they serialize, large ones cost the cap.
 * It is deliberately the conservative direction (a checkpoint never reads as
 * free) with a deliberate ceiling (it can never read as the whole window), and
 * the provider's next reply replaces the whole estimate with a measurement.
 *
 * This text never reaches a provider: `onPayload` substitutes the canonical
 * items for it, and a route that cannot do that reconstructs original history.
 */
const MAX_OPAQUE_CHECKPOINT_CHARS = 48_000;

function openAIWindowStandIn(
  native: Extract<ProviderCompactionState, { kind: "openai-responses" }>,
): string {
  return JSON.stringify(
    native.items.map((item) => {
      const opaque = item["encrypted_content"];
      return typeof opaque === "string" && opaque.length > MAX_OPAQUE_CHECKPOINT_CHARS
        ? { ...item, encrypted_content: opaque.slice(0, MAX_OPAQUE_CHECKPOINT_CHARS) }
        : item;
    }),
  );
}

/**
 * Retained replies measured the OLD prefix. Clear only their live-context
 * usage, not the durable message or its separately recorded bill. New replies
 * can then establish a measurement without timestamps or heuristic boundaries.
 */
function withoutRetainedUsage(message: AgentMessage): AgentMessage {
  if (message.role !== "assistant") return message;
  return {
    ...message,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

/** A compaction entry whose retained tail carries no reasoning; anything else as is. */
function withoutRetainedReasoning(entry: Entry): Entry {
  if (entry.type !== "compaction") return entry;
  const retainedTail = entry.retainedTail.map(withoutReasoning);
  return retainedTail.every((message, index) => message === entry.retainedTail[index])
    ? entry
    : { ...entry, retainedTail };
}

/** What one compaction attempt did. Only `compacted` changes anything. */
export type CompactionOutcome =
  | {
      kind: "compacted";
      entry: CompactionEntry;
      messages: AgentMessage[];
      /**
       * What the summarization cost, when Pi reported it.
       *
       * Carried on the outcome rather than left in the durable entry because
       * the entry is Pi's storage shape and the Session's bill is Volli's
       * fact. Pi may make more than one summarization request; the result it
       * returns is already the aggregate.
       */
      usage: SessionUsage | null;
      /**
       * Why the provider's own compaction was not used, when one was tried and
       * refused. Sanitized. Present only on a local summary that followed a
       * failed native attempt: the compaction succeeded, so this is not a
       * failure to report to the person, but it is the difference between a
       * Session quietly running on the more lossy mechanism and one whose
       * support read can say why.
       */
      nativeFailure?: string;
    }
  /** Pi found nothing to compact — an empty path, or one already ending in a compaction. */
  | { kind: "skipped" }
  /** The summarization call failed or was aborted. Nothing was written. */
  | { kind: "failed"; message: string; usage?: SessionUsage | null };

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
  systemPrompt?: string;
  tools?: readonly Tool[];
  /** Extra focus for the summary. Only an explicit request carries any. */
  customInstructions?: string;
  /**
   * The tail as this Session carries it across the summary, given the tail Pi
   * chose to keep.
   *
   * The one shaping step the durable entry admits, and it exists for a byte
   * identity: whatever the live context holds between the summary and the
   * kept turns has to be what a later attach reads back from the entry, or
   * every reasoning block produced after the compaction is bound to a prefix
   * the resume cannot reproduce. The runtime uses it to put the skill
   * resources it restores after a compaction INTO the entry rather than
   * inserting them into the live array afterwards (VC-242). Reasoning is not
   * this hook's concern; {@link contextMessages} strips it on every read.
   */
  retainedTail?: (tail: readonly AgentMessage[]) => AgentMessage[];
  signal?: AbortSignal;
  /** The attachment's instrumentation seam for native HTTP calls (VC-331). */
  onNativeRequest?: (observation: NativeRequestObservation) => void;
}

/**
 * Prefer a supported provider-native checkpoint; otherwise generate a local Pi
 * summary. Both paths append one linear compaction entry and preserve the
 * original history. JSON round-tripping removes undefined optional fields
 * which Pi's durable storage does not accept.
 */
export async function compactSession(input: CompactionInput): Promise<CompactionOutcome> {
  // The route decides whether an existing checkpoint is replayable at all; a
  // checkpoint this credential cannot replay is expanded back into the original
  // history before anything is summarized.
  const { path } = compactionPathForModel(
    input.path,
    input.model,
    await nativeCompactionAvailable(input.model, input.models, input.signal),
  );
  let prepared = prepareModelCompaction(path, input.settings, input.model);
  if (prepared === undefined) return { kind: "skipped" };
  const tokensBefore = projectedContextTokens(
    contextMessages(path),
    input.model,
    input.systemPrompt,
    input.tools,
  );
  prepared.tokensBefore = tokensBefore;
  const context = piContext(input.signal);
  // Compact the prefix, preserving Pi's safe call/result tail. The native
  // output window is canonical for that prefix and is never pruned itself.
  const prior = path.findLast((entry) => entry.type === "compaction");
  const previousState =
    prior?.type === "compaction" ? providerCompactionFromDetails(prior.details) : undefined;
  const prefix = [
    ...(prior?.type === "compaction"
      ? [createCompactionSummaryMessage(prior.summary, prior.tokensBefore, prior.timestamp)]
      : []),
    ...prepared.messagesToSummarize,
    ...prepared.turnPrefixMessages,
  ];
  const native =
    prefix.length === 0
      ? { kind: "unsupported" as const }
      : await compactProviderNative({
          model: input.model,
          models: input.models,
          messages: prefix,
          enabled: true,
          systemPrompt: input.systemPrompt,
          tools: input.tools,
          previousState,
          customInstructions: input.customInstructions,
          signal: input.signal,
          ...(input.onNativeRequest ? { onNativeRequest: input.onNativeRequest } : {}),
        });
  if (native.kind === "compacted") {
    const entry = await appendCompactionEntry(
      input.sidecar,
      durableJson({
        type: "compaction",
        id: input.sidecar.idGenerator.next(),
        parentId: null,
        summary: native.textSummary || "Provider-native context checkpoint.",
        retainedTail: input.retainedTail?.(prepared.retainedTail) ?? prepared.retainedTail,
        tokensBefore,
        ...(native.rawUsage ? { usage: native.rawUsage } : {}),
        details: durableDetails({ providerCompaction: native.state }),
        fromHook: false,
      }),
      context,
    );
    return {
      kind: "compacted",
      entry,
      messages: contextMessages([...path, entry]),
      usage: native.usage,
    };
  }
  if (input.signal?.aborted) return { kind: "failed", message: "Compaction aborted." };
  // A native checkpoint is opaque, not a portable prose summary. If native
  // compaction is unavailable, rebuild the ORIGINAL history before asking Pi
  // to summarize; never summarize an empty placeholder and lose the state.
  if (previousState !== undefined) {
    // Removing earlier native entries cannot remove the non-compaction leaf
    // which made the first preparation applicable.
    prepared = prepareModelCompaction(withoutNativeCompactions(path), input.settings, input.model)!;
    prepared.tokensBefore = tokensBefore;
  }
  // No reasoning level and no retry policy: the two `undefined`s Pi 0.85.0 moved
  // ahead of the context are the same two defaults 0.84.3 applied when the
  // arguments were optional, spelled out because they no longer are.
  const result = await compact(
    prepared,
    input.models,
    input.model,
    input.customInstructions,
    undefined,
    undefined,
    undefined,
    context,
  );
  const nativeUsage = native.kind === "failed" ? native.rawUsage : undefined;
  if (!result.ok)
    return {
      kind: "failed",
      message: sanitizeDiagnostic(result.error.message),
      ...(nativeUsage
        ? {
            usage: sessionUsageFrom(
              nativeUsage,
              { provider: input.model.provider, model: input.model.id, api: input.model.api },
              "compaction",
            ),
          }
        : {}),
    };

  const compacted = { ...result.value, usage: combinedUsage(result.value.usage, nativeUsage) };
  // A native attempt that was tried and refused is recorded beside the local
  // summary that replaced it. Sanitized, and additive to whatever Pi put in
  // `details` — Pi reads its own file lists out of that object and ignores
  // keys it did not write.
  const nativeFailure = native.kind === "failed" ? native.message : undefined;
  const provisioned: NewEntry<CompactionEntry> = {
    type: "compaction",
    id: input.sidecar.idGenerator.next(),
    parentId: null,
    summary: compacted.summary,
    retainedTail: input.retainedTail?.(compacted.retainedTail) ?? compacted.retainedTail,
    tokensBefore: compacted.tokensBefore,
    usage: compacted.usage,
    // `Object.assign` rather than a spread: Pi types `details` as any JSON
    // value, and a primitive source contributes nothing here instead of
    // needing a shape check that its own writer makes unreachable.
    details:
      nativeFailure === undefined
        ? compacted.details
        : durableDetails(
            Object.assign({}, compacted.details, { nativeCompactionFailure: nativeFailure }),
          ),
    // Pi's own compaction hook did not write this one; this module is the
    // caller Pi does not have. The flag exists so a hook-driven compaction can
    // be told from an application-driven one, and ours is the latter.
    fromHook: false,
  };
  const entry = await appendCompactionEntry(input.sidecar, durableJson(provisioned), context);
  return {
    kind: "compacted",
    entry,
    ...(nativeFailure === undefined ? {} : { nativeFailure }),
    messages: contextMessages([...input.path, entry]),
    // `CompactResult` carries a provider usage block but no API family, so the
    // basis comes from the model the summary was generated on — the same
    // model, and therefore the same adapter, that priced it. Everything else
    // is `sessionUsageFrom`'s, so a summary and a reply cannot end up measured
    // by two different rules.
    usage: sessionUsageFrom(
      compacted.usage,
      { provider: input.model.provider, model: input.model.id, api: input.model.api },
      "compaction",
    ),
  };
}

function combinedUsage(left: Usage | undefined, right: Usage | undefined): Usage | undefined {
  if (!left) return right;
  if (!right) return left;
  const usage: Usage = { ...left, cost: { ...left.cost } };
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    usage[key] += right[key];
    usage.cost[key] += right.cost[key];
  }
  usage.totalTokens += right.totalTokens;
  usage.cost.total += right.cost.total;
  return usage;
}

/**
 * Append one compaction entry to the main branch and return it as stored.
 *
 * PI-RESTATED(0.85.0): Pi removed `Session.appendEntry`. What replaced it is a commit: a
 * branch append is now `insertEntry` plus the `setValue` that advances the
 * branch tip, both inside one `mutate` so a reader can never observe an entry
 * that no branch points at. `Branch.appendMessage` and `Branch.appendCustomEntry`
 * wrap exactly that for their two entry types; there is no wrapper for a
 * compaction entry, so this is the same two writes done by hand, copied from
 * `StorageBackedSession.appendToBranch` rather than invented.
 *
 * The stored entry is completed from the commit's own `seq` and `timestamp`
 * rather than read back: those two fields are the only difference between what
 * this wrote and what is on disk, and the commit result reports both. Pi
 * applies them with `materializeCommittedEntry`, which its `exports` map does
 * not offer either — the same privacy that cost this module
 * `buildSessionContext`.
 */
async function appendCompactionEntry(
  sidecar: Session,
  entry: NewEntry<CompactionEntry>,
  context: Context,
): Promise<CompactionEntry> {
  return sidecar.mutate(async (mutator, mutationContext) => {
    const tip = await mutator.getValue(MAIN_BRANCH_TIP, mutationContext);
    const parented = { ...entry, parentId: tip?.value ?? null };
    const commit = await mutator.commit(
      [insertEntry(parented), setValue(MAIN_BRANCH_TIP, parented.id)],
      mutationContext,
    );
    return { ...parented, seq: commit.firstSeq, timestamp: commit.timestamp };
  }, context);
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

/**
 * The one place a runtime-shaped object becomes Pi's `JsonValue`.
 *
 * The assertion is not hopeful: the round trip is what makes it true, because
 * a value that survives `JSON.stringify` and `JSON.parse` IS JSON — and a
 * value that does not survive it throws here rather than at the durable write.
 */
function durableDetails(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
