/**
 * VC-497 opt-in, branch-only AgentRuntime substrate. No desktop wiring, exports,
 * existing sidecars, or default runtime changes. This is NOT production parity.
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ConversationBusy,
  createRegistry,
  Harness,
  watchEvents,
  type Cursor,
  type EntryRecord,
  type SubmissionRecord,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Models } from "pi-durable-ai/models";
import type { AgentRuntime, RuntimeAttachmentHandle, SessionRuntimeSpec } from "@volli/shared";
import { composeSystemPrompt } from "../../src/prompt.ts";
import { observationKey, projectRecords, turnIdFor } from "./projection.ts";
import { spikeTools, type SpikeToolProbe } from "./tools.ts";

const context = BACKGROUND_CONTEXT;
const owners = new Set<string>();
export interface DurableSpikeOptions {
  enabled: boolean;
  fallback: AgentRuntime;
  models: Models;
  /** New checkpoint file per Session, NEVER a legacy Pi sidecar. */
  checkpointPath(sessionId: string): string;
  probe?: SpikeToolProbe;
  onEvents?(types: readonly string[]): void;
}

export function createDurableSpikeRuntime(options: DurableSpikeOptions): AgentRuntime {
  if (!options.enabled) return options.fallback;
  return {
    inspectModelAccess: (input) => options.fallback.inspectModelAccess(input),
    completeUtility: (input) => options.fallback.completeUtility(input),
    startSession: async (spec) => {
      if (spec.identity.role !== "ticket") return options.fallback.startSession(spec);
      if (
        spec.recovery ||
        spec.carry ||
        spec.promptResources?.length ||
        spec.signal ||
        spec.model.reasoningLevel !== "off"
      ) {
        throw new Error(
          "Spike cannot reopen legacy recovery, carry resources, or honor attachment cancellation",
        );
      }
      return openAttachment(spec, options);
    },
  };
}

