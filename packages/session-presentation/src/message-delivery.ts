import type { ChatSessionFrame } from "./transcript";

export type MessageDeliveryLabel =
  | "Pending"
  | "Delivered"
  | "Not delivered"
  | "Delivery unconfirmed";

/** Durable intent is not acceptance. Only a receipt or runtime transcript
 * observation proves delivery. A refusal after work started is ambiguous. */
export function messageDeliveryLabels(
  frames: readonly ChatSessionFrame[],
): ReadonlyMap<string, MessageDeliveryLabel> {
  const labels = new Map<string, MessageDeliveryLabel>();
  const commands = new Map<string, { messageId: string; sequence: number }>();
  let lastTurnStarted = -1;
  for (const frame of frames) {
    const payload = frame.event?.payload;
    const message = frame.transcript?.message;
    if (
      payload?.kind === "command.recorded" &&
      payload.command.intent.kind === "message.submit" &&
      message?.role === "user"
    ) {
      commands.set(payload.command.id, { messageId: message.id, sequence: frame.sequence });
      labels.set(message.id, "Pending");
    } else if (payload?.kind === "transcript.referenced" && message?.role === "user") {
      labels.set(message.id, "Delivered");
    }
    if (payload?.kind === "command.receipt.recorded") {
      const command = commands.get(payload.receipt.commandId);
      if (command !== undefined) {
        const id = command.messageId;
        labels.set(
          id,
          labels.get(id) === "Delivered" ||
            payload.receipt.status === "accepted" ||
            payload.receipt.status === "completed"
            ? "Delivered"
            : payload.receipt.status === "rejected" && lastTurnStarted < command.sequence
              ? "Not delivered"
              : "Delivery unconfirmed",
        );
      }
    } else if (payload?.kind === "turn.started") {
      lastTurnStarted = frame.sequence;
    }
  }
  return labels;
}
