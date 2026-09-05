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
 *   invalidates every block after it; the first attach to withhold it strips
 *   the lot and records that it did, so later attaches strip only up to the
 *   record and keep the reasoning bound to the stripped replay.
 *
 * And one place applies it as a recovery: a turn the provider refused for its
 * reasoning is retried once without any, under the same record.
 *
 * Pi's own message shape is what is edited, not the provider's. A Pi
 * `thinking` block carries `thinkingSignature` (or, when `redacted`, the opaque
 * payload in the same field); pi-ai serializes it to `thinking` or
 * `redacted_thinking` per API, and an unsigned one to plain text. Removing the
 * block here removes all three.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ReasoningDropCause, ReasoningDroppedObservation } from "@volli/shared";

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

/**
 * The diagnostic pi-ai records when Anthropic drops blocks from a request.
 *
 * Named here rather than imported because pi-ai types `AssistantMessageDiagnostic.type`
 * as a bare `string` — the value is a convention, not a union, so this is the
 * one place that convention is written down.
 */
const INPUT_TRANSFORMATIONS_DIAGNOSTIC = "anthropic_input_transformations";

/**
 * Volli's word for one of Anthropic's transformation types.
 *
 * The provider's vocabulary stops here. A type this build has not been taught
 * is `unknown` rather than a new string on a durable observation — the same
 * containment `ATTEMPT_STOP_REASONS` applies to stop reasons.
 */
function dropCause(type: string | undefined): ReasoningDropCause {
  if (type === undefined) return "unknown";
  if (type.includes("prefix")) return "prefix-mismatch";
  if (type.includes("model")) return "model-mismatch";
  return "unknown";
}

/**
 * What the provider silently dropped from this reply's request, if anything.
 *
 * Under the `thinking-binding-controls` beta a block bound to a prefix that has
 * since changed is no longer a 400 — pi-ai sends
 * `block_binding.prefix_mismatch_behavior: "drop_block"` for every
 * managed-effort model, so the block is dropped, the turn succeeds, and the
 * only record is a top-level `input_transformations` array that pi-ai appends
 * to the assistant message as a diagnostic (`anthropic-messages.js` ~606).
 *
 * Volli read `AssistantMessage.diagnostics` nowhere before this. That made the
 * drop completely invisible: no error, no failed turn, nothing on screen, and a
 * model answering with less reasoning than it had built up. This function is
 * the whole of the reading (VC-254).
 *
 * Returns nothing when there is nothing to say, which is the overwhelmingly
 * common case — every turn on every model without the flag, and every clean
 * turn on the models with it.
 */
export function reasoningDropped(
  message: AssistantMessage,
  turnId: string,
): ReasoningDroppedObservation | undefined {
  const transformations = message.diagnostics?.flatMap((diagnostic) =>
    diagnostic.type === INPUT_TRANSFORMATIONS_DIAGNOSTIC
      ? ((diagnostic.details?.["transformations"] as unknown[] | undefined) ?? [])
      : [],
  );
  if (transformations === undefined || transformations.length === 0) return undefined;

  const causes = new Set<ReasoningDropCause>();
  const paths: string[] = [];
  for (const entry of transformations) {
    const transformation = entry as { type?: unknown; path?: unknown };
    causes.add(
      dropCause(typeof transformation.type === "string" ? transformation.type : undefined),
    );
    if (typeof transformation.path === "string") paths.push(transformation.path);
  }
  return {
    kind: "reasoning-dropped",
    turnId,
    count: transformations.length,
    causes: [...causes],
    paths,
  };
}
