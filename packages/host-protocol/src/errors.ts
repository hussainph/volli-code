import type { TRPC_ERROR_CODE_KEY } from "@trpc/server/rpc";

/**
 * The one error envelope every host operation fails with
 * (`docs/plans/host-protocol.md` § Errors).
 *
 * It is the shape both existing doors already agree on. The ipc-registry
 * envelope (`apps/desktop/src/main/ipc-registry.ts`) makes a failure cross the
 * wire as data with a message, never as a thrown string. The Session RPC
 * bridge (`SessionRpcIpcResponse` in `@volli/shared`) adds the `code`
 * that a caller branches on. The host protocol keeps both and adds one optional
 * `reason`, which names the host-specific case inside a code.
 */
export interface HostError {
  readonly code: HostErrorCode;
  readonly message: string;
  /** Absent when the code alone is the whole answer. */
  readonly reason?: HostErrorReason;
}

/** `{ ok: false, error }` beside `{ ok: true, data }`: the envelope a non-tRPC door answers with. */
export type HostResult<Data> =
  | { readonly ok: true; readonly data: Data }
  | { readonly ok: false; readonly error: HostError };

/**
 * The code vocabulary is tRPC's own key set. It is the one `@volli/session-rpc`
 * already throws and the one both links map to a `TRPCClientError`. It is written
 * out here so the guard has runtime values. The assertion below fails to compile
 * the day tRPC adds or drops a key.
 */
export const HOST_ERROR_CODES = [
  "PARSE_ERROR",
  "BAD_REQUEST",
  "INTERNAL_SERVER_ERROR",
  "NOT_IMPLEMENTED",
  "BAD_GATEWAY",
  "SERVICE_UNAVAILABLE",
  "GATEWAY_TIMEOUT",
  "UNAUTHORIZED",
  "PAYMENT_REQUIRED",
  "FORBIDDEN",
  "NOT_FOUND",
  "METHOD_NOT_SUPPORTED",
  "TIMEOUT",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "UNPROCESSABLE_CONTENT",
  "PRECONDITION_REQUIRED",
  "TOO_MANY_REQUESTS",
  "CLIENT_CLOSED_REQUEST",
] as const satisfies readonly TRPC_ERROR_CODE_KEY[];
export type HostErrorCode = (typeof HOST_ERROR_CODES)[number];
type AssertNever<Type extends never> = Type;
export type HostErrorCodeCoverage = AssertNever<Exclude<TRPC_ERROR_CODE_KEY, HostErrorCode>>;

/**
 * The host-specific cases, each pinned to the one code it travels under. A
 * client that does not know a reason still has the right code to act on.
 */
export const HOST_ERROR_REASON_CODES = {
  /** The hello's version range and the host's do not meet. */
  "protocol-version-unsupported": "PRECONDITION_FAILED",
  /** The hello is missing or malformed. */
  "hello-invalid": "BAD_REQUEST",
  /** The credential is missing, unknown, expired or revoked. */
  "credential-invalid": "UNAUTHORIZED",
  /**
   * The host has no such workspace, or the credential does not grant it. One
   * reason for both, so a guess cannot learn that a workspace exists (VC-320 C01).
   */
  "workspace-unknown": "NOT_FOUND",
  /** This host's workspace epoch is older than one the client has seen: it was fenced. */
  "workspace-epoch-fenced": "PRECONDITION_FAILED",
  /** Two hosts claim the same workspace epoch: a restore copied a host, or a move was not fenced. */
  "workspace-split-brain": "CONFLICT",
  /** A worker wrote under a checkout lease epoch the host has since moved past. */
  "lease-epoch-fenced": "PRECONDITION_FAILED",
  /** The actor's verb policy refuses this operation (VC-92). */
  "verb-refused": "FORBIDDEN",
  /** The same idempotency key was already accepted with a different intent. */
  "command-conflict": "CONFLICT",
  /** A subscription's bounded queue dropped frames; resume from the last event id. */
  "subscription-overflow": "TOO_MANY_REQUESTS",
  /** A subscription's source failed; resume from the last event id. */
  "subscription-source-failed": "INTERNAL_SERVER_ERROR",
  /** The host does not serve this operation (an unconfigured facade or a missing feature). */
  "operation-unavailable": "NOT_IMPLEMENTED",
} as const satisfies Record<string, HostErrorCode>;
export type HostErrorReason = keyof typeof HOST_ERROR_REASON_CODES;

/** Builds the envelope for a reason, so a reason can never travel under the wrong code. */
export function hostError(reason: HostErrorReason, message: string): HostError {
  return { code: HOST_ERROR_REASON_CODES[reason], message, reason };
}

export function isHostErrorCode(value: unknown): value is HostErrorCode {
  return typeof value === "string" && (HOST_ERROR_CODES as readonly string[]).includes(value);
}

export function isHostErrorReason(value: unknown): value is HostErrorReason {
  return typeof value === "string" && Object.hasOwn(HOST_ERROR_REASON_CODES, value);
}

export function isHostError(value: unknown): value is HostError {
  if (!isRecord(value) || !isHostErrorCode(value.code) || typeof value.message !== "string") {
    return false;
  }
  if (value.reason === undefined) return true;
  return isHostErrorReason(value.reason) && HOST_ERROR_REASON_CODES[value.reason] === value.code;
}

/**
 * Reads the envelope back out of whatever a client was handed. Three shapes are
 * accepted: a `HostError`; a tRPC error whose formatter attached one at
 * `data.hostError`; and a tRPC error that carries only `data.code`, which is
 * what both of today's links produce. Anything else is
 * `INTERNAL_SERVER_ERROR` with the best message on offer, because a failure
 * must never be lost on the way to a person.
 */
export function readHostError(error: unknown): HostError {
  if (isHostError(error)) return copyHostError(error);
  const data = isRecord(error) && isRecord(error.data) ? error.data : null;
  if (data !== null && isHostError(data.hostError)) return copyHostError(data.hostError);
  const message =
    isRecord(error) && typeof error.message === "string" ? error.message : "Host request failed";
  return {
    code: data !== null && isHostErrorCode(data.code) ? data.code : "INTERNAL_SERVER_ERROR",
    message,
  };
}

/** Field by field: a server-side `TRPCError` passes the guard, and spreading an Error drops its message. */
function copyHostError({ code, message, reason }: HostError): HostError {
  return reason === undefined ? { code, message } : { code, message, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
