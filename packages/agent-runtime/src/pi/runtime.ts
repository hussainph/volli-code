/**
 * The singular Agent Runtime, backed by Pi.
 *
 * One `AgentSession.prompt()` run is one Volli turn: Pi may take several
 * provider turns and tool executions inside it, but the product sees exactly
 * one turn started and one terminal turn observation. Live stream deltas are
 * transient; durable truth is drained from Pi's session entries at run end, so
 * every settled message carries the stable entry id that deduplicates replay
 * after a restart.
 *
 * Discovery is off: no ambient extensions, skills, prompts, themes, or context
 * files, an explicit tool allowlist, and in-memory settings. The only ambient
 * state Pi keeps is its own credential store, which is a deliberate product
 * decision rather than an accident of the host.
 */

import { randomUUID } from "node:crypto";
import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentRuntime,
  DeliveryOutcome,
  ReasoningLevel,
  RuntimeAttachmentHandle,
  RuntimeFailure,
  TicketRuntimeSpec,
} from "../contracts";
import { composeFirstUserMessage, composeSystemPrompt } from "../prompt";
import { createEmptyResourceLoader } from "./resource-loader";
import { toPiToolNames } from "./tools";
import {
  attentionReasonFor,
  classifyDiagnostic,
  classifySessionEntry,
  errorText,
  recoveryRefFor,
  sanitizeDiagnostic,
} from "./transcript";

/** The product ladder and Pi's thinking ladder currently coincide, name for name. */
const THINKING_LEVEL: Record<ReasoningLevel, ThinkingLevel> = {
  off: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

export interface PiRuntimeHostOptions {
  /** Directory that owns every attachment's JSONL session sidecar. */
  sessionDataDir: string;
  /**
   * Deterministic model seam. Replaces the created session's stream function,
   * so no request ever reaches a provider. Test-only: a production host must
   * leave this unset and let Pi own the provider call.
   */
  modelStream?: StreamFn;
  /**
   * Model and credential runtime. Test-only override; production omits it so Pi
   * resolves its own credential store.
   */
  modelRuntime?: ModelRuntime;
}

/** Build the runtime port. There is exactly one executor; this is not a registry. */
export function createPiAgentRuntime(options: PiRuntimeHostOptions): AgentRuntime {
  return {
    startTicketSession: (spec) => attachTicketSession(options, spec),
  };
}

function failUnavailableModel(spec: TicketRuntimeSpec): never {
  const message = `Model ${spec.model.providerId}/${spec.model.modelId} is not available.`;
  spec.observer({
    kind: "attachment",
    state: "failed",
    failure: { reason: "configuration", message },
  });
  throw new Error(message);
}

async function attachTicketSession(
  host: PiRuntimeHostOptions,
  spec: TicketRuntimeSpec,
): Promise<RuntimeAttachmentHandle> {
  const observe = spec.observer;
  const modelRuntime = host.modelRuntime ?? (await ModelRuntime.create());
  const model =
    modelRuntime.getModel(spec.model.providerId, spec.model.modelId) ?? failUnavailableModel(spec);

  const reopening = spec.recovery;
  const sessionManager = reopening
    ? SessionManager.open(reopening.sessionFilePath, host.sessionDataDir)
    : SessionManager.create(spec.worktreePath, host.sessionDataDir);

  const { session } = await createAgentSession({
    cwd: spec.worktreePath,
    model,
    thinkingLevel: THINKING_LEVEL[spec.model.reasoningLevel],
    modelRuntime,
    resourceLoader: createEmptyResourceLoader(composeSystemPrompt(spec)),
    tools: toPiToolNames(spec.tools),
    sessionManager,
    settingsManager: SettingsManager.inMemory(),
  });
  if (host.modelStream) {
    session.agent.streamFunction = host.modelStream;
  }

  // Entries already on disk are durable history the product has seen; only
  // entries appended from here on settle into new observations.
  const observedEntryIds = new Set(sessionManager.getEntries().map((entry) => entry.id));
  // Replaced at every run start; seeded so no observation can carry an empty turn.
  let turnId = randomUUID();
  let closed = false;

  function drainRunEntries(): void {
    let failure: RuntimeFailure | undefined;
    for (const entry of sessionManager.getEntries()) {
      if (observedEntryIds.has(entry.id)) {
        continue;
      }
      observedEntryIds.add(entry.id);
      const outcome = classifySessionEntry(entry);
      if (outcome === undefined) {
        continue;
      }
      if (outcome.kind === "settled") {
        observe({ kind: "message-settled", turnId, message: outcome.message });
        continue;
      }
      failure = outcome.failure;
    }

    if (failure === undefined) {
      observe({ kind: "turn", state: "completed", turnId });
      return;
    }
    if (failure.reason !== "aborted") {
      observe({
        kind: "attention",
        state: "raised",
        reason: attentionReasonFor(failure),
        message: failure.message,
      });
    }
    observe({ kind: "turn", state: "interrupted", turnId });
  }

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_start") {
      turnId = randomUUID();
      observe({ kind: "turn", state: "started", turnId });
      return;
    }
    if (event.type === "message_update") {
      const streamed = event.assistantMessageEvent;
      if (streamed.type === "text_delta") {
        observe({ kind: "delta", turnId, channel: "text", text: streamed.delta });
      }
      if (streamed.type === "thinking_delta") {
        observe({ kind: "delta", turnId, channel: "reasoning", text: streamed.delta });
      }
      return;
    }
    if (event.type === "agent_end") {
      drainRunEntries();
    }
  });

  const handle: RuntimeAttachmentHandle = {
    async submitUserMessage(text: string): Promise<DeliveryOutcome> {
      if (closed) {
        return { kind: "rejected", reason: "closed", message: "This attachment is closed." };
      }
      if (session.isStreaming) {
        return {
          kind: "rejected",
          reason: "busy-unsupported",
          message: "The agent is still working on the previous message.",
        };
      }
      // The Runtime Brief rides the first delivery of a Session and never again;
      // a reopened session already carries it in durable history.
      const delivered =
        session.messages.length === 0 ? composeFirstUserMessage(spec.brief, text) : text;
      try {
        await session.prompt(delivered);
      } catch (error) {
        const message = sanitizeDiagnostic(errorText(error));
        observe({
          kind: "attention",
          state: "raised",
          reason: attentionReasonFor({ reason: classifyDiagnostic(message), message }),
          message,
        });
        throw new Error(message, { cause: error });
      }
      return { kind: "delivered", delivery: "prompt" };
    },

    async interrupt(): Promise<void> {
      await session.abort();
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      spec.signal?.removeEventListener("abort", abortListener);
      unsubscribe();
      session.dispose();
      observe({ kind: "attachment", state: "closed" });
    },

    get recovery() {
      return recoveryRefFor(session.sessionId, session.sessionFile);
    },
  };

  const abortListener = (): void => {
    void handle.interrupt();
  };
  spec.signal?.addEventListener("abort", abortListener);

  observe({
    kind: "attachment",
    state: reopening ? "recovered" : "started",
    recovery: recoveryRefFor(session.sessionId, session.sessionFile),
  });

  return handle;
}
