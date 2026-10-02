/** Scripted provider only; the runtime, tools and persistence run for real. */
import {
  createAssistantMessageEventStream,
  createModels,
  fauxProvider,
  type AssistantMessage,
  type JsonObject,
  type Message,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
export type SecretFixtureReply = { name: string; args: JsonObject } | { text: string };
export function secretFixtureProvider(replies: SecretFixtureReply[], seen: readonly Message[][]) {
  let next = 0;
  const provider = fauxProvider({
    api: "anthropic-messages",
    provider: "anthropic",
    models: [{ id: "claude-haiku-4-5" }],
  });
  const stream: StreamFn = (model, context) => {
    (seen as Message[][]).push([...context.messages]);
    const reply = replies[next++] ?? { text: "done" };
    const output = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 120,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    };
    queueMicrotask(() => {
      output.push({ type: "start", partial: message });
      if ("name" in reply) {
        const call = {
          type: "toolCall" as const,
          id: `secret-call-${next}`,
          name: reply.name,
          arguments: reply.args,
        };
        message.content.push(call);
        output.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        output.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
        message.stopReason = "toolUse";
        output.push({ type: "done", reason: "toolUse", message });
      } else {
        message.content.push({ type: "text", text: reply.text });
        output.push({ type: "text_start", contentIndex: 0, partial: message });
        output.push({ type: "text_delta", contentIndex: 0, delta: reply.text, partial: message });
        output.push({ type: "text_end", contentIndex: 0, content: reply.text, partial: message });
        output.push({ type: "done", reason: "stop", message });
      }
      output.end(message);
    });
    return output;
  };
  const models = createModels();
  models.setProvider({
    ...provider.provider,
    streamSimple: stream as typeof provider.provider.streamSimple,
  });
  return models;
}
