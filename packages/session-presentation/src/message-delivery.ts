import type { ChatSessionFrame } from "./transcript";

export type MessageDeliveryLabel = "Pending" | "Delivered" | "Not delivered";

/** Durable intent is not acceptance. A turn start, accepted receipt or runtime
 * transcript observation is proof; a rejected receipt never says Delivered. */
export function messageDeliveryLabels(
  frames: readonly ChatSessionFrame[],
): ReadonlyMap<string, MessageDeliveryLabel> {
  const labels = new Map<string, MessageDeliveryLabel>();
  const commands = new Map<string, string>();
  for (const frame of frames) {
    const payload = frame.event?.payload;
    const message = frame.transcript?.message;
    if (
      payload?.kind === "command.recorded" &&
      payload.command.intent.kind === "message.submit" &&
      message?.role === "user"
    ) {
      commands.set(payload.command.id, message.id);
      labels.set(message.id, "Pending");
    } else if (payload?.kind === "transcript.referenced" && message?.role === "user") {
      labels.set(message.id, "Delivered");
    }
    if (payload?.kind === "command.receipt.recorded") {
      const id = commands.get(payload.receipt.commandId);
      if (id !== undefined) {
        labels.set(
          id,
          payload.receipt.status === "accepted" || payload.receipt.status === "completed"
            ? "Delivered"
            : payload.receipt.status === "rejected"
              ? "Not delivered"
              : "Pending",
        );
      }
    } else if (payload?.kind === "turn.started") {
      const id = commands.get(frame.event!.commandId ?? "");
      if (id !== undefined) labels.set(id, "Delivered");
    }
  }
  return labels;
}
