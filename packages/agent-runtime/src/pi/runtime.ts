/** The singular, Node-hostable Agent Runtime backed by Pi core. */

import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentMessage, CustomEntry, MessageEntry } from "@earendil-works/pi-agent-core";
import { Agent, JsonlSessionRepo, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  getSupportedThinkingLevels,
  type AssistantMessage,
  type Models,
  type UserMessage,
} from "@earendil-works/pi-ai";
import {
  isActivityKind,
  type AgentRuntime,
  type DeliveryOutcome,
  type RuntimeAttachmentHandle,
  type RuntimeActivityObservation,
  type RuntimeActivityValue,
  type RuntimeFailure,
  type SettledMessageObservation,
  type AttentionObservation,
  type SessionRuntimeSpec,
  type TurnObservation,
} from "@volli/shared";
import { authorityVerdict } from "../authority/gate";
import { composeFirstUserMessage, composeSystemPrompt } from "../prompt";
import { mapPiActivity } from "./activity";
import { inspectPiModelAccess } from "./model-access";
import { piOwnedModels } from "./models";
import { OrderedObservationDelivery } from "./ordered-observation-delivery";
import { ScopedExecutionEnv, type SessionExecutionEnv } from "./scoped-execution-env";
import { createPiTools } from "./tools";
import { attentionReasonFor, classifyAssistantMessage, recoveryRefFor } from "./transcript";

export interface PiRuntimeHostOptions {
  /** Directory that owns every attachment's Pi JSONL recovery sidecar. */
  sessionDataDir: string;
  /**
   * Injectable Pi model collection, for deterministic tests that script the
   * provider call. Omitted in the product: Pi owns provider credentials and
   * refresh behavior, and {@link piOwnedModels} is what reaches them.
   */
  models?: Models;
  /** Host clock for runtime observations; injectable for deterministic tests. */
  now?: () => number;
  /** Internal contained-environment factory for deterministic Node runtime tests. */
  executionEnvFactory?: (workspacePath: string) => Promise<SessionExecutionEnv>;
}

/** Everything {@link attachSession} needs, with the default already chosen. */
interface PiRuntimeHost {
  sessionDataDir: string;
  models: Models;
  now: () => number;
  executionEnvFactory: (workspacePath: string) => Promise<SessionExecutionEnv>;
}

/**
 * Build the one structured executor port.
 *
 * The models are resolved once, here, rather than per attachment: the credential
 * store behind them serializes this process's writes to Pi's `auth.json`, and a
 * fresh store per attach would serialize nothing.
 */
export function createPiAgentRuntime(options: PiRuntimeHostOptions): AgentRuntime {
  const host: PiRuntimeHost = {
    sessionDataDir: options.sessionDataDir,
    models: options.models ?? piOwnedModels(),
    now: options.now ?? Date.now,
    executionEnvFactory: options.executionEnvFactory ?? ScopedExecutionEnv.create,
  };
  return {
    inspectModelAccess: (input) => inspectPiModelAccess(host.models, host.now, input),
    startSession: (spec) => attachSession(host, spec),
  };
}

/** Pi messages are persisted as JSON; omit optional properties Pi represents as undefined. */
function durableMessage(message: AgentMessage): AgentMessage {
  return JSON.parse(JSON.stringify(message)) as AgentMessage;
}

