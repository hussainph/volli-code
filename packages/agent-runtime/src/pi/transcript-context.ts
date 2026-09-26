/**
 * The attachment's prompt and tools as Pi's transcript now carries them.
 *
 * Pi 0.86 moved the system prompt and the tool declarations INTO the message
 * list: a request is a `TranscriptContext` whose leading system message holds
 * both, later system messages carry prompt additions and tool deltas, and
 * `AgentState.systemPrompt` became a read-only replay of those messages. The
 * `Agent` seeds that leading message itself from `initialState.systemPrompt`
 * and `tools` — but only when the messages it is handed do not already begin
 * with one, and only at construction. Every later replacement of the live
 * array (a compaction, a model switch) is this runtime's, and an array
 * replaced without its head is a Session whose prompt is silently gone: Pi
 * would replay an empty prompt, declare every tool again in a bare system
 * message, and carry on. So the head is built once here, in the open, and
 * put back by hand wherever the array is rebuilt from the sidecar.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { toToolDeclaration, type SystemMessage, type Tool } from "@earendil-works/pi-ai";

/**
 * The leading system message one attachment's prompt and tools become.
 *
 * PI-RESTATED(0.87.1): pi-ai's `createInitialSystemMessage`, for a prompt that
 * is never empty. The shape is Pi's exactly — `timestamp: 0`, declarations
 * stripped to what the model sees, `toolsAdded` absent rather than empty — so
 * the head this runtime prepends is byte-identical to the one the `Agent`
 * would have seeded, and a resume reproduces the prefix the previous
 * attachment sent. Restated rather than called because Pi's returns
 * `undefined` for an empty prompt with no tools, an arm Volli's composed
 * prompt makes unreachable; a test pins the two against each other.
 */
export function systemHead(systemPrompt: string, tools: readonly Tool[]): SystemMessage {
  return {
    role: "system",
    content: systemPrompt,
    ...(tools.length > 0 ? { toolsAdded: tools.map(toToolDeclaration) } : {}),
    timestamp: 0,
  };
}

/**
 * A sidecar-derived conversation behind the attachment's head.
 *
 * The sidecar never holds the head: it is composed per attachment from the
 * Role, bundle and resources, and recomposed on every attach, so what is on
 * disk is the conversation and the tool-change system messages Pi emitted
 * into it. Those later ones stay exactly where they were; only the leading
 * message is this runtime's to supply.
 */
export function withSystemHead(
  head: SystemMessage,
  conversation: readonly AgentMessage[],
): AgentMessage[] {
  return [head, ...conversation];
}

/**
 * Whether nothing has been said yet.
 *
 * `messages.length === 0` stopped meaning that when the head moved into the
 * array: a fresh Session holds one message before anyone types. The question
 * the Brief composition asks is whether the CONVERSATION is empty, and a
 * transcript that is all system messages — the head, or the head plus a tool
 * delta Pi declared ahead of the first prompt — is one nobody has spoken in.
 */
export function conversationIsEmpty(messages: readonly AgentMessage[]): boolean {
  return messages.every((message) => message.role === "system");
}

/**
 * The conversation without its system messages, for a request that carries the
 * prompt and tools in fields of its own.
 *
 * Both native compaction endpoints do: OpenAI's `/responses/compact` takes
 * `instructions`, Anthropic's takes `system` and `tools`. A system message left
 * in the list would either duplicate the prompt as a developer item or, in the
 * Anthropic conversion, fall through the role switch as a tool result with no
 * call id — and the prompt and tools they carry are already on the request.
 */
export function withoutSystemMessages<T extends { role: string }>(
  messages: readonly T[],
): Exclude<T, { role: "system" }>[] {
  return messages.filter(
    (message): message is Exclude<T, { role: "system" }> => message.role !== "system",
  );
}
