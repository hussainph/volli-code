/** Script only the provider; integration fixtures exercise Pi and actual tools. */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  createModels,
  fauxProvider,
  type AssistantMessage,
  type JsonObject,
  type Message,
} from "@earendil-works/pi-ai";

export interface ScriptedReply {
  tool?: { name: string; args: JsonObject };
  text?: string;
}
export function scriptedProvider(replies: ScriptedReply[]) {
  let call = 0;
  const requests: readonly Message[][] = [];
  const seen = requests as Message[][];
  const stream: StreamFn = (model, context) => {
    seen.push([...context.messages]);
    const reply = replies[call++];
    const output = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [],
      timestamp: call,
      stopReason: reply?.tool === undefined ? "stop" : "toolUse",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    output.push({ type: "start", partial: message });
    if (reply === undefined) {
      message.stopReason = "error";
      message.errorMessage = "Script exhausted";
      output.push({ type: "error", reason: "error", error: message });
    } else if (reply.tool !== undefined) {
      const toolCall = {
        type: "toolCall" as const,
        id: `scripted-call-${call}`,
        name: reply.tool.name,
        arguments: reply.tool.args,
      };
      message.content.push(toolCall);
      output.push({ type: "toolcall_start", contentIndex: 0, partial: message });
      output.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
      output.push({ type: "done", reason: "toolUse", message });
    } else {
      const text = reply.text ?? "Done";
      message.content.push({ type: "text", text });
      output.push({ type: "text_start", contentIndex: 0, partial: message });
      output.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      output.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
      output.push({ type: "done", reason: "stop", message });
    }
    output.end(message);
    return output;
  };
  const faux = fauxProvider({
    api: "anthropic-messages",
    provider: "scripted-fixture",
    models: [{ id: "scripted" }],
  });
  const models = createModels();
  models.setProvider({
    ...faux.provider,
    streamSimple: stream as typeof faux.provider.streamSimple,
  });
  return { models, requests };
}
