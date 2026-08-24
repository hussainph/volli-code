/** The singular, Node-hostable Agent Runtime backed by Pi core. */

import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  convertToLlm,
  DEFAULT_COMPACTION_SETTINGS,
  type AgentMessage,
  type AgentOptions,
  type CompactionReason as PiCompactionReason,
  type CompactionSettings,
  type CustomEntry,
  type Entry,
  type MessageEntry,
} from "@earendil-works/pi-agent-core";
import {
  Agent,
  JsonlSessionRepo,
  NodeExecutionEnv,
  type ExecutionEnv,
} from "@earendil-works/pi-agent-core/node";
import {
  getSupportedThinkingLevels,
  type AssistantMessage,
  type CredentialStore,
  type Models,
  type UserMessage,
} from "@earendil-works/pi-ai";
import {
  COMPACTION_REASONS,
  COST_BASES,
  DEFAULT_COMPACTION_POLICY,
  errorMessage,
  isActivityKind,
  NOOP_OBSERVABILITY_SINK,
  ObservabilityReducer,
  SESSION_USAGE_CAUSES,
  UtilityCompletionError,
  type AgentRuntime,
  type AuthoritySnapshot,
  type CompactionObservation,
  type CompactionPolicy,
  type CompactionReason,
  type CompactionRequestOutcome,
  type DeliveryOutcome,
  type ObservabilitySink,
  type RuntimeAttachmentHandle,
  type RuntimeActivityObservation,
  type RuntimeActivityValue,
  type RuntimeFailure,
  type RuntimeImageInput,
  type SettledMessageObservation,
  type AttentionObservation,
  type RuntimeSessionIdentity,
  type SessionRuntimeSpec,
  type TurnObservation,
  type UsageObservation,
  type UtilityCompletion,
  type UtilityCompletionResult,
} from "@volli/shared";
import { authorityVerdict } from "../authority/gate";
import { composeFirstUserMessage, composeSystemPrompt } from "../prompt";
import { mapPiActivity } from "./activity";
import {
  compactionDue,
  compactSession,
  contextMessages,
  contextWindowOf,
  conversationPath,
  estimatedContextTokens,
  occupiedContextTokens,
  type CompactionOutcome,
  type ConversationReader,
} from "./compaction";
import { AuthorityEscalation } from "./escalation";
import { piExecutionEnv } from "./execution-env";
import { inspectPiModelAccess, type PiModelAccessSource } from "./model-access";
import { piOwnedModelAccess } from "./models";
import {
  instrumentStreamFn,
  recordObservationToSink,
  teeObservationsToSink,
} from "./observability";
import { OrderedObservationDelivery } from "./ordered-observation-delivery";
import { createSessionTools } from "./tools";
import {
  assistantUsage,
  attentionReasonFor,
  classifyAssistantMessage,
  isTransientTransportFailure,
  recoveryRefFor,
  sanitizeDiagnostic,
  sessionUsageFrom,
} from "./transcript";

/**
 * How hard a dropped socket is chased before the failure becomes the user's.
 *
 * Behavioral, not durable: nothing derived from these numbers is written to
 * history, so retuning them changes only how long recovery takes and how many
 * attempts the exhaustion message names.
 */
const AUTO_RETRY_LIMIT = 10;
const AUTO_RETRY_BASE_MS = 500;
const AUTO_RETRY_CEILING_MS = 8_000;
const AUTO_RETRY_JITTER_MS = 100;

/** Exponential backoff to a ceiling, jittered so ten Sessions do not reconnect in lockstep. */
export function autoRetryDelayMs(attempt: number): number {
  const backoff = Math.min(AUTO_RETRY_BASE_MS * 2 ** attempt, AUTO_RETRY_CEILING_MS);
  return backoff + Math.random() * AUTO_RETRY_JITTER_MS;
}

/**
 * Volli's compaction vocabulary, checked against the executor's own.
 *
 * `@volli/shared` depends on nothing and so spells Pi's `CompactionReason` out
 * rather than importing it; this is the one file that can see both, and the
 * `satisfies` is what makes a word Volli uses that Pi does not a compile error
 * rather than a divergence nobody notices. The list is also what validates a
 * persisted marker on recovery.
 */
const COMPACTION_REASON_VALUES = COMPACTION_REASONS satisfies readonly PiCompactionReason[];

export interface PiRuntimeHostOptions {
  /** Directory that owns every attachment's Pi JSONL recovery sidecar. */
  sessionDataDir: string;
  /**
   * The Pi model collection this host runs on.
   *
   * Injected by deterministic tests that script the provider call, and injected
   * in the product too since in-app sign-in arrived: main builds the pair with
   * {@link piOwnedModelAccess} and hands the same collection to the runtime and
   * to the login service, so a credential written by one is a credential the
   * other is already holding the store for. Omitted, this builds its own.
   */
  models?: Models;
  /**
   * The credential store behind {@link PiRuntimeHostOptions.models}, when the
   * caller has one. Only Model Access reads it, and only to ask which providers
   * this profile stored something for. A scripted `models` normally comes with
   * no store, which reads as "cannot tell" rather than as an empty profile.
   */
  credentials?: CredentialStore;
  /** Host clock for runtime observations; injectable for deterministic tests. */
  now?: () => number;
  /**
   * The filesystem and shell capability one Session's tools are given.
   *
   * Injectable so deterministic Node runtime tests can script it, and so a
   * caller that wants a narrower environment than the default can supply one —
   * `ScopedExecutionEnv` is exactly that and is still built and tested for it.
   *
   * Called with the Session's own identity beside the workspace, so a host can
   * export who is running — main maps it to `VOLLI_SESSION`/`VOLLI_TICKET` via
   * `piExecutionEnv`'s `identity` option (VC-51). The default factory sets
   * neither: only a host knows a Ticket's display id.
   */
  executionEnvFactory?: (
    workspacePath: string,
    identity: RuntimeSessionIdentity,
  ) => Promise<ExecutionEnv>;
  /**
   * The wait before an auto-retried attempt, by zero-based attempt number.
   * Injectable so deterministic tests need not spend the real backoff.
   */
  retryBackoffMs?: (attempt: number) => number;
  /**
   * The compaction policy every attachment is run under, read at the moment it
   * is needed rather than captured at attach.
   *
   * A callback because a Session outlives a settings change, and the next
   * compaction should happen under the policy configured now — a switch flipped
   * in Settings that only took effect on the Sessions started after it would be
   * a switch that does not work.
   *
   * Absent, this runs {@link DEFAULT_COMPACTION_POLICY}: automatic compaction
   * on, which is the behaviour of every caller that has never heard of this
   * option.
   */
  compactionPolicy?: () => CompactionPolicy;
  /**
   * Where metadata-only observability events go. A side channel, never a
   * participant: the runtime reduces its own observations and provider
   * attempts to bounded events and hands them here without awaiting, and a
   * sink that throws costs a run nothing but the lost measurement. Absent
   * means disabled — the no-op sink, not an `undefined` check per call.
   */
  observability?: ObservabilitySink;
}

/** Everything {@link attachSession} needs, with the default already chosen. */
interface PiRuntimeHost {
  sessionDataDir: string;
  models: Models;
  credentials: CredentialStore | null;
  now: () => number;
  executionEnvFactory: (
    workspacePath: string,
    identity: RuntimeSessionIdentity,
  ) => Promise<ExecutionEnv>;
  retryBackoffMs: (attempt: number) => number;
  compactionPolicy: () => CompactionPolicy;
  observability: ObservabilitySink;
}

/**
 * The collection and its store, or the pair this process owns.
 *
 * Written as one branch on `models` rather than two independent `??` defaults
 * on purpose: falling back per field would build a real {@link
 * PiFileCredentialStore} — pointed at the developer's own `auth.json` — the
 * moment a test scripted a collection without one, and a unit test that reads a
 * person's credentials is a unit test that has already gone wrong.
 */
function resolveModelAccess(options: PiRuntimeHostOptions): PiModelAccessSource {
  const models = options.models;
  if (models === undefined) return piOwnedModelAccess();
  return { models, credentials: options.credentials ?? null };
}

/**
 * Build the one structured executor port.
 *
 * The models are resolved once, here, rather than per attachment: the credential
 * store behind them serializes this process's writes to Pi's `auth.json`, and a
 * fresh store per attach would serialize nothing.
 */
export function createPiAgentRuntime(options: PiRuntimeHostOptions): AgentRuntime {
  const access = resolveModelAccess(options);
  const host: PiRuntimeHost = {
    sessionDataDir: options.sessionDataDir,
    models: access.models,
    credentials: access.credentials,
    now: options.now ?? Date.now,
    // Wrapped rather than passed by reference: `piExecutionEnv`'s second
    // parameter is its options bag, and handing it the identity positionally
    // would silently misread it.
    executionEnvFactory:
      options.executionEnvFactory ?? ((workspacePath) => piExecutionEnv(workspacePath)),
    retryBackoffMs: options.retryBackoffMs ?? autoRetryDelayMs,
    compactionPolicy: options.compactionPolicy ?? (() => DEFAULT_COMPACTION_POLICY),
    observability: options.observability ?? NOOP_OBSERVABILITY_SINK,
  };
  return {
    inspectModelAccess: (input) =>
      inspectPiModelAccess({ models: host.models, credentials: host.credentials }, host.now, input),
    startSession: (spec) => attachSession(host, spec),
    completeUtility: (input) => runUtilityCompletion(host, input),
  };
}

/**
 * One utility completion on an explicit model, read back as text and a bill.
 *
 * The executor half of the port — the caller resolved and validated the
 * model; this runs it and refuses rather than substitutes. A model this
 * collection does not hold throws, a failed stop reason throws, and an
 * answer with no text throws: the caller keeps its heuristic title and logs,
 * which is the whole of the contract on this side.
 *
 * The usage travels back with the text because nothing else here will carry
 * it. A utility call creates no Session, no attachment and no transcript row,
 * so a runtime that reported only the text would make this the one kind of
 * model spend a Session could never account for.
 */
