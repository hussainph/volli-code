import type { ToolResultMessage } from "@earendil-works/pi-ai";

/**
 * Anthropic permits only text when `is_error` is true. Keep a failed call's
 * images useful to the model by expressing failure in text instead of that
 * wire flag. Request projection only: the sidecar and activity keep isError.
 * Applying this on every request also repairs replay of already-stored results.
 */
export function anthropicSafeToolResult(message: ToolResultMessage): ToolResultMessage {
  if (!message.isError || message.content.every((block) => block.type === "text")) return message;
  return {
    ...message,
    isError: false,
    content: [{ type: "text", text: "The tool call failed." }, ...message.content],
  };
}