function queuedUserMessage(text: string): UserMessage {
  return { role: "user", content: text, timestamp: Date.now() };
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

type RecoverableObservation =
  | TurnObservation
  | SettledMessageObservation
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

function recoveredObservation(
  entry: CustomEntry,
): (RecoverableMarker & { occurredAt: number; recoveryCursor: string }) | null {
  if (entry.customType !== VOLLI_OBSERVATION_MARKER) return null;
  const data = entry.data;
  if (!isRecord(data)) throw new Error("Pi recovery marker is malformed.");
  if (!isRecoverableObservation(data)) throw new Error("Pi recovery marker is malformed.");
  return {
    ...(data as unknown as RecoverableMarker),
    occurredAt: entry.timestamp,
    recoveryCursor: entry.id,
  };
}

function isRecoverableObservation(value: Record<string, unknown>): boolean {
  switch (value["kind"]) {
    case "turn":
      return (
        isOneOf(value["state"], ["started", "completed", "interrupted"]) &&
        typeof value["turnId"] === "string"
      );
    case "message-settled":
      return typeof value["turnId"] === "string" && isSettledMessage(value["message"]);
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

function isPersistedUserMessage(value: unknown): value is UserMessage {
  return (
    isRecord(value) &&
    value["role"] === "user" &&
    typeof value["content"] === "string" &&
    typeof value["timestamp"] === "number" &&
    Number.isFinite(value["timestamp"])
  );
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

async function rejectUnavailableModel(spec: SessionRuntimeSpec): Promise<never> {
  const message = `Model ${spec.model.providerId}/${spec.model.modelId} is not available.`;
  await spec.observer({
    kind: "attachment",
    state: "failed",
    failure: { reason: "configuration", message },
  });
  throw new Error(message);
}

async function rejectCancelledAttachment(spec: SessionRuntimeSpec): Promise<never> {
  const message = "Runtime attachment was cancelled before it started.";
  await spec.observer({
    kind: "attachment",
    state: "failed",
    failure: { reason: "aborted", message },
  });
  throw new Error(message);
}

const CONTAINED_EXECUTION_UNAVAILABLE = "Contained process execution is unavailable.";

async function attachSession(
  host: PiRuntimeHost,
  spec: SessionRuntimeSpec,
): Promise<RuntimeAttachmentHandle> {
  if (isAborted(spec.signal)) {
    return rejectCancelledAttachment(spec);
  }

  const observe = spec.observer;
  const models = host.models;
  const model = models.getModel(spec.model.providerId, spec.model.modelId);
  if (model === undefined) {
    return rejectUnavailableModel(spec);
  }

  const sidecarEnv = new NodeExecutionEnv({ cwd: host.sessionDataDir });
  let sidecarPath: string | undefined;
  let toolEnv: SessionExecutionEnv | undefined;
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
    const recoveredEntries = inputRecovery
      ? await sidecar.findEntries({ order: "oldestFirst" })
      : [];
    const recoveredMarkers = recoveredEntries
      .filter((entry): entry is CustomEntry => entry.type === "custom")
      .map(recoveredObservation)
      .filter(
        (observation): observation is NonNullable<ReturnType<typeof recoveredObservation>> =>
          observation !== null,
      );
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
    const acceptedMessages = new Map(
      recoveredMarkers.flatMap((marker) =>
        marker.kind === "command-accepted" && marker.operation === "message.submit"
          ? [[marker.recoveryCursor, marker.message] as const]
          : [],
      ),
    );
    const recoveredMessages = recoveredEntries.flatMap((entry) => {
      const accepted = acceptedMessages.get(entry.id);
      if (accepted !== undefined) return [accepted];
      if (entry.type !== "message") return [];
      if (!recoverableMessage(entry) || disagreedSettledEntryIds.has(entry.id)) return [];
      return [entry.message];
    });
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
    try {
      toolEnv = await host.executionEnvFactory(spec.workspacePath);
      if (spec.tools.tools.includes("execute")) {
        const prepared = await toolEnv.prepareProcessExecution();
        if (!prepared.ok) {
          throw prepared.error;
        }
      }
    } catch {
      await observe({
        kind: "attachment",
        state: "failed",
        failure: {
          reason: "configuration",
          message: CONTAINED_EXECUTION_UNAVAILABLE,
        },
      });
      throw new Error(CONTAINED_EXECUTION_UNAVAILABLE);
    }
    const containedToolEnv = toolEnv;
    const tools = createPiTools(spec.tools, containedToolEnv);

    let turnId = randomUUID();
    let failure: RuntimeFailure | undefined;
    let closed = false;
    let cancelled = false;
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

    const agent = new Agent({
      initialState: {
        systemPrompt: composeSystemPrompt(spec),
        model,
        thinkingLevel: spec.model.reasoningLevel,
        tools,
        messages: recoveredMessages,
      },
      streamFn: models.streamSimple.bind(models),
      sessionId: sidecarMetadata.id,
      toolExecution: "sequential",
      // `terminate` is left unset on purpose: Pi only ends the run early when
      // every finalized result in the batch asks for it, which is not what one
      // refused call means.
      beforeToolCall: async ({ toolCall, args }) => {
        const verdict = authorityVerdict({
          tool: toolCall.name,
          args,
          authority: spec.authority,
          workspacePath: spec.workspacePath,
        });
        if (verdict.outcome === "allow") return undefined;
        // Recorded before refused, through the same ordered queue as every other
        // observation: a refusal that overtook the turn it belongs to would be
        // filed against the wrong turn, and one that raced the activity stream
        // would print out of order. `commitObservation` resolves at the consumer
        // boundary and never rejects — a ledger that cannot be written is not a
        // reason to let the call through, and the failure it holds is consumed at
        // the next command boundary like any other.
        await commitObservation({
          kind: "authority",
          state: "denied",
          turnId,
          tool: toolCall.name,
          cause: verdict.cause,
          reason: verdict.reason,
        });
        return { block: true, reason: verdict.reason };
      },
    });
    agent.steeringMode = "one-at-a-time";
    agent.followUpMode = "one-at-a-time";

    unsubscribe = agent.subscribe(async (event) => {
      if (event.type === "agent_start") {
        turnId = randomUUID();
        failure = undefined;
        activityByToolCallId.clear();
        await commitObservation(
          await persistObservation({ kind: "turn", state: "started", turnId }),
        );
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
      if (failure.reason !== "aborted") {
        const reason = attentionReasonFor(failure);
        const raised = await persistObservation({
          kind: "attention",
          state: "raised",
          reason,
          message: failure.message,
        });
        activeAttentionReasons.add(reason);
        await commitObservation(raised);
      }
      await commitObservation(
        await persistObservation({ kind: "turn", state: "interrupted", turnId }),
      );
    });

    const onAbort = (): void => {
      cancelled = true;
      agent.abort();
      // The active submit promise owns any observer failure from this same run.
      /* v8 ignore next -- abort-listener failures are intentionally suppressed */
      void agent.waitForIdle().catch(() => undefined);
    };
    abortListener = onAbort;

    const handle: RuntimeAttachmentHandle = {
      async submitUserMessage(text, delivery = "queue", commandId): Promise<DeliveryOutcome> {
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
        if (agent.state.isStreaming) {
          const message = queuedUserMessage(text);
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
        const delivered =
          agent.state.messages.length === 0
            ? composeFirstUserMessage(spec.identity.role, spec.brief, text)
            : text;
        const message = queuedUserMessage(delivered);
        observationDelivery.consumeFailure();
        pendingRunDelivery = {
          commandId: commandId ?? null,
          operation: "message.submit" as const,
          delivery: "prompt" as const,
          message,
        };
        await agent.prompt(message);
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
        observationDelivery.consumeFailure();
        pendingRunDelivery = {
          commandId: commandId ?? null,
          operation: "executor.retry" as const,
          delivery: "retry" as const,
        };
        await agent.continue();
        const failed = observationDelivery.consumeFailure();
        if (failed !== undefined) throw failed;
        return { kind: "delivered", delivery: "retry" };
      },

      async interrupt(): Promise<void> {
        agent.abort();
        await agent.waitForIdle();
      },

      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        spec.signal?.removeEventListener("abort", onAbort);
        agent.abort();
        await agent.waitForIdle();
        unsubscribe?.();
        unsubscribe = undefined;
        await containedToolEnv.cleanup();
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
