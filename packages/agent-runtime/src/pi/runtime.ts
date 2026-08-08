/** The singular, Node-hostable Agent Runtime backed by Pi core. */

import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Agent, JsonlSessionRepo, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  AgentRuntime,
  DeliveryOutcome,
  RuntimeAttachmentHandle,
  RuntimeFailure,
  TicketRuntimeSpec,
} from "../contracts";
import { composeFirstUserMessage, composeSystemPrompt } from "../prompt";
import { ScopedExecutionEnv } from "./scoped-execution-env";
import { createPiTools } from "./tools";
import { attentionReasonFor, classifyAssistantMessage, recoveryRefFor } from "./transcript";

export interface PiRuntimeHostOptions {
  /** Directory that owns every attachment's Pi JSONL recovery sidecar. */
  sessionDataDir: string;
  /** Injectable Pi model collection for deterministic tests and host-owned credentials. */
  models?: Models;
}

/** Build the one structured executor port. */
export function createPiAgentRuntime(options: PiRuntimeHostOptions): AgentRuntime {
  return {
    startTicketSession: (spec) => attachTicketSession(options, spec),
  };
}

/** Pi messages are persisted as JSON; omit optional properties Pi represents as undefined. */
function durableMessage(message: AgentMessage): AgentMessage {
  return JSON.parse(JSON.stringify(message)) as AgentMessage;
}

async function rejectUnavailableModel(spec: TicketRuntimeSpec): Promise<never> {
  const message = `Model ${spec.model.providerId}/${spec.model.modelId} is not available.`;
  await spec.observer({
    kind: "attachment",
    state: "failed",
    failure: { reason: "configuration", message },
  });
  throw new Error(message);
}

async function rejectRecoveryUntilSessionFour(spec: TicketRuntimeSpec): Promise<never> {
  const message =
    "Pi recovery is not available until migration Session 4 lands ledger reconciliation.";
  await spec.observer({
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
  if (spec.recovery !== undefined) {
    return rejectRecoveryUntilSessionFour(spec);
  }

  const observe = spec.observer;
  const models = host.models ?? builtinModels();
  const model = models.getModel(spec.model.providerId, spec.model.modelId);
  if (model === undefined) {
    return rejectUnavailableModel(spec);
  }

  const sidecarEnv = new NodeExecutionEnv({ cwd: host.sessionDataDir });
  const sidecars = new JsonlSessionRepo({ fs: sidecarEnv, sessionsRoot: host.sessionDataDir });
  const sidecar = await sidecars.create({
    cwd: spec.worktreePath,
    metadata: {
      volliSessionId: spec.identity.sessionId,
      volliThreadId: spec.identity.rootThreadId,
      volliAttachmentId: spec.identity.attachmentId,
    },
  });
  const sidecarMetadata = await sidecar.getMetadata();
  const recovery = recoveryRefFor(sidecarMetadata.id, sidecarMetadata.path);
  const toolEnv = await ScopedExecutionEnv.create(spec.worktreePath);
  const tools = createPiTools(spec.tools, toolEnv);

  let turnId = randomUUID();
  let failure: RuntimeFailure | undefined;
  let observationFailure: unknown;
  let closed = false;

  const commitObservation = async (
    observation: Parameters<TicketRuntimeSpec["observer"]>[0],
  ): Promise<void> => {
    try {
      await observe(observation);
    } catch (error) {
      observationFailure ??= error;
      throw error;
    }
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: composeSystemPrompt(spec),
      model,
      thinkingLevel: spec.model.reasoningLevel,
      tools,
    },
    streamFn: models.streamSimple.bind(models),
    sessionId: sidecarMetadata.id,
    toolExecution: "sequential",
  });

  const unsubscribe = agent.subscribe(async (event) => {
    if (event.type === "agent_start") {
      turnId = randomUUID();
      failure = undefined;
      await commitObservation({ kind: "turn", state: "started", turnId });
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
      const entryId = await sidecar.appendMessage(durableMessage(event.message));
      if (event.message.role !== "assistant") {
        return;
      }
      const outcome = classifyAssistantMessage(entryId, event.message as AssistantMessage);
      if (outcome.kind === "settled") {
        await commitObservation({ kind: "message-settled", turnId, message: outcome.message });
      } else {
        failure = outcome.failure;
      }
      return;
    }

    if (event.type !== "agent_end") {
      return;
    }
    if (failure === undefined) {
      await commitObservation({ kind: "turn", state: "completed", turnId });
      return;
    }
    if (failure.reason !== "aborted") {
      await commitObservation({
        kind: "attention",
        state: "raised",
        reason: attentionReasonFor(failure),
        message: failure.message,
      });
    }
    await commitObservation({ kind: "turn", state: "interrupted", turnId });
  });

  const handle: RuntimeAttachmentHandle = {
    async submitUserMessage(text: string): Promise<DeliveryOutcome> {
      if (closed) {
        return { kind: "rejected", reason: "closed", message: "This attachment is closed." };
      }
      if (agent.state.isStreaming) {
        return {
          kind: "rejected",
          reason: "busy-unsupported",
          message: "The agent is still working on the previous message.",
        };
      }
      const delivered =
        agent.state.messages.length === 0 ? composeFirstUserMessage(spec.brief, text) : text;
      await agent.prompt(delivered);
      if (observationFailure !== undefined) {
        throw observationFailure;
      }
      return { kind: "delivered", delivery: "prompt" };
    },

    async interrupt(): Promise<void> {
      agent.abort();
      await agent.waitForIdle();
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      spec.signal?.removeEventListener("abort", abortListener);
      agent.abort();
      await agent.waitForIdle();
      unsubscribe();
      await toolEnv.cleanup();
      await sidecarEnv.cleanup();
      await observe({ kind: "attachment", state: "closed" });
    },

    recovery,
  };

  const abortListener = (): void => {
    // The active submit promise owns any observer failure from this same run.
    /* v8 ignore next -- interrupt failures are intentionally suppressed in a DOM callback */
    void handle.interrupt().catch(() => undefined);
  };
  spec.signal?.addEventListener("abort", abortListener);

  await observe({ kind: "attachment", state: "started", recovery });
  return handle;
}
