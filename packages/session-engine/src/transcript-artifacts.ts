import type { TranscriptReference } from "@volli/shared";
import type { UIMessage } from "ai";

export const TRANSCRIPT_ARTIFACT_MEDIA_TYPE = "application/vnd.volli.ui-message+json";

export interface SessionTranscriptArtifact {
  version: 1;
  threadId: string;
  branchId: string;
  attemptId: string;
  turnId: string | null;
  message: UIMessage;
}

export interface TranscriptArtifactStore {
  write(artifact: SessionTranscriptArtifact): Promise<TranscriptReference>;
  read(reference: TranscriptReference): Promise<SessionTranscriptArtifact>;
  /**
   * The artifact's size as UTF-8 canonical JSON — what it adds to a frame on
   * the wire — read from what the store persisted beside the body, never by
   * reading the body (VC-315). A history window is selected from these sizes
   * and only then hydrated, so a body outside the window is never read and an
   * unreadable one outside it cannot fail the window.
   *
   * `null` when the store cannot say (the artifact is missing, or its size
   * metadata is unreadable): the window then treats the frame as too large to
   * join a window that already holds one, so it is read only on a page of its
   * own. Must not throw. A store without this method is measured by reading
   * each candidate body, as before VC-315.
   */
  byteLength?(reference: TranscriptReference): Promise<number | null>;
}

/**
 * JSON.stringify-compatible serialization with deterministic object-key order:
 * the bytes a transcript reference hashes. Defined once in `@volli/shared`, so
 * a cloud client staging a message body hashes exactly what this runtime does.
 */
export { transcriptCanonicalJson as canonicalJson } from "@volli/shared";
