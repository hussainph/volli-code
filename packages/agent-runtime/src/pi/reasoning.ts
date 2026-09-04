/**
 * The one edit this runtime ever makes to an assistant turn: dropping its
 * reasoning.
 *
 * A reasoning block is bound to everything sent before it. Anthropic's Claude
 * Fable 5.1 checks that binding on every request (preserved thinking): a
 * `thinking` block whose `signature` was produced against a different `system`
 * prompt, a different `tools` array, or different earlier messages is refused
 * with a 400, and the same request fails the same way however often it is
 * retried. The rule the doc gives is narrow — never keep a thinking block
 * behind a prefix you have rewritten — and it names exactly one repair: strip
 * every `thinking` and `redacted_thinking` block, keep each turn's `text` and
 * `tool_use`, and send the turn again.
 *
 * Two places in this runtime rewrite a prefix, and both apply this:
 *
 * - **A retained tail behind a compaction summary.** The kept turns' reasoning
 *   was produced against the history the summary replaced, so it fails behind
 *   it. `contextMessages` strips it from every compaction entry it expands.
 * - **A resume that could not reproduce the live array.** A settled reply the
 *   sidecar disagrees about is withheld from the middle of history, which
 *   invalidates every block after it; the attach strips the lot.
 *
 * And one place applies it as a recovery: a turn the provider refused for its
 * reasoning is retried once without any.
 *
 * Pi's own message shape is what is edited, not the provider's. A Pi
 * `thinking` block carries `thinkingSignature` (or, when `redacted`, the opaque
 * payload in the same field); pi-ai serializes it to `thinking` or
 * `redacted_thinking` per API, and an unsigned one to plain text. Removing the
 * block here removes all three.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * The same message with no reasoning in it.
 *
 * Returns the message it was handed — the same object — when there is nothing
 * to remove, so a context with no reasoning is untouched rather than copied,
 * and a caller comparing identity can tell the two apart.
 */
export function withoutReasoning(message: AgentMessage): AgentMessage {
  if (message.role !== "assistant") return message;
  const assistant = message as AssistantMessage;
  if (!assistant.content.some((block) => block.type === "thinking")) return message;
  return {
    ...assistant,
    content: assistant.content.filter((block) => block.type !== "thinking"),
  };
}
