import { readSessionOrigin, type SessionOrigin } from "@volli/shared";
import type { UIMessage } from "ai";
import type { ChatSessionFrame } from "./transcript";

/**
 * Authorship comes from the submitted command's trusted door, not the provider
 * role or prose. Runtime observations can repeat a submitted message but their
 * adapter provenance says who recorded it, not who authored it. A history
 * window without the original command therefore stays unknown.
 */
export function transcriptMessageOrigins(
  frames: readonly ChatSessionFrame[],
): ReadonlyMap<string, SessionOrigin | null> {
  const origins = new Map<string, SessionOrigin | null>();
  for (const frame of frames) {
    const event = frame.event;
    const message = frame.transcript?.message;
    if (
      event?.payload.kind !== "command.recorded" ||
      event.payload.command.intent.kind !== "message.submit" ||
      message?.role !== "user"
    ) {
      continue;
    }
    const detail = event.provenance.source.detail;
    const origin = readSessionOrigin(
      typeof detail === "object" && detail !== null && !Array.isArray(detail)
        ? (detail as Readonly<Record<string, unknown>>).sessionOrigin
        : undefined,
    );
    // Contradictory records cannot establish a trusted author. No text or
    // temporal-neighbour join is used to fill in missing attribution.
    if (
      origins.has(message.id) &&
      JSON.stringify(origins.get(message.id)) !== JSON.stringify(origin)
    ) {
      origins.set(message.id, null);
    } else if (!origins.has(message.id)) {
      origins.set(message.id, origin);
    }
  }
  // Hydration can retain an adapter observation after the original command
  // falls outside the bounded tail. Explicitly index that missing authorship;
  // notice metadata and message ids are never independent producer evidence.
  for (const frame of frames) {
    const message = frame.transcript?.message;
    if (message?.role === "user" && !origins.has(message.id)) origins.set(message.id, null);
  }
  return origins;
}

export interface TranscriptMessageAttribution {
  label: string | null;
  sessionId: string | null;
}

/** No delivery mode survives in message.submit intent: person-authored alone never means steered. */
export function transcriptMessageAttribution(
  message: UIMessage,
  origin: SessionOrigin | null | undefined,
  sessionNames?: ReadonlyMap<string, string>,
): TranscriptMessageAttribution {
  const plain = { label: null, sessionId: null };
  if (message.role !== "user") return plain;
  if (origin?.kind === "user") return plain;
  if (origin?.kind === "session") {
    // A Session-origin kickoff preserves caller text unchanged, including a
    // quoted supervision marker. Existing submitted facts do not distinguish
    // that from session_send, so keep all prose and never infer "steered".
    return {
      label: `Message from ${sessionNames?.get(origin.sessionId) ?? "another Session"}`,
      sessionId: origin.sessionId,
    };
  }
  if (origin?.kind === "automation") {
    return {
      ...plain,
      label:
        origin.automationName === null
          ? "Message from an Automation"
          : `Message from ${origin.automationName}`,
    };
  }
  if (origin?.kind === "volli") return { ...plain, label: "Message from Volli" };
  return { ...plain, label: "Message" };
}
