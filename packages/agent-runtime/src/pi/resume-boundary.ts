/**
 * Where a recovered conversation stands, and how a resume answers a tool call
 * the lost process left without a result (VC-450).
 *
 * Pi appends the assistant reply that asks for tools BEFORE it runs them, and
 * each tool result only once that tool has finished. So a sidecar that ends on
 * a reply whose calls are not all answered is a process that died with a tool
 * in flight — and whether that bash command, write or browser action ran,
 * partly ran or never started is unknowable from here. A host must not
 * continue such a turn on its own; a person who asks to resume it gets the
 * call answered as interrupted, so the model is told the truth instead of
 * guessing, and nothing runs again unless the model decides to run it.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

import type { RuntimeResumeBoundary } from "@volli/shared";

/** What a recovered `ask_user` call is answered with: nobody was asked to answer it. */
export const ABANDONED_QUESTION_RESULT =
  "The question was abandoned when the runtime restarted. No answer was obtained.";

/** What a resumed tool call the lost process left without a result is answered with. */
export const INTERRUPTED_TOOL_RESULT =
  "This tool call was interrupted when the runtime restarted, so its result was lost. It may have run, partly run, or not run at all: check its effects before repeating it.";

/** The tool calls the conversation's last reply made, and the results after it. */
interface TrailingTools {
  /** The calls the last reply made that nothing answered, in call order. */
  readonly unanswered: readonly { readonly id: string; readonly name: string }[];
  /** The results that follow the last reply. */
  readonly results: readonly ToolResultMessage[];
}

/**
 * The last reply's calls and the results after it, or null when the
 * conversation does not end on a reply that asked for tools: a failed reply
 * ran none of its calls, and is the transport retry's to drop.
 */
function trailingTools(
  messages: readonly AgentMessage[],
  failedReply: (message: AssistantMessage) => boolean,
): TrailingTools | null {
  let index = messages.length - 1;
  const results: ToolResultMessage[] = [];
  while (index >= 0 && messages[index]!.role === "toolResult") {
    results.unshift(messages[index] as ToolResultMessage);
    index -= 1;
  }
  const reply = messages[index];
  if (reply?.role !== "assistant" || failedReply(reply as AssistantMessage)) return null;
  const answered = new Set(results.map(({ toolCallId }) => toolCallId));
  const unanswered = (reply as AssistantMessage).content.flatMap((block) =>
    block.type === "toolCall" && !answered.has(block.id)
      ? [{ id: block.id, name: block.name }]
      : [],
  );
  return { unanswered, results };
}

/**
 * Where an idle conversation stands. Failed replies are never replayed into a
 * recovered conversation, and a live one drops its own before it retries, so
 * one at the tail is the transport retry's settled point, not a tool in flight.
 */
export function resumeBoundary(
  messages: readonly AgentMessage[],
  failedReply: (message: AssistantMessage) => boolean,
): RuntimeResumeBoundary {
  const tail = messages.at(-1);
  if (tail?.role === "user") return "settled";
  if (tail?.role === "assistant" && failedReply(tail as AssistantMessage)) return "settled";
  const tools = trailingTools(messages, failedReply);
  if (tools === null) return "none";
  if (tools.unanswered.length > 0) return "tool-in-flight";
  if (tools.results.length === 0) return "none";
  return tools.results.some(abandonedQuestion) ? "tool-in-flight" : "settled";
}

/**
 * The results a resume answers the unanswered calls with, or none. Only the
 * calls of the LAST reply can be unanswered: Pi does not ask the model again
 * until every call of a reply has its result.
 */
export function interruptedToolResults(
  messages: readonly AgentMessage[],
  failedReply: (message: AssistantMessage) => boolean,
  now: number,
): ToolResultMessage[] {
  return (trailingTools(messages, failedReply)?.unanswered ?? []).map(({ id, name }) => ({
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT }],
    isError: true,
    timestamp: now,
  }));
}

function abandonedQuestion(result: ToolResultMessage): boolean {
  return (
    result.isError &&
    result.content.some(
      (block) => block.type === "text" && block.text === ABANDONED_QUESTION_RESULT,
    )
  );
}