async function runUtilityCompletion(
  host: PiRuntimeHost,
  input: UtilityCompletion,
): Promise<UtilityCompletionResult> {
  const model = host.models.getModel(input.model.providerId, input.model.modelId);
  if (model === undefined) {
    // Nothing was sent, so nothing was billed. Null rather than an empty
    // measurement: the difference between "no request was made" and "a request
    // was made and cost nothing" is the whole discipline of this module.
    throw new UtilityCompletionError(
      `Model ${input.model.providerId}/${input.model.modelId} is not in this runtime's catalog.`,
      null,
    );
  }
  const message = await host.models.completeSimple(
    model,
    { systemPrompt: input.systemPrompt, messages: [queuedUserMessage(input.user)] },
    {
      // The same translation Pi's own agent makes for a Session at "off"
      // (agent.js: thinkingLevel === "off" → reasoning omitted): SimpleStreamOptions
      // has no "off" value, and omitting the option IS the off-path, not a
      // default-level request. Every other level passes through verbatim.
      ...(input.model.reasoningLevel === "off" ? {} : { reasoning: input.model.reasoningLevel }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
  );
  // Read BEFORE either refusal below. The provider billed for the prompt it
  // accepted, not for whether Volli could use the answer — so a reply that
  // stopped short and a reply that was all reasoning are both real spend, and
  // extracting usage after the throw would lose exactly the calls a caller can
  // least afford to be silently charged for.
  const usage = sessionUsageFrom(
    message.usage,
    { provider: message.provider, model: message.model, api: message.api },
    "utility",
  );
  if (hasFailedStopReason(message)) {
    throw new UtilityCompletionError(
      sanitizeDiagnostic(message.errorMessage ?? "The utility completion failed."),
      usage,
    );
  }
  // Agent message tokens only. `thinking` blocks are dropped here rather than
  // filtered downstream, because a caller that runs a model at a reasoning
  // level it did not want (titling does, on every model that cannot be turned
  // off) must never see the thinking at all — a reasoning span is not an
  // answer, and the shape of one varies per provider.
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    // A model that answered only with a reasoning span still ran. The caller
    // keeps its fallback and still owes the bill.
    throw new UtilityCompletionError("The utility completion returned no text.", usage);
  }
  return { text: trimmed, usage };
}

/** Pi messages are persisted as JSON; omit optional properties Pi represents as undefined. */
function durableMessage(message: AgentMessage): AgentMessage {
  return JSON.parse(JSON.stringify(message)) as AgentMessage;
}

/**
 * The user message Pi is handed.
 *
 * Plain text stays a plain string rather than a one-element block array: that
 * is the shape every existing Session's sidecar already holds, and Pi's own
 * `contentText` treats the two identically, so widening only when there is
 * genuinely an image to carry keeps existing transcripts byte-identical.
 *
 * Images ride alongside the text as `ImageContent`, which is the only form a
 * model can actually look at (VC-50). They persist into Pi's recovery sidecar
 * with the message, which is exactly why attaching is bounded by a per-image
 * ceiling AND a per-session budget upstream — see `docs/plans/attachments.md`.
 *
 * The shapes below are read back by {@link isPersistedUserContent}, which has
 * to recognize every one of them: the two functions are one decision written
 * twice, and the first time they disagreed every later branch read threw
 * (VC-155). Change one, change the other — `persistObservation`'s assert is
 * what catches you if you don't, at the write rather than a month later.
 */
function queuedUserMessage(text: string, images: readonly RuntimeImageInput[] = []): UserMessage {
  if (images.length === 0) {
    return { role: "user", content: text, timestamp: Date.now() };
  }
  return {
    role: "user",
    content: [
      { type: "text", text },
      ...images.map((image) => ({
        type: "image" as const,
        data: image.data,
        mimeType: image.mimeType,
      })),
    ],
    timestamp: Date.now(),
  };
}

const FAILED_ASSISTANT_STOP_REASONS = [
  "aborted",
  "error",
  "deferred",
] as const satisfies readonly AssistantMessage["stopReason"][];

function hasFailedStopReason(message: AssistantMessage): boolean {
  return FAILED_ASSISTANT_STOP_REASONS.some((reason) => reason === message.stopReason);
}

function recoverableMessage(entry: MessageEntry): boolean {
  const message = entry.message;
  if (message.role !== "assistant") return true;
  return !hasFailedStopReason(message as AssistantMessage);
}

const VOLLI_OBSERVATION_MARKER = "volli.observation.v1";

/**
 * The observations a restart can be told about again.
 *
 * {@link CompactionObservation} joins them, and the case for it is not that the
 * runtime would forget: the compaction entry is already durable in the sidecar,
 * and the elision rule reads it back whether or not a marker exists. It is that
 * the *Session Event* is derived from observations and from nothing else. A
 * compaction seen only live is a ledger that goes quiet exactly where its
 * transcript stops — history that ends mid-conversation with nothing saying
 * why, which is the hole this marker fills.
 */
type RecoverableObservation =
  | TurnObservation
  | CompactionObservation
  | SettledMessageObservation
  | UsageObservation
  | RuntimeActivityObservation
  | AttentionObservation;

interface AcceptedMessageCommandMarker {
  kind: "command-accepted";
  commandId: string;
  operation: "message.submit";
  delivery: "prompt" | "queue" | "steer";
  turnId: string;
  message: UserMessage;
}

interface AcceptedRetryCommandMarker {
  kind: "command-accepted";
  commandId: string;
  operation: "executor.retry";
  delivery: "retry";
  turnId: string;
}

type AcceptedCommandMarker = AcceptedMessageCommandMarker | AcceptedRetryCommandMarker;

type RecoverableMarker = RecoverableObservation | AcceptedCommandMarker;

/**
 * One marker read back, or nothing when there is nothing here to read.
 *
 * Nothing covers two cases on purpose, and the second is the whole point.
 * A custom entry somebody else wrote is not ours; and a marker of OURS that no
 * longer validates is quarantined — skipped, not thrown on.
 *
 * **Why an unreadable marker must not be fatal.** This function runs over every
 * custom entry on the branch, and the branch is re-read at the head of every
 * single message ({@link compactBeforeTurn}). So a throw here is not one bad
 * read: it is a Session that reports a failed threshold compaction after every
 * message its user sends, never compacts again, and can never be reopened —
 * permanently, because the marker is durable. That is the VC-155 failure, and
 * enumerating the shapes that caused it fixes those instances while leaving the
 * mechanism: the NEXT writer bug mints another class of bricked Session.
 * Quarantine fixes the mechanism. What it costs is one ledger fact — an
 * activity that will not be replayed into the transcript, an attention state
 * not restored — against a Session that works.
 *
 * **Except a command marker, which stays fatal.** Dropping one does not cost a
 * fact about what the Session showed; it changes what the Session DID. An
 * accepted `message.submit` that recovery cannot see is a message never
 * delivered as far as the conversation is concerned and an unreceipted command
 * as far as `reconcile` is concerned, so the caller sends it again — a
 * duplicate turn nobody asked for, from a Session that looks healthy. Losing
 * that quietly is worse than refusing to open, so it is refused. A marker too
 * corrupt to name its own kind cannot be proven to be one of these, and is
 * quarantined with the rest rather than bricking a Session on the input we
 * understand least.
 *
 * Skips are counted and surfaced by the caller — see `unreadableMarkerCount`.
 */
function recoveredObservation(
  entry: CustomEntry,
): (RecoverableMarker & { occurredAt: number; recoveryCursor: string }) | null {
  if (entry.customType !== VOLLI_OBSERVATION_MARKER) return null;
  const data = entry.data;
  if (!isRecoverableObservation(data)) {
    if (isRecord(data) && data["kind"] === "command-accepted") {
      throw new Error("Pi recovery marker is malformed.");
    }
    return null;
  }
  return {
    ...(data as unknown as RecoverableMarker),
    occurredAt: entry.timestamp,
    recoveryCursor: entry.id,
  };
}

function isRecoverableObservation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value["kind"]) {
    case "turn":
      return (
        isOneOf(value["state"], ["started", "completed", "interrupted"]) &&
        typeof value["turnId"] === "string"
      );
    case "message-settled":
      return typeof value["turnId"] === "string" && isSettledMessage(value["message"]);
    case "usage":
      return (
        typeof value["entryId"] === "string" &&
        (value["turnId"] === null || typeof value["turnId"] === "string") &&
        isSessionUsage(value["usage"])
      );
    case "compaction":
      if (!isOneOf(value["reason"], COMPACTION_REASON_VALUES)) return false;
      // Whole numbers, because the durable ledger reads them as integers and a
      // marker this accepted but the ledger refused would be a Session that
      // recovers and then cannot be read.
      return value["state"] === "compacted"
        ? typeof value["entryId"] === "string" &&
            wholeNumber(value["tokensBefore"]) &&
            wholeNumber(value["tokensAfter"])
        : value["state"] === "failed" && typeof value["message"] === "string";
    case "activity":
      return (
        typeof value["turnId"] === "string" &&
        typeof value["activityId"] === "string" &&
        isOneOf(value["state"], ["completed", "failed"]) &&
        isActivityDescriptor(value["descriptor"]) &&
        isRuntimeValue(value["input"]) &&
        isRuntimeValue(value["output"]) &&
        (value["error"] === undefined || typeof value["error"] === "string")
      );
    case "attention":
      return (
        isOneOf(value["state"], ["raised", "cleared"]) &&
        isOneOf(value["reason"], [
          "auth",
          "configuration",
          "context",
          "runtime-failure",
          "partial-turn",
        ]) &&
        typeof value["message"] === "string"
      );
    case "command-accepted":
      if (typeof value["commandId"] !== "string" || typeof value["turnId"] !== "string") {
        return false;
      }
      if (value["operation"] === "executor.retry") {
        return value["delivery"] === "retry" && value["message"] === undefined;
      }
      return (
        value["operation"] === "message.submit" &&
        isOneOf(value["delivery"], ["prompt", "queue", "steer"]) &&
        isPersistedUserMessage(value["message"])
      );
    default:
      return false;
  }
}

