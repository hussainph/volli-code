import type { AgentRuntime, RuntimeObservation, SessionRuntimeSpec } from "@volli/shared";
import { createModels } from "pi-durable-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "pi-durable-ai/providers/faux";

export const fallback: AgentRuntime = {
  inspectModelAccess: async () => {
    throw new Error("Not used by fixture");
  },
  completeUtility: async () => {
    throw new Error("Not used by fixture");
  },
  startSession: async () => {
    throw new Error("Default runtime sentinel");
  },
};
export function fixtureSpec(
  workspacePath: string,
  observer: (o: RuntimeObservation) => Promise<void>,
): SessionRuntimeSpec {
  return {
    identity: {
      role: "ticket",
      sessionId: "session-497",
      rootThreadId: "thread-497",
      attachmentId: "attachment-497",
      projectId: "project",
      ticketId: "VC-497",
    },
    workspacePath,
    venue: "local",
    model: { providerId: "faux", modelId: "spike", reasoningLevel: "off" },
    tools: { tools: ["read", "write"], verbs: [] },
    brief: { text: "Durability fixture" },
    observer,
  };
}
export function fixtureModels(scenario: string, first = false) {
  const faux = fauxProvider({
    models: [{ id: "spike", contextWindow: 200_000, maxTokens: 4096 }],
    ...(scenario === "stream" && first
      ? { tokensPerSecond: 30, tokenSize: { min: 3, max: 3 } }
      : {}),
  });
  faux.setResponses(
    Array.from({ length: 10 }, () => (transcript) => {
      if (scenario === "stream")
        return fauxAssistantMessage(
          first ? "partial before crash ".repeat(100) : "resumed stream answer",
        );
      const last = transcript.messages.at(-1);
      if (last?.role === "toolResult")
        return fauxAssistantMessage(
          `observed result: ${last.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")}`,
        );
      const write = scenario === "unsafe";
      return fauxAssistantMessage(
        fauxToolCall(
          write ? "write" : "read",
          write ? { path: "effect.txt", content: "one external effect" } : { path: "input.txt" },
          { id: "fixture-call" },
        ),
        { stopReason: "toolUse" },
      );
    }),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, faux };
}
