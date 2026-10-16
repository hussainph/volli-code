import type { SessionEventPayload } from "@volli/shared";

/** A done signal is not an executor close: a live attachment can receive another turn. */
export function retiresSessionSecrets(payload: SessionEventPayload): boolean {
  return payload.kind === "attachment.closed";
}