/**
 * The durable usage shape, checked with the ledger's own strictness.
 *
 * Whole token counts and a finite cost, because the Session Event codec reads
 * them that way: a marker this accepted and the ledger refused would be a
 * Session that recovers and then cannot be read — the VC-155 shape, re-laid
 * one field at a time. `null` is accepted everywhere a number is, and only
 * `null`: absent is what an unmetered field honestly says, and `undefined`
 * would not survive the JSON round trip this validator guards.
 */
function isSessionUsage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const tokens = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
  return (
    isOneOf(value["cause"], SESSION_USAGE_CAUSES) &&
    typeof value["providerId"] === "string" &&
    typeof value["modelId"] === "string" &&
    tokens.every((key) => value[key] === null || wholeNumber(value[key])) &&
    (value["costUsd"] === null ||
      (typeof value["costUsd"] === "number" && Number.isFinite(value["costUsd"]))) &&
    isOneOf(value["costBasis"], COST_BASES)
  );
}

function isPersistedUserMessage(value: unknown): value is UserMessage {
  return (
    isRecord(value) &&
    value["role"] === "user" &&
    isPersistedUserContent(value["content"]) &&
    typeof value["timestamp"] === "number" &&
    Number.isFinite(value["timestamp"])
  );
}

/**
 * Both shapes {@link queuedUserMessage} writes: the plain string every
 * text-only message persists as, and the block array an attached image widens
 * it to (VC-50). The array arm accepts exactly the two block types that
 * function produces — this validator's job is to recognize the runtime's own
 * writes, and the first shape it refused (an image message) poisoned every
 * later branch read with "Pi recovery marker is malformed" (VC-155).
 */
function isPersistedUserContent(value: unknown): value is UserMessage["content"] {
  if (typeof value === "string") return true;
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((block: unknown) => {
    if (!isRecord(block)) return false;
    if (block["type"] === "text") return typeof block["text"] === "string";
    if (block["type"] === "image") {
      return typeof block["data"] === "string" && typeof block["mimeType"] === "string";
    }
    return false;
  });
}

function assertUniqueAcceptedCommands(markers: readonly RecoverableMarker[]): void {
  const commands = new Set<string>();
  const turns = new Set<string>();
  for (const marker of markers) {
    if (marker.kind !== "command-accepted") continue;
    if (commands.has(marker.commandId) || turns.has(marker.turnId)) {
      throw new Error("Pi recovery delivery markers conflict.");
    }
    commands.add(marker.commandId);
    turns.add(marker.turnId);
  }
}

function isSettledMessage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    typeof value["entryId"] !== "string" ||
    value["role"] !== "assistant" ||
    typeof value["text"] !== "string" ||
    (value["reasoning"] !== undefined && typeof value["reasoning"] !== "string")
  ) {
    return false;
  }
  const model = value["model"];
  if (
    model !== undefined &&
    (!isRecord(model) ||
      typeof model["providerId"] !== "string" ||
      typeof model["modelId"] !== "string")
  ) {
    return false;
  }
  const usage = value["usage"];
  return (
    usage === undefined ||
    (isRecord(usage) &&
      optionalFiniteNumber(usage["inputTokens"]) &&
      optionalFiniteNumber(usage["outputTokens"]) &&
      // Optional twice over: newly written markers carry the cache split, and
      // markers persisted before it existed simply do not — both recover.
      optionalFiniteNumber(usage["cacheReadTokens"]) &&
      optionalFiniteNumber(usage["cacheWriteTokens"]) &&
      optionalFiniteNumber(usage["costUsd"]))
  );
}

function isActivityDescriptor(value: unknown): boolean {
  if (!isRecord(value) || !isActivityKind(value["kind"])) return false;
  if (typeof value["nativeToolName"] !== "string" || !isRecord(value["subject"])) return false;
  const subject = value["subject"];
  if (!nullableString(subject["label"]) || !nullableString(subject["path"])) return false;
  const lineRange = subject["lineRange"];
  if (
    lineRange !== null &&
    (!isRecord(lineRange) ||
      !Number.isInteger(lineRange["start"]) ||
      !Number.isInteger(lineRange["end"]))
  ) {
    return false;
  }
  const outcome = value["outcome"];
  if (outcome !== null) {
    if (!isRecord(outcome)) return false;
    for (const key of [
      "exitCode",
      "matchCount",
      "fileCount",
      "lineCount",
      "bytes",
      "addedLines",
      "removedLines",
    ]) {
      if (!nullableFiniteNumber(outcome[key])) return false;
    }
    if (!nullableString(outcome["diff"]) || !nullableString(outcome["summary"])) return false;
  }
  return nullableFiniteNumber(value["startedAt"]) && nullableFiniteNumber(value["endedAt"]);
}

function isRuntimeValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  // JSONL parsing cannot produce NaN or infinities; retain the check for callers
  // constructing an in-memory entry through a future repository implementation.
  /* v8 ignore next */
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isRuntimeValue);
  return isRecord(value) && Object.values(value).every(isRuntimeValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOneOf<const T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function nullableFiniteNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function wholeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value);
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