async function openAttachment(
  spec: SessionRuntimeSpec,
  options: DurableSpikeOptions,
): Promise<RuntimeAttachmentHandle> {
  const extension = spikeTools(spec, options.probe);
  const path = resolve(options.checkpointPath(spec.identity.sessionId));
  if (owners.has(path)) throw new Error("Checkpoint store already owned in this process");
  owners.add(path);
  let harness: Harness;
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
  try {
    await mkdir(dirname(path), { recursive: true });
    storage = await openNodeSqliteStorage(path);
    const registry = createRegistry();
    registry.install(extension);
    harness = await Harness.open(
      storage,
      {
        models: options.models,
        registry,
        settings: {
          toolExecution: "sequential",
          retry: { enabled: false },
          compaction: { enabled: false, backgroundTokens: 0 },
        },
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? spec.workspacePath }),
      },
      context,
    );
  } catch (error) {
    await storage?.close(context);
    owners.delete(path);
    throw error;
  }
  try {
    const root = await harness.root(context, {
      agent: {
        model: { provider: spec.model.providerId, modelId: spec.model.modelId },
        cwd: spec.workspacePath,
        tools: extension.tools,
        thinkingLevel: "off",
        instructions: composeSystemPrompt({ role: spec.identity.role, tools: spec.tools }),
      },
    });
    // root() ignores options after reopen: fail closed if a caller changed frozen membership.
    const agent = await root.agent(context);
    if (JSON.stringify(agent.tools.map((t) => t.name)) !== JSON.stringify(spec.tools.tools)) {
      throw new Error("Checkpoint's frozen tools disagree with Session birth surface");
    }
    const events = await watchEvents(harness, root.id, context);
    let closed = false;
    let failed: unknown;
    const seen = new Set<string>();
    const records = () =>
      harness.commit(async () => {
        const entries: EntryRecord[] = [];
        const submissions: SubmissionRecord[] = [];
        let cursor: Cursor | undefined;
        do {
          const page = await storage!.scanEntries(
            { conversationId: root.id },
            256,
            cursor,
            context,
          );
          entries.push(...page.items);
          cursor = page.next;
        } while (cursor);
        do {
          const page = await storage!.scanSubmissions(
            { conversationId: root.id },
            256,
            cursor,
            context,
          );
          submissions.push(...page.items);
          cursor = page.next;
        } while (cursor);
        return projectRecords(entries, submissions);
      }, context);
    let deliveryLine = Promise.resolve();
    const flush = () => {
      deliveryLine = deliveryLine.then(async () => {
        const projection = await records();
        for (const observation of projection.observations) {
          const key = observationKey(observation);
          if (key && seen.has(key)) continue;
          await spec.observer(observation);
          if (key) seen.add(key); // acknowledge only AFTER the product sink commits
        }
      });
      return deliveryLine;
    };
    events.start(async (batch) => {
      options.onEvents?.(batch.map((e) => e.type));
      try {
        await flush();
        const snapshot = await harness.inspect(context);
        const active = snapshot.submissions.find(
          (s) => s.type === "input" && s.status === "placed",
        );
        if (active)
          for (const event of batch) {
            if (event.type !== "message_update") continue;
            for (const change of event.changes)
              if (change.type === "text_delta" || change.type === "thinking_delta") {
                await spec.observer({
                  kind: "delta",
                  turnId: turnIdFor(active.id),
                  channel: change.type === "text_delta" ? "text" : "reasoning",
                  text: change.delta,
                });
              }
          }
      } catch (error) {
        failed = error;
        throw error;
      }
    });
    await flush();
    harness.resume();
    return {
      // Intentionally not masquerading as RuntimeRecoveryRef.runtime="pi"; no disk format migration.
      recovery: undefined,
      submitUserMessage: async (
        text,
        delivery = "queue",
        commandId,
        images,
        resources,
        settle = "turn",
      ) => {
        if (closed) return { kind: "rejected", reason: "closed", message: "Attachment closed" };
        if (failed) throw failed;
        if (!commandId || images?.length || resources?.length)
          throw new Error("Spike requires a Command ID and text-only input");
        if (delivery === "replace")
          return {
            kind: "rejected",
            reason: "replace-unsupported",
            message: "Spike does not replace",
          };
        // Only one run at a time: queued input grouping needs explicit product Turn semantics.
        const previous = await storage!.submissionByRequest(root.id, commandId, context);
        let submission;
        try {
          submission = await root.submit(
            { type: "input", content: text, requestId: commandId, whenBusy: "reject" },
            context,
          );
        } catch (error) {
          if (error instanceof ConversationBusy)
            return {
              kind: "rejected",
              reason: "busy-unsupported",
              message: "Spike does not queue or steer a busy run",
            };
          throw error;
        }
        if (settle === "turn") await submission.wait(context);
        await flush();
        if (failed) throw failed;
        return {
          kind: "delivered",
          delivery: "prompt",
          ...(settle === "opened" && !previous ? { turnOpened: true } : {}),
        };
      },
      selectModel: async (selection) => {
        if (closed) return { kind: "rejected", reason: "closed", message: "Attachment closed" };
        if ((await harness.inspect(context)).tasks.length)
          return { kind: "rejected", reason: "busy-unsupported", message: "Busy" };
        if (selection.reasoningLevel !== "off")
          return {
            kind: "rejected",
            reason: "reasoning-unsupported",
            message: "Spike is reasoning-off only",
          };
        if (!options.models.getModel(selection.providerId, selection.modelId))
          return { kind: "rejected", reason: "model-unavailable", message: "Model unavailable" };
        await root.configure(
          { model: { provider: selection.providerId, modelId: selection.modelId } },
          context,
        );
        return { kind: "selected" };
      },
      retry: async () => ({
        kind: "rejected",
        reason: "retry-unavailable",
        message: "Spike only tests Command retries with the same requestId",
      }),
      compact: async () => ({
        kind: "rejected",
        reason: "summary-failed",
        message: "Compaction parity is tested separately; disabled in this adapter",
      }),
      interrupt: async () => {
        await root.abort(context);
        await flush();
      },
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await events.stop();
          await harness.close(context);
        } finally {
          owners.delete(path);
        }
      },
      reconcile: async (cursor) => {
        const projection = await records();
        const prior = new Set<string>(cursor ? (JSON.parse(cursor) as string[]) : []);
        const observations = projection.observations.filter(
          (o) => !prior.has(observationKey(o) ?? ""),
        );
        for (const observation of observations) {
          const key = observationKey(observation);
          if (key) prior.add(key);
        }
        // Branch-only O(history) ack-set, NOT a proposed shipped cursor format.
        return { cursor: JSON.stringify([...prior]), observations, receipts: projection.receipts };
      },
    };
  } catch (error) {
    await harness.close(context);
    owners.delete(path);
    throw error;
  }
}
