import type { HostError } from "../errors";
import { HOST_PROTOCOL_CLOSE_CODES } from "../handshake";

/** A terminal refusal or a host fault the link may retry. The compatibility
 * tag is client-local, never a new wire HostError reason. */
export type HandshakeFailure =
  | { readonly status: "fenced"; readonly error: HostError }
  | {
      readonly status: "refused" | "unreachable";
      readonly error: HostError;
      readonly closeCode: number | null;
      readonly compatibility?: "host-scope-unsupported";
    };

const FENCE_REASONS: ReadonlySet<string> = new Set([
  "workspace-epoch-fenced",
  "workspace-split-brain",
]);
const HANDSHAKE_REFUSALS: ReadonlySet<string> = new Set([
  "hello-invalid",
  "credential-invalid",
  "workspace-unknown",
  "protocol-version-unsupported",
  "welcome-invalid",
]);

/** Classify a server handshake refusal in the context of the attempted scope.
 * A valid host hello sent to the frozen pre-VC-722 listener is BAD_REQUEST /
 * hello-invalid (then 4400). Only that host-scope attempt means unsupported;
 * credential/Workspace errors and generic BAD_REQUEST must keep their meaning.
 * The Workspace link calls this today; PR B reuses the host classification. */
export function classifyHandshakeFailure(
  error: HostError,
  closeCode: number | null,
  scope: "workspace" | "host",
): HandshakeFailure {
  if (error.reason !== undefined && FENCE_REASONS.has(error.reason)) {
    return { status: "fenced", error };
  }
  if (error.reason !== undefined && HANDSHAKE_REFUSALS.has(error.reason)) {
    return {
      status: "refused",
      error,
      closeCode,
      ...(scope === "host" &&
      error.reason === "hello-invalid" &&
      error.code === "BAD_REQUEST" &&
      (closeCode === null || closeCode === HOST_PROTOCOL_CLOSE_CODES.handshakeRefused)
        ? { compatibility: "host-scope-unsupported" as const }
        : {}),
    };
  }
  return { status: "unreachable", error, closeCode };
}