async function assertOwnedRecoveryPath(root: string, candidate: string): Promise<void> {
  const [ownedRoot, ownedCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  const pathFromRoot = relative(ownedRoot, ownedCandidate);
  if (pathFromRoot === "" || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error("Pi recovery sidecar is outside the runtime-owned session directory.");
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function rejectUnavailableModel(
  spec: SessionRuntimeSpec,
  observe: SessionRuntimeSpec["observer"],
): Promise<never> {
  const message = `Model ${spec.model.providerId}/${spec.model.modelId} is not available.`;
  await observe({
    kind: "attachment",
    state: "failed",
    failure: { reason: "configuration", message },
  });
  throw new Error(message);
}

async function rejectCancelledAttachment(observe: SessionRuntimeSpec["observer"]): Promise<never> {
  const message = "Runtime attachment was cancelled before it started.";
  await observe({
    kind: "attachment",
    state: "failed",
    failure: { reason: "aborted", message },
  });
  throw new Error(message);
}

async function attachSession(
  host: PiRuntimeHost,
  spec: SessionRuntimeSpec,
): Promise<RuntimeAttachmentHandle> {
  // The side channel exists before the first observation can, so even an
  // attachment refused at the door reports its bounded failure through the
  // tee. The run id is opaque and process-local on purpose — correlation
  // without exporting Session identity.
  const runId = randomUUID();
  const observabilityReducer = new ObservabilityReducer(host.now);
  const observe = teeObservationsToSink(
    spec.observer,
    observabilityReducer,
    host.observability,
    runId,
  );
  // A permitted authority decision is a metrics denominator, not durable
  // Session history. It therefore goes through the reducer's passive path and
  // never awaits the Session observer or changes whether Pi can run the call.
  const recordObservability = (observation: Parameters<SessionRuntimeSpec["observer"]>[0]) =>
    recordObservationToSink(observabilityReducer, host.observability, runId, observation);
  if (isAborted(spec.signal)) {
    return rejectCancelledAttachment(observe);
  }

  const models = host.models;
  const model = models.getModel(spec.model.providerId, spec.model.modelId);
  if (model === undefined) {
    return rejectUnavailableModel(spec, observe);
  }

  const sidecarEnv = new NodeExecutionEnv({ cwd: host.sessionDataDir });
  let sidecarPath: string | undefined;
  let toolEnv: ExecutionEnv | undefined;
  let unsubscribe: (() => void) | undefined;
  let abortListener: (() => void) | undefined;
  let createdSidecar = false;

  try {
    const sidecars = new JsonlSessionRepo({ fs: sidecarEnv, sessionsRoot: host.sessionDataDir });
    const expectedMetadata = {
      volliSessionId: spec.identity.sessionId,
      volliThreadId: spec.identity.rootThreadId,
      volliAttachmentId: spec.identity.attachmentId,
    };
    const inputRecovery = spec.recovery;
    const sidecar =
      inputRecovery === undefined
        ? await sidecars.create({ cwd: spec.workspacePath, metadata: expectedMetadata })
        : await (async () => {
            const candidates = (await sidecars.list({ cwd: spec.workspacePath })).filter(
              (candidate) => candidate.id === inputRecovery.sessionId,
            );
            if (candidates.length !== 1) {
              throw new Error("Pi recovery sidecar was not found uniquely for this workspace.");
            }
            const candidate = candidates[0]!;
            if (resolve(candidate.path) !== resolve(inputRecovery.sessionFilePath)) {
              throw new Error("Pi recovery sidecar path does not match the owned session.");
            }
            await assertOwnedRecoveryPath(host.sessionDataDir, candidate.path);
            if (
              candidate.metadata?.["volliSessionId"] !== expectedMetadata.volliSessionId ||
              candidate.metadata?.["volliThreadId"] !== expectedMetadata.volliThreadId ||
              candidate.metadata?.["volliAttachmentId"] !== expectedMetadata.volliAttachmentId
            ) {
              throw new Error("Pi recovery sidecar identity does not match this attachment.");
            }
            return sidecars.open(candidate);
          })();
    createdSidecar = inputRecovery === undefined;
    const sidecarMetadata = await sidecar.getMetadata();
    sidecarPath = sidecarMetadata.path;
    const recovery = recoveryRefFor(sidecarMetadata.id, sidecarPath);
    // The BRANCH, not the file. Today these are the same entries — this runtime
    // writes one lane and never forks — but they stop being the same the moment
    // anything does, and what reads this now is the elision rule, which takes
    // the LAST compaction in the array it is handed. Off a flat file read that
    // is last-written; only off the branch is it last-on-this-path. Asking the
    // same question the live path asks (`conversationBranch`) is what keeps a
    // future sibling branch from quietly resurrecting elided history — the one
    // failure this ticket exists to prevent.
    const recoveredEntries = inputRecovery
      ? await sidecar.findEntriesOnBranch({ order: "oldestFirst" })
      : [];
    const customEntries = recoveredEntries.filter(
      (entry): entry is CustomEntry => entry.type === "custom",
    );
    const recoveredMarkers = customEntries
      .map(recoveredObservation)
      .filter(
        (observation): observation is NonNullable<ReturnType<typeof recoveredObservation>> =>
          observation !== null,
      );
    /**
     * Markers of ours that {@link recoveredObservation} quarantined.
     *
     * Counted here rather than plumbed out of the reader, because the reader is
     * the sync hot path every branch read runs through and has nowhere to
     * report to. Every entry of our own custom type that did not come back as a
     * marker was skipped, which is the same arithmetic without the plumbing.
     */
    const unreadableMarkerCount =
      customEntries.filter((entry) => entry.customType === VOLLI_OBSERVATION_MARKER).length -
      recoveredMarkers.length;
    const recoveredObservations = recoveredMarkers.filter(
      (
        marker,
      ): marker is RecoverableObservation & {
        occurredAt: number;
        recoveryCursor: string;
      } => marker.kind !== "command-accepted",
    );
    assertUniqueAcceptedCommands(recoveredMarkers);
    const messageMarkerCounts = new Map<string, number>();
    for (const observation of recoveredObservations) {
      if (observation.kind !== "message-settled") continue;
      messageMarkerCounts.set(
        observation.message.entryId,
        (messageMarkerCounts.get(observation.message.entryId) ?? 0) + 1,
      );
    }
    const settledAssistantEntryIds = new Set(
      recoveredEntries.flatMap((entry) => {
        if (entry.type !== "message" || entry.message.role !== "assistant") return [];
        return classifyAssistantMessage(entry.id, entry.message as AssistantMessage).kind ===
          "settled"
          ? [entry.id]
          : [];
      }),
    );
    const disagreedSettledEntryIds = new Set([
      ...[...settledAssistantEntryIds].filter((entryId) => messageMarkerCounts.get(entryId) !== 1),
      ...[...messageMarkerCounts.keys()].filter(
        (entryId) => !settledAssistantEntryIds.has(entryId),
      ),
    ]);
    /**
     * How this sidecar's entries are read back as a conversation.
     *
     * Both halves matter and neither is Pi's business: a user message accepted
     * through a durable command marker never became a message entry, and an
     * assistant reply this attachment already judged unrecoverable must not be
     * offered back to the model as if it had been said.
     */
    const conversationReader: ConversationReader = {
      acceptedMessage: (entry) => {
        const marker = recoveredObservation(entry);
        return marker !== null &&
          marker.kind === "command-accepted" &&
          marker.operation === "message.submit"
          ? marker.message
          : undefined;
      },
      replayable: (entry) => recoverableMessage(entry) && !disagreedSettledEntryIds.has(entry.id),
    };
    /**
     * The elided context, not the whole history — this is the landmine.
     *
     * Rebuilding the live message array by replaying every entry is correct only
     * for a Session that has never compacted. Once a `CompactionEntry` exists,
     * a replay that did not know about it would hand Pi the entire
     * pre-compaction history back and silently undo the compaction on the first
     * restart, with nothing anywhere saying so. {@link contextMessages} is Pi's
     * own elision rule and is the only way messages are derived here.
     */
    const recoveredMessages = contextMessages(
      conversationPath(recoveredEntries, conversationReader),
    );
    const activeAttentionReasons = new Set<AttentionObservation["reason"]>();
    const openTurnIds = new Set<string>();
    for (const observation of recoveredObservations) {
      if (observation.kind === "turn") {
        if (observation.state === "started") openTurnIds.add(observation.turnId);
        else openTurnIds.delete(observation.turnId);
      }
      if (observation.kind !== "attention") continue;
      if (observation.state === "raised") activeAttentionReasons.add(observation.reason);
      else activeAttentionReasons.delete(observation.reason);
    }
    const persistObservation = async <T extends RecoverableMarker>(observation: T): Promise<T> => {
      const durable = JSON.parse(JSON.stringify(observation)) as T;
      // Refused at the write, not discovered at the read — with the same
      // predicate recovery applies, so writer and validator cannot drift. A
      // marker recovery would reject is worthless the moment it is written
      // (VC-155).
      //
      // This is an assert, not a handled case: nothing this runtime constructs
      // can trip it, which is what `fallbackStateOf` and `usageOf` are for, and
      // it exists to catch the write that stops being true of that sentence. It
      // is not silent if it ever does fire. Pi awaits its event listeners from
      // inside `runWithLifecycle`'s executor, so a throw here is caught by
      // `handleRunFailure` and re-emitted as an errored assistant message,
      // which this runtime classifies into a `RuntimeFailure` and surfaces as a
      // failed turn carrying this sentence.
      /* v8 ignore next 3 -- an assert: no write this runtime constructs can reach it. */
      if (!isRecoverableObservation(durable)) {
        throw new Error("Pi observation marker would not survive recovery; refusing to write it.");
      }
      const markerId = await sidecar.appendCustomEntry(VOLLI_OBSERVATION_MARKER, durable);
      const marker = await sidecar.getEntry(markerId);
      /* v8 ignore next -- appendCustomEntry promises the entry it just returned. */
      if (marker?.type !== "custom") throw new Error("Pi recovery marker was not persisted.");
      return {
        ...durable,
        occurredAt: marker.timestamp,
        recoveryCursor: marker.id,
      };
    };
    if (disagreedSettledEntryIds.size > 0) {
      await persistObservation({
        kind: "attention",
        state: "raised",
        reason: "partial-turn",
        message:
          "Pi recovery history disagreed about a settled assistant message; the incomplete turn was withheld.",
      });
      activeAttentionReasons.add("partial-turn");
    }
    // Said once, at the only moment there is anything to say it about. The
    // Session is fine — that is the point of quarantining these — but a marker
    // this attachment could not read is a fact its transcript is now missing,
    // and dropping that without a word is the swallowed error this codebase
    // does not allow itself.
    if (unreadableMarkerCount > 0) {
      await persistObservation({
        kind: "attention",
        state: "raised",
        reason: "runtime-failure",
        message: `Skipped ${unreadableMarkerCount} unreadable Pi recovery ${unreadableMarkerCount === 1 ? "marker" : "markers"}; this Session's history may be missing activity or attention it once recorded.`,
      });
      activeAttentionReasons.add("runtime-failure");
    }
    for (const recoveredTurnId of openTurnIds) {
      await persistObservation({
        kind: "attention",
        state: "raised",
        reason: "partial-turn",
        message: "A recovered Pi turn ended before its completion marker was committed.",
      });
      activeAttentionReasons.add("partial-turn");
      await persistObservation({ kind: "turn", state: "interrupted", turnId: recoveredTurnId });
    }
    // No preflight before the tools are built. There is no boundary left to
    // prove: an attachment that hands Pi its own environment cannot fail for
    // want of `sandbox-exec`, and a caller who injects a contained environment
    // gets one that is fail-closed at its own `exec`.
    toolEnv = await host.executionEnvFactory(spec.workspacePath, spec.identity);
    const ownedToolEnv = toolEnv;
    // The whole Agent Tool Surface, from the one list that names it.
    //
    // Each non-coding tool is offered only to a Session with the port that
    // answers it, for the reason the gate below is built only for a Session with
    // a policy: a tool that is absent cannot be called, where one wired to
    // nothing would be called and then fail, and the model would learn that from
    // the failure. A Session handed no web boundary is handed no way to ask for
    // one — the absent port is what makes the network unreachable from here, not
    // a refusal the model would have to be told about after reaching for it. Web
    // search is independent of web fetch, not paired with it: a search discloses
    // the query to a third party and a read does not, so a Session may be given
    // either, both or neither, and is offered exactly what it was given.
    //
    // Assembled behind `sessionToolBindings` rather than pushed one by one
    // here, and the Snapshot's list is `sessionToolIds` over those same
    // bindings: the array Pi resolves against and the list the Snapshot records
    // cannot disagree, which is what let the pack drop its rule about tool
    // identity (VC-3).
    const tools = createSessionTools(spec, ownedToolEnv);
    // Composed here, once per attachment: the array is half of the Session's
    // Cache Prefix (VC-164), and a provider that orders tools ahead of the
    // system prompt throws the prompt away too when it changes. Reattachment
    // must therefore receive the same bindings, order and schemas that Session
    // start froze. Pinned off provider requests through the desktop reattach
    // seam, where a host-side recomposition would actually show up.

    let turnId = randomUUID();
    let failure: RuntimeFailure | undefined;
    let closed = false;
    let cancelled = false;
    /**
     * Whether this runtime ended the turn on purpose, cleared when the next one
     * starts.
     *
     * Tracked rather than read back off Pi, because Pi does not reliably say so.
     * `agent.abort()` makes it discard the pending tool batch and re-enter its
     * loop; the provider call that re-entry makes fails on the aborted signal,
     * and the lazy stream behind it reports that as `stopReason: "error"`
     * carrying the AbortSignal's own text rather than as an abort. Believing
     * that label raises an unrecoverable Attention, which tells someone who just
     * pressed stop that their Session broke.
     */
    let interrupting = false;
    /**
     * The transport attempts this turn has already spent, and whether the turn
     * is mid-recovery.
     *
     * The budget belongs to the turn, not to the attachment: a turn that starts
     * for its own reason — a new message, a manual Retry — gets a whole one,
     * while a turn resumed in place carries on spending the same one, so a
     * connection that will never hold cannot be chased forever.
     */
    let autoRetryAttempts = 0;
    let autoRetryPending = false;
    let resumingTurn = false;
    /**
     * Whether this turn has already spent its one compaction.
     *
     * Pi keeps a flag of this name in its own lane state for the same reason: a
     * turn that overflows, compacts, retries and overflows again has learned
     * that compacting is not what is wrong with it, and a second attempt would
     * summarize a summary and refuse again. One per turn, reset where the
     * transport budget is — a turn that starts for its own reason gets a whole
     * one, and a turn resumed in place carries on spending the same one.
     */
    let overflowRecoveryUsed = false;
    /**
     * Whether something already owns the live context, and what to wait for.
     *
     * A compaction does not extend `agent.state.messages`, it REPLACES it, so
     * it is exclusive with anything that reads or extends the same array. The
     * `isStreaming` checks around it are not enough on their own: each is a
     * check-then-act with a multi-second provider call in the middle, and a
     * turn that starts inside that gap is one the returning summary would
     * overwrite — dropping a delivered message and its reply from the context
     * while both stay on screen and in the ledger, which is the worst shape a
     * bug can have here because nothing surfaces it.
     *
     * Two halves because the two callers need different answers. A delivery
     * WAITS: refusing someone's message because maintenance is running would
     * be a worse answer than taking a moment longer to accept it. An explicit
     * compaction REFUSES, which is the answer {@link RuntimeAttachmentHandle}
     * already documents for a context that is not free — so it needs the fact
     * synchronously, before it awaits anything.
     *
     * The overflow path is deliberately outside this. It runs inside its own
     * run's `agent_end`, where `isStreaming` is still set, so every other path
     * has already been turned away by the check it does first.
     */
    let contextRewrite: Promise<void> = Promise.resolve();
    let rewritingContext = false;
    /** Set only while a backoff is being waited out; see {@link interruptTurn}. */
    let cancelBackoff: (() => void) | undefined;
    type PendingMessageDelivery = {
      commandId: string | null;
      operation: "message.submit";
      delivery: AcceptedMessageCommandMarker["delivery"];
      message: UserMessage;
    };
    type PendingRetryDelivery = {
      commandId: string | null;
      operation: "executor.retry";
      delivery: "retry";
    };
    type PendingDelivery = PendingMessageDelivery | PendingRetryDelivery;
    let pendingRunDelivery: PendingDelivery | undefined;
    const pendingQueuedDeliveries = new Map<AgentMessage, PendingMessageDelivery>();
    const acceptedUserMessages = new WeakSet<UserMessage>();
    const persistAcceptedDelivery = async (
      delivery: PendingDelivery | undefined,
      acceptedTurnId: string,
    ): Promise<boolean> => {
      if (!delivery?.commandId) return false;
      if (delivery.operation === "message.submit") {
        await persistObservation({
          kind: "command-accepted",
          commandId: delivery.commandId,
          operation: delivery.operation,
          delivery: delivery.delivery,
          turnId: acceptedTurnId,
          message: durableMessage(delivery.message) as UserMessage,
        });
      } else {
        await persistObservation({
          kind: "command-accepted",
          commandId: delivery.commandId,
          operation: delivery.operation,
          delivery: delivery.delivery,
          turnId: acceptedTurnId,
        });
      }
      return true;
    };
    const activityByToolCallId = new Map<
      string,
      { input: RuntimeActivityValue; startedAt: number }
    >();

    const observationDelivery = new OrderedObservationDelivery(observe);
    const commitObservation = (observation: Parameters<SessionRuntimeSpec["observer"]>[0]) =>
      observationDelivery.deliver(observation);

    // Assigned the statement after `new Agent` and read only from inside a Pi
    // callback, which cannot fire before a run starts. Declared here because the
    // callback would otherwise have to close over the `const` still being
    // constructed, and a definite-assignment `let` says that plainly instead of
    // resting on how a temporal dead zone happens to resolve inside a closure.
    let interruptTurn!: () => void;

    /**
     * The gate, built only for a Session that was handed a policy to enforce.
     *
     * The Snapshot is read once here rather than off the spec per call, because
     * a Snapshot is pinned for the life of the attachment by its own definition
     * — the facts its rules read stay live, the policy does not.
     */
    const gateToolCalls = (
      authority: AuthoritySnapshot,
    ): NonNullable<AgentOptions["beforeToolCall"]> => {
      const escalation = new AuthorityEscalation({
        fallback: authority.fallback,
        priorDenials: spec.priorAuthorityDenials,
        ask: spec.ask,
        signal: spec.signal,
        now: host.now,
      });
      return async ({ toolCall, args }, signal) => {
        const verdict = authorityVerdict({
          tool: toolCall.name,
          args,
          authority,
          workspacePath: spec.workspacePath,
        });
        // Pi's own per-call signal is passed on rather than dropped: a question
        // this parks on has to lose to a cancelled run, and Pi re-reads that
        // signal the instant this callback returns.
        const disposition = await escalation.resolve({
          verdict,
          tool: toolCall.name,
          toolCallId: toolCall.id,
          turnId,
          signal,
        });
        const waitDurationMs = escalation.consumeWaitDuration(toolCall.id);
        if (disposition.outcome === "allow") {
          recordObservability({
            kind: "authority",
            state: "allowed",
            turnId,
            toolCallId: toolCall.id,
            ...(waitDurationMs === undefined ? {} : { waitDurationMs }),
          });
          return undefined;
        }
        // Recorded before refused, through the same ordered queue as every other
        // observation: a refusal that overtook the turn it belongs to would be
        // filed against the wrong turn, and one that raced the activity stream
        // would print out of order. `commitObservation` resolves at the consumer
        // boundary and never rejects — a ledger that cannot be written is not a
        // reason to let the call through, and the failure it holds is consumed at
        // the next command boundary like any other.
        if (disposition.record) {
          await commitObservation({
            kind: "authority",
            state: "denied",
            turnId,
            toolCallId: toolCall.id,
            ...(waitDurationMs === undefined ? {} : { waitDurationMs }),
            tool: toolCall.name,
            cause: disposition.cause,
            reason: disposition.reason,
          });
        }
        if (disposition.interrupt) interruptTurn();
        return { block: true, reason: disposition.reason };
      };
    };

    const agent = new Agent({
      initialState: {
        systemPrompt: composeSystemPrompt({
          role: spec.identity.role,
          tools: spec.tools,
          promptResources: spec.promptResources,
        }),
        model,
        thinkingLevel: spec.model.reasoningLevel,
        tools,
        messages: recoveredMessages,
      },
      streamFn: instrumentStreamFn(models.streamSimple.bind(models), {
        sink: host.observability,
        runId,
        now: host.now,
      }),
      sessionId: sidecarMetadata.id,
      toolExecution: "sequential",
      // Pi's harness converter, not the `Agent`'s default, and the difference is
      // exactly one message role. The default keeps `user`, `assistant` and
      // `toolResult` and DROPS everything else — including the
      // `compactionSummary` message a compacted context begins with. Left on the
      // default, compaction would appear to work: history would shrink, the
      // window would clear, and the summary that was supposed to replace it
      // would never reach the model. This converter frames it as the user
      // message Pi's own harness sends. Every role Volli already produces
      // converts identically under both.
      convertToLlm,
      // `terminate` is left unset on purpose: Pi only ends the run early when
      // every finalized result in the batch asks for it, which is not what one
      // refused call means. A `stop` answer ends the turn by aborting instead,
      // which needs no agreement from the rest of the batch — at the cost of the
      // reason it carries, which Pi drops on that one path because it re-reads
      // its cancellation before it reads the block.
      //
      // The key is absent, not set to a callback that always allows: a Session
      // with no Snapshot runs Pi's own default path, and the gate, the fallback
      // thresholds and `ask` are then unreachable rather than quietly permissive.
      ...(spec.authority === undefined ? {} : { beforeToolCall: gateToolCalls(spec.authority) }),
    });
    // Interrupting, closing and cancelling the attachment all arrive here, which
    // is why one flag answers for all three downstream.
    interruptTurn = () => {
      interrupting = true;
      cancelBackoff?.();
      agent.abort();
    };
    agent.steeringMode = "one-at-a-time";
    agent.followUpMode = "one-at-a-time";

    /** A wait the turn can be taken out of, rather than one it has to sit through. */
    const waitBeforeRetry = async (ms: number): Promise<void> => {
      await new Promise<void>((wake) => {
        const timer = setTimeout(wake, ms);
        cancelBackoff = () => {
          clearTimeout(timer);
          wake();
        };
      });
      cancelBackoff = undefined;
    };

    /**
     * Run the failed attempt again without re-delivering anything the user said:
     * the assistant message Pi settled as a failure is dropped, and the run
     * continues from the user or tool-result message it answered.
     */
    const retryFailedTurn = async (commandId: string | null): Promise<DeliveryOutcome> => {
      const messages = [...agent.state.messages];
      const tail = messages.at(-1);
      if (tail?.role === "assistant" && hasFailedStopReason(tail as AssistantMessage)) {
        messages.pop();
        agent.state.messages = messages;
      } else if (tail?.role !== "user" && tail?.role !== "toolResult") {
        return {
          kind: "rejected",
          reason: "retry-unavailable",
          message: "There is no failed Pi turn to retry.",
        };
      }
      pendingRunDelivery = {
        commandId,
        operation: "executor.retry" as const,
        delivery: "retry" as const,
      };
      await agent.continue();
      return { kind: "delivered", delivery: "retry" };
    };

    /**
     * Resume a turn its own runtime recovered, from the command boundary the
     * failed run was started at.
     *
     * Not from the callback that decided to retry: Pi is still finishing that run
     * while its `agent_end` listeners are awaited, and it refuses to begin a
     * second one until they settle.
     *
     * The rejection arm of the retry cannot be reached from here. A turn lands
     * in this loop two ways and both leave a tail the retry accepts: a spent
     * transport leaves the failed assistant message it drops, and an overflow
     * recovery leaves the compacted context, which ends where the failed reply
     * began — the user message, or the tool results it was answering.
     */
    const drainAutoRetries = async (): Promise<void> => {
      while (autoRetryPending) {
        autoRetryPending = false;
        resumingTurn = true;
        await retryFailedTurn(null);
      }
    };

    /**
     * Pi polls its steering queue just before it emits `agent_end`. A command
     * can land after that poll but before its awaited `agent_end` observers
     * settle; it was accepted into Pi's queue, yet no live loop remains to
     * consume it. Once the run is truly idle, continue it until that narrow
     * closing-window queue is empty. Normal queue/steer delivery is still
     * owned by Pi's loop; this only closes the poll-to-idle gap.
     */
    const canDrainLateQueuedMessages = (): boolean =>
      !closed && !cancelled && !interrupting && failure === undefined && agent.hasQueuedMessages();

    const drainLateQueuedMessages = async (): Promise<void> => {
      while (canDrainLateQueuedMessages()) {
        await agent.continue();
        await drainAutoRetries();
      }
    };

    const settleRun = async (): Promise<void> => {
      await drainAutoRetries();
      await drainLateQueuedMessages();
    };

    /**
     * The rule this Session compacts under right now, from the policy configured
     * right now.
     *
     * Read per call for {@link summarizationModel}'s reason: a Session outlives
     * a settings change. The policy lands on Pi's own `CompactionSettings`
     * rather than beside it — the global switch IS `enabled`, which
     * `shouldCompact` reads — not a second condition wrapped around Pi's rule.
     * The reserve is always the executor's own default: per-model reserve
     * budgets were retired with the policy that carried them (VC-155).
     *
     * **What switching automatic compaction off does to the overflow path:
     * nothing.** `enabled` is read by `shouldCompact` and by nothing else in
     * 0.84.1 — `prepareCompaction` and `compact` never consult it — so the only
     * caller it reaches is {@link compactBeforeTurn}, through `compactionDue`.
     * That is the behaviour this runtime wants and it is deliberate, not
     * inherited: off means "do not interrupt me to make room", and a Session
     * whose provider has already refused the turn is not being interrupted, it
     * is being rescued from a dead end. A test pins it, so a future Pi that
     * taught `prepareCompaction` about `enabled` would fail loudly here rather
     * than quietly stop recovering overflowed Sessions.
     */
    const compactionSettings = (): CompactionSettings => ({
      ...DEFAULT_COMPACTION_SETTINGS,
      enabled: host.compactionPolicy().autoCompaction,
    });

    /** The durable branch, read as a conversation. Costs the whole history. */
    const conversationBranch = async (): Promise<Entry[]> =>
      conversationPath(
        await sidecar.findEntriesOnBranch({ order: "oldestFirst" }),
        conversationReader,
      );

    /**
     * Own the live context for the whole of `operation` — see {@link
     * contextRewrite}.
     *
     * Both halves are set before the first await and cleared after the last
     * one, so a caller that asks either question between them gets the same
     * answer. The promise swallows the failure it publishes: a waiter is
     * waiting to find the context settled, not to inherit why it is.
     */
    const rewritingTheContext = async <T>(operation: () => Promise<T>): Promise<T> => {
      rewritingContext = true;
      const running = operation();
      contextRewrite = running.then(
        () => undefined,
        () => undefined,
      );
      try {
        return await running;
      } finally {
        rewritingContext = false;
      }
    };

    /**
     * Summarize this Session's history and say so, whichever way it goes.
     *
     * One mechanism for every reason a context is compacted — the threshold,
     * the overflow, and the person who typed `/compact` — so three producers
     * cannot drift into three behaviours or three event shapes. What differs
     * between them is only when they are called and what they do with the
     * answer, which is why the answer is Pi's own outcome rather than a
     * boolean: two callers only need to know whether the context changed, and
     * the one with a person waiting on it needs to know which way it did not.
     *
     * The failure is reported rather than swallowed and reported rather than
     * raised as an Attention. Nothing is blocked by it — the message that paid
     * for the attempt is delivered on the context that was already there — but
     * the next turn may well be refused for context length, and a refusal with
     * no record of the summary that was tried first reads as arbitrary.
     */
    const compactContext = async (input: {
      reason: CompactionReason;
      path: readonly Entry[];
      signal: AbortSignal | undefined;
      /** What to keep, in the requester's words. Only a person supplies these. */
      instructions?: string;
    }): Promise<CompactionOutcome> => {
      const { reason, path, signal, instructions } = input;
      // Compaction has no turn of its own, so `working` cannot explain the
      // multi-second summary to the person waiting for it. This transient pair
      // does — without becoming recovery history that could revive a spinner
      // after the attachment that started it has gone away.
      await commitObservation({ kind: "compaction-progress", state: "started", reason });
      const finishProgress = () =>
        commitObservation({ kind: "compaction-progress", state: "finished", reason });
      try {
        const outcome = await compactSession({
          sidecar,
          path,
          models,
          // Compaction is part of this chat's continuity, so its summary is
          // generated by the model currently selected in the chat pane.
          model: agent.state.model,
          settings: compactionSettings(),
          ...(signal === undefined ? {} : { signal }),
          ...(instructions === undefined ? {} : { customInstructions: instructions }),
        });
        // Pi found nothing to compact — an empty history, or one already ending
        // in a summary. Nothing happened, so nothing is reported: the caller
        // that needed this to work is the one that has something to say about
        // it. The live marker still has to leave, because it has no durable
        // outcome that can dismiss it.
        if (outcome.kind === "skipped") {
          await finishProgress();
          return outcome;
        }
        if (outcome.kind === "compacted") {
          // The elided context, from the same rule the replay path applies.
          //
          // Replacing this array is safe only because every caller has made it
          // so, and none of them by the `isStreaming` check alone: that check is
          // separated from this line by a provider call, and what it answered
          // before is not what it would answer now. The threshold path holds
          // {@link contextRewrite} across both, the manual path holds it and
          // refuses rather than waits, and the overflow path runs inside its own
          // run's `agent_end`, where every other caller has already been turned
          // away. Take that away and a turn started mid-summary is one this line
          // overwrites — its message and its reply gone from the model's context
          // while both remain in the ledger and on screen.
          agent.state.messages = outcome.messages;
        }
        // Recorded before the compaction fact, so a crash between the two
        // loses the summary rather than the bill: the summary is recoverable
        // from Pi's own entry, and spend that went unrecorded is not.
        if (outcome.kind === "compacted" && outcome.usage !== null) {
          await commitObservation(
            await persistObservation({
              kind: "usage",
              // Named after the compaction entry, which is what makes a
              // replayed compaction land on the bill it already has.
              entryId: outcome.entry.id,
              // Compaction has no turn of its own. Inventing one here would
              // put maintenance spend inside a conversation unit it is not in.
              turnId: null,
              usage: outcome.usage,
            }),
          );
        }
        await commitObservation(
          await persistObservation(
            outcome.kind === "compacted"
              ? {
                  kind: "compaction",
                  state: "compacted",
                  reason,
                  entryId: outcome.entry.id,
                  // Floored where a provider's arithmetic becomes a durable
                  // count, for the reason a context window is: the ledger holds
                  // whole tokens, and a fractional one would recover and then
                  // fail to decode.
                  tokensBefore: Math.floor(outcome.entry.tokensBefore),
                  tokensAfter: estimatedContextTokens(outcome.messages),
                }
              : { kind: "compaction", state: "failed", reason, message: outcome.message },
          ),
        );
        // A compacted or failed observation is the durable terminal fact. The
        // Session runtime removes the transient marker as it records that fact,
        // so sending a second finish signal would race the boundary it draws.
        return outcome;
      } catch (error) {
        // Reachable only above that commit — once the durable outcome lands
        // nothing else here can throw — so the marker is always still open and
        // needs an explicit finish before the failure propagates.
        await finishProgress();
        throw error;
      }
    };

    /**
     * Make room for the turn that is about to start, if the last reply says the
     * window is nearly spent.
     *
     * **Why here, and not when the previous turn ended.** The measurement is the
     * same either way — it is the last reply's usage in both cases — but the
     * multi-second freeze is not. Compacting at the end of a turn spends it
     * after the transcript has already gone idle, which reads as an application
     * that has stopped responding. Compacting at the head of the next message
     * spends it inside a wait the person is already watching, where it is
     * indistinguishable from a slow model. That is the whole reason compaction
     * emits no turn of its own: the freeze it would need a spinner for is
     * already inside one.
     *
     * Only the idle prompt path reaches this. A queued or steering message joins
     * a run Pi is already streaming, where the context is fixed and rewriting it
     * underneath would corrupt the turn in flight — which is also why this
     * cannot be the only compaction there is, and why a run that spends the
     * window on its own tool traffic is {@link recoverFromFailure}'s to catch.
     *
     * A failed compaction changes nothing and stops nothing. The user's
     * message still goes to the model on the context that was already there:
     * this is maintenance, and refusing to deliver a message because maintenance
     * failed would turn a recoverable Session into a stuck one.
     *
     * That holds for every way it can fail, not just the summary call. A
     * provider that refuses to summarize is already reported as an outcome, but
     * the reads and the append around it can throw, and an exception here would
     * reach the caller as a REFUSED MESSAGE — the one thing this path promises
     * never to do, failing in the way a person would least connect to the cause.
     * So the throw is turned into the failure this already knows how to say.
     * Nothing is swallowed: it lands on the ledger as `context.compaction_failed`
     * and draws its own line in the transcript, exactly as a refused summary
     * does.
     */
    const compactBeforeTurn = async (): Promise<void> => {
      // Asked first because it is free. A model whose catalog reports no usable
      // window can never trip the threshold, and the branch read below costs the
      // whole history — there is no reason to pay it for an answer already known.
      const contextWindow = contextWindowOf(agent.state.model);
      if (contextWindow === undefined) return;
      try {
        const path = await conversationBranch();
        if (!compactionDue(occupiedContextTokens(path), contextWindow, compactionSettings()))
          return;
        // The attachment's own lifetime bounds it, like every other provider
        // call here. Nothing else can: no turn has started, so there is no turn
        // to interrupt, and a person pressing stop before their message has been
        // delivered is stopping something that has not begun.
        await compactContext({ reason: "threshold", path, signal: spec.signal });
      } catch (error) {
        // Reported through the channel a refused summary already uses. If THIS
        // throws the sidecar itself is unwritable, which is not a maintenance
        // failure to absorb — it is the attachment's own durability gone, and it
        // belongs to the caller that can still say so.
        await commitObservation(
          await persistObservation({
            kind: "compaction",
            state: "failed",
            reason: "threshold",
            message: sanitizeDiagnostic(errorMessage(error)),
          }),
        );
      }
    };

    /**
     * What this runtime can still do about a failed turn without asking anybody.
     *
     * Two recoveries, one shape: both spend something the turn is allowed to
     * spend once, both keep the turn open while they do it, and both hand back
     * the same answer — that the run may be resumed in place. Everything else is
     * the user's to decide, and says so by returning false.
     *
     * **Overflow is where a long run's context is answered.** Compaction at the
     * head of a message cannot help a turn that fills the window with its own
     * tool results, because by then the turn is streaming and rewriting its
     * context would corrupt it. So the provider's refusal is the trigger: it is
     * the only honest signal that arrives at a moment when rewriting the context
     * is safe again, which is exactly now — the loop has ended, and nothing will
     * read the message array until the retry does.
     *
     * The retry continues from what the compacted context ends with, and that is
     * not a coincidence to leave unstated: the reply that failed is dropped from
     * the durable path as unreplayable, and Pi never cuts a context in front of
     * a tool result, so what remains is the user message or the tool results the
     * failed reply was answering — which is what `continue` requires.
     */
    const recoverFromFailure = async (
      failed: RuntimeFailure,
      signal: AbortSignal,
    ): Promise<boolean> => {
      if (isTransientTransportFailure(failed) && autoRetryAttempts < AUTO_RETRY_LIMIT) {
        autoRetryAttempts += 1;
        await waitBeforeRetry(host.retryBackoffMs(autoRetryAttempts - 1));
        return true;
      }
      if (failed.reason !== "context" || overflowRecoveryUsed) return false;
      overflowRecoveryUsed = true;
      // The run's own signal, not the attachment's: a person pressing stop
      // during the summary is stopping this turn, and the summary is now the
      // only part of it still running.
      const outcome = await compactContext({
        reason: "overflow",
        path: await conversationBranch(),
        signal,
      });
      return outcome.kind === "compacted";
    };

    unsubscribe = agent.subscribe(async (event, runSignal) => {
      if (event.type === "agent_start") {
        // A resumed attempt is the same turn continuing, so it neither starts one
        // nor refreshes the budget it is spending.
        const resumed = resumingTurn;
        resumingTurn = false;
        failure = undefined;
        interrupting = false;
        activityByToolCallId.clear();
        if (!resumed) {
          turnId = randomUUID();
          autoRetryAttempts = 0;
          overflowRecoveryUsed = false;
          await commitObservation(
            await persistObservation({ kind: "turn", state: "started", turnId }),
          );
        }
        const delivery = pendingRunDelivery;
        pendingRunDelivery = undefined;
        if (await persistAcceptedDelivery(delivery, turnId)) {
          if (delivery?.operation === "message.submit") {
            acceptedUserMessages.add(delivery.message);
          }
        }
        return;
      }

      if (
        event.type === "tool_execution_start" ||
        event.type === "tool_execution_update" ||
        event.type === "tool_execution_end"
      ) {
        const observedAt = host.now();
        const retained = activityByToolCallId.get(event.toolCallId);
        const startedAt = retained?.startedAt ?? observedAt;
        const activity = mapPiActivity(
          event,
          event.type === "tool_execution_end"
            ? { turnId, input: retained?.input, startedAt: retained?.startedAt, observedAt }
            : event.type === "tool_execution_start"
              ? { turnId, observedAt }
              : { turnId, startedAt, observedAt },
        );

        if (event.type !== "tool_execution_end") {
          activityByToolCallId.set(event.toolCallId, { input: activity.input, startedAt });
          await commitObservation(activity);
          return;
        }

        try {
          await commitObservation(await persistObservation(activity));
        } finally {
          activityByToolCallId.delete(event.toolCallId);
        }
        return;
      }

      if (event.type === "message_update") {
        const streamed = event.assistantMessageEvent;
        if (streamed.type === "text_delta") {
          await commitObservation({ kind: "delta", turnId, channel: "text", text: streamed.delta });
        }
        if (streamed.type === "thinking_delta") {
          await commitObservation({
            kind: "delta",
            turnId,
            channel: "reasoning",
            text: streamed.delta,
          });
        }
        return;
      }

      if (event.type === "message_end") {
        if (event.message.role === "user") {
          const delivery = pendingQueuedDeliveries.get(event.message);
          if (delivery !== undefined) {
            pendingQueuedDeliveries.delete(event.message);
            if (await persistAcceptedDelivery(delivery, randomUUID())) {
              acceptedUserMessages.add(event.message);
            }
          }
        }
        const acceptedUserMessage =
          event.message.role === "user" && acceptedUserMessages.has(event.message);
        const entryId = acceptedUserMessage
          ? null
          : await sidecar.appendMessage(durableMessage(event.message));
        if (event.message.role !== "assistant") {
          return;
        }
        /* v8 ignore next -- acceptedUserMessages only contains user messages. */
        if (entryId === null) throw new Error("Pi assistant message was not persisted.");
        // Metering happens BEFORE classification, and that ordering is the
        // whole point. Classification asks whether the message said anything;
        // most agentic spend answers no — a reply that only called tools, a
        // reply that failed after its prompt was billed — and usage read off
        // the settled arm alone would report a fraction of the bill.
        const metered = assistantUsage(event.message as AssistantMessage);
        if (metered !== null) {
          await commitObservation(
            await persistObservation({ kind: "usage", entryId, turnId, usage: metered }),
          );
        }
        const outcome = classifyAssistantMessage(entryId, event.message as AssistantMessage);
        if (outcome.kind === "settled") {
          await commitObservation(
            await persistObservation({ kind: "message-settled", turnId, message: outcome.message }),
          );
        } else if (outcome.kind === "failed") {
          failure = outcome.failure;
        }
        return;
      }

      if (event.type !== "agent_end") {
        return;
      }
      activityByToolCallId.clear();
      if (failure === undefined) {
        for (const reason of activeAttentionReasons) {
          const cleared = await persistObservation({
            kind: "attention",
            state: "cleared",
            reason,
            message: "Runtime recovered.",
          });
          activeAttentionReasons.delete(reason);
          await commitObservation(cleared);
        }
        await commitObservation(
          await persistObservation({ kind: "turn", state: "completed", turnId }),
        );
        return;
      }
      // An abort Pi named as one, and an abort only this runtime knows it
      // caused, are the same fact reported two ways: the turn ended because it
      // was asked to. Neither is an unrecoverable failure, and neither deserves
      // a banner offering no way out of a state the user chose.
      if (failure.reason !== "aborted" && !interrupting) {
        // Neither a dropped socket nor a spent window is a decision anyone has to
        // make, so the turn stays live over the recovery and the attempt that
        // follows: no completion, no interruption, and a follow-up typed
        // meanwhile queues against the same run exactly as it would mid-stream.
        // What survives the turn's own budget is reported as it always was.
        const recovered = await recoverFromFailure(failure, runSignal);
        // Re-read after the await, because both recoveries take real time: a
        // person who pressed stop during the backoff or the summary has ended
        // this turn themselves, and neither resuming it nor raising an Attention
        // over it is an honest answer to that.
        if (!interrupting) {
          if (recovered) {
            autoRetryPending = true;
            return;
          }
          // Including a context refusal that compaction could not answer — an
          // overflow with nothing left to summarize is still a dead end, and
          // still has to say so.
          const reason = attentionReasonFor(failure);
          const raised = await persistObservation({
            kind: "attention",
            state: "raised",
            reason,
            message:
              autoRetryAttempts === 0
                ? failure.message
                : sanitizeDiagnostic(`${failure.message} (after ${autoRetryAttempts} retries)`),
          });
          activeAttentionReasons.add(reason);
          await commitObservation(raised);
        }
      }
      await commitObservation(
        await persistObservation({ kind: "turn", state: "interrupted", turnId }),
      );
    });

    const onAbort = (): void => {
      cancelled = true;
      autoRetryPending = false;
      interruptTurn();
      // The active submit promise owns any observer failure from this same run.
      /* v8 ignore next -- abort-listener failures are intentionally suppressed */
      void agent.waitForIdle().catch(() => undefined);
    };
    abortListener = onAbort;

    const handle: RuntimeAttachmentHandle = {
      async submitUserMessage(
        text,
        delivery = "queue",
        commandId,
        images = [],
      ): Promise<DeliveryOutcome> {
        if (closed || cancelled) {
          return { kind: "rejected", reason: "closed", message: "This attachment is closed." };
        }
        if (delivery === "replace") {
          return {
            kind: "rejected",
            reason: "replace-unsupported",
            message: "Pi does not support replacing the active turn.",
          };
        }
        // Wait out a compaction already rewriting the very array this delivery
        // is about to be composed against — see {@link contextRewrite}. Waited
        // on rather than refused: maintenance nobody asked for must not cost
        // someone their message. Every question below is asked after it,
        // because the answers can change while it is held.
        await contextRewrite;
        if (closed || cancelled) {
          return { kind: "rejected", reason: "closed", message: "This attachment is closed." };
        }
        if (agent.state.isStreaming) {
          const message = queuedUserMessage(text, images);
          const pending = {
            commandId: commandId ?? null,
            operation: "message.submit" as const,
            delivery,
            message,
          };
          pendingQueuedDeliveries.set(message, pending);
          if (delivery === "steer") agent.steer(message);
          else agent.followUp(message);
          return { kind: "delivered", delivery };
        }
        observationDelivery.consumeFailure();
        // Before the message is composed, not after: compaction can change what
        // the context holds, and the Brief is prepended on an empty one. Held
        // as a rewrite so an explicit `/compact` arriving meanwhile is refused
        // rather than admitted onto a context this turn is already composing
        // against; everything from here to `prompt` is synchronous, so there is
        // no gap between releasing it and Pi owning the array itself.
        await rewritingTheContext(compactBeforeTurn);
        const delivered =
          agent.state.messages.length === 0 ? composeFirstUserMessage(spec, text) : text;
        const message = queuedUserMessage(delivered, images);
        pendingRunDelivery = {
          commandId: commandId ?? null,
          operation: "message.submit" as const,
          delivery: "prompt" as const,
          message,
        };
        await agent.prompt(message);
        await settleRun();
        const failed = observationDelivery.consumeFailure();
        if (failed !== undefined) {
          throw failed;
        }
        return { kind: "delivered", delivery: "prompt" };
      },

      async selectModel(selection) {
        if (closed || cancelled) {
          return { kind: "rejected", reason: "closed", message: "This attachment is closed." };
        }
        if (agent.state.isStreaming) {
          return {
            kind: "rejected",
            reason: "busy-unsupported",
            message: "The model cannot change while Pi is running.",
          };
        }
        let available: Awaited<ReturnType<Models["getAvailable"]>>;
        try {
          available = await models.getAvailable(
            selection.providerId,
            spec.signal ? { signal: spec.signal } : undefined,
          );
        } catch {
          return {
            kind: "rejected",
            reason: "model-unavailable",
            message: "The selected model is not currently available.",
          };
        }
        const selected = available.find(
          (candidate) =>
            candidate.provider === selection.providerId && candidate.id === selection.modelId,
        );
        if (!selected) {
          return {
            kind: "rejected",
            reason: "model-unavailable",
            message: "The selected model is not currently available.",
          };
        }
        if (!getSupportedThinkingLevels(selected).includes(selection.reasoningLevel)) {
          return {
            kind: "rejected",
            reason: "reasoning-unsupported",
            message: "The selected reasoning level is not supported by this model.",
          };
        }
        // Availability can resolve asynchronously. Recheck the idle boundary
        // immediately before changing the pair so neither half is applied to
        // a turn that started while credentials were being inspected.
        if (closed || cancelled) {
          return { kind: "rejected", reason: "closed", message: "This attachment is closed." };
        }
        if (agent.state.isStreaming) {
          return {
            kind: "rejected",
            reason: "busy-unsupported",
            message: "The model cannot change while Pi is running.",
          };
        }
        agent.state.model = selected;
        agent.state.thinkingLevel = selection.reasoningLevel;
        return { kind: "selected" };
      },

      async retry(commandId): Promise<DeliveryOutcome> {
        if (closed || cancelled) {
          return { kind: "rejected", reason: "closed", message: "This attachment is closed." };
        }
        if (agent.state.isStreaming) {
          return {
            kind: "rejected",
            reason: "busy-unsupported",
            message: "Pi is already running.",
          };
        }
        observationDelivery.consumeFailure();
        const outcome = await retryFailedTurn(commandId ?? null);
        await settleRun();
        const failed = observationDelivery.consumeFailure();
        if (failed !== undefined) throw failed;
        return outcome;
      },

      /**
       * The third producer of a compaction, and the only one anybody asked
       * for.
       *
       * It runs the same {@link compactContext} the other two run, on the same
       * durable path, and emits the same observation with `manual` on it. What
       * is new here is only that someone is waiting for an answer, so every
       * way of not compacting becomes a refusal with a reason rather than a
       * fact filed to the ledger and nothing else.
       *
       * **Refused while Pi is running, never queued.** Rewriting the context
       * under a live turn corrupts the turn in flight, which is why both
       * automatic paths only ever run when Pi is idle. Queueing it instead
       * would answer a different question than the one asked: by the time the
       * turn ended the reply would already be in the context, so what ran
       * would not be the compaction the person requested when they requested
       * it. A refusal they can act on — stop the turn, or wait — is the honest
       * answer.
       *
       * **The switch does not reach here.** `autoCompaction` is Pi's
       * `enabled`, read by `shouldCompact` and by nothing else, so switching
       * it off cannot block this any more than it blocks overflow recovery.
       * That is the behaviour this wants: off means "do not interrupt me to
       * make room", and a person typing `/compact` is not being interrupted.
       *
       * The attachment's own signal bounds it, like {@link compactBeforeTurn}:
       * no turn is running, so there is no turn whose stop could mean this.
       */
      async compact(instructions): Promise<CompactionRequestOutcome> {
        if (closed || cancelled) {
          return { kind: "rejected", reason: "closed", message: "This attachment is closed." };
        }
        // Two ways for the context not to be free, and they are one question
        // asked of two owners: Pi is consuming the array, or a compaction is
        // already replacing it. Asked synchronously, before anything is
        // awaited, so the answer cannot go stale between the check and the act
        // — which is the whole failure this guard exists to prevent.
        //
        // One refusal, two sentences. A person told "while Pi is running" about
        // a Session that is plainly idle would go looking for a turn that is not
        // there; the wait they are actually in is a summary, and it ends.
        if (agent.state.isStreaming) {
          return {
            kind: "rejected",
            reason: "busy-unsupported",
            message: "The context cannot be compacted while Pi is running.",
          };
        }
        if (rewritingContext) {
          return {
            kind: "rejected",
            reason: "busy-unsupported",
            message: "This context is already being compacted.",
          };
        }
        const outcome = await rewritingTheContext(async () =>
          compactContext({
            reason: "manual",
            path: await conversationBranch(),
            signal: spec.signal,
            ...(instructions === undefined ? {} : { instructions }),
          }),
        );
        if (outcome.kind === "compacted") return { kind: "compacted" };
        return outcome.kind === "skipped"
          ? {
              kind: "rejected",
              reason: "nothing-to-compact",
              message: "There is nothing left to summarize.",
            }
          : { kind: "rejected", reason: "summary-failed", message: outcome.message };
      },

      async interrupt(): Promise<void> {
        interruptTurn();
        await agent.waitForIdle();
      },

      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        // Withdrawn attachments retry nothing. Cleared rather than tested for at
        // the drain: a decision to retry that was taken while this ran would
        // otherwise start a Pi run against an environment already cleaned up.
        autoRetryPending = false;
        spec.signal?.removeEventListener("abort", onAbort);
        interruptTurn();
        await agent.waitForIdle();
        unsubscribe?.();
        unsubscribe = undefined;
        await ownedToolEnv.cleanup();
        toolEnv = undefined;
        await sidecarEnv.cleanup();
        await observe({ kind: "attachment", state: "closed" });
      },

      async reconcile(cursor) {
        const entries = await sidecar.findEntries({ order: "oldestFirst" });
        const cursorIndex =
          cursor === null ? -1 : entries.findIndex((entry) => entry.id === cursor);
        if (cursor !== null && cursorIndex < 0) {
          throw new Error("Pi recovery cursor is not present in the owned sidecar.");
        }
        const allMarkers = entries
          .filter((entry): entry is CustomEntry => entry.type === "custom")
          .map(recoveredObservation)
          .filter(
            (observation): observation is NonNullable<ReturnType<typeof recoveredObservation>> =>
              observation !== null,
          );
        assertUniqueAcceptedCommands(allMarkers);
        const afterCursorIds = new Set(entries.slice(cursorIndex + 1).map(({ id }) => id));
        const markers = allMarkers.filter((marker) => afterCursorIds.has(marker.recoveryCursor));
        const observations = markers
          .filter(
            (
              marker,
            ): marker is RecoverableObservation & {
              occurredAt: number;
              recoveryCursor: string;
            } => marker.kind !== "command-accepted",
          )
          .filter(
            (observation) =>
              observation.kind !== "message-settled" ||
              !disagreedSettledEntryIds.has(observation.message.entryId),
          );
        const receipts = [
          ...new Map(
            allMarkers
              .filter(
                (
                  marker,
                ): marker is AcceptedCommandMarker & {
                  occurredAt: number;
                  recoveryCursor: string;
                } => marker.kind === "command-accepted",
              )
              .map((marker) => [
                marker.commandId,
                { commandId: marker.commandId, acceptedAt: marker.occurredAt },
              ]),
          ).values(),
        ];
        return {
          cursor: markers.at(-1)?.recoveryCursor ?? cursor,
          observations,
          ...(receipts.length > 0 ? { receipts } : {}),
        };
      },

      recovery,
    };

    spec.signal?.addEventListener("abort", onAbort);
    if (isAborted(spec.signal)) {
      onAbort();
    }

    await observe({
      kind: "attachment",
      state: spec.recovery === undefined ? "started" : "recovered",
      recovery,
    });
    return handle;
  } catch (error) {
    if (abortListener !== undefined) {
      spec.signal?.removeEventListener("abort", abortListener);
    }
    unsubscribe?.();
    await toolEnv?.cleanup().catch(
      /* v8 ignore next -- owned-environment cleanup is best effort after a failed attach. */
      () => undefined,
    );
    if (createdSidecar && sidecarPath !== undefined) {
      await sidecarEnv.remove(sidecarPath, { force: true }).catch(
        /* v8 ignore next -- sidecar deletion is best effort after a failed attach. */
        () => undefined,
      );
    }
    await sidecarEnv.cleanup().catch(
      /* v8 ignore next -- sidecar cleanup is best effort after a failed attach. */
      () => undefined,
    );
    throw error;
  }
}
