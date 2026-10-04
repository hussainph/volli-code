import type { TRPC_ERROR_CODE_KEY } from "@trpc/server/rpc";

/** Client-visible failure: IPC result shape plus tRPC code and optional reason. */
export interface HostError {
  readonly code: HostErrorCode;
  readonly message: string;
  readonly reason?: HostErrorReason;
}

/** `{ ok: false, error }` beside `{ ok: true, data }`: the envelope a non-tRPC door answers with. */
export type HostResult<Data> =
  | { readonly ok: true; readonly data: Data }
  | { readonly ok: false; readonly error: HostError };

/** tRPC codes; HostErrorCodeCoverage fails if an upstream key is missing. */
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

/** Host-specific reasons, each pinned to one tRPC code. */
export const HOST_ERROR_REASON_CODES = {
  "protocol-version-unsupported": "PRECONDITION_FAILED",
  "hello-invalid": "BAD_REQUEST",
  "credential-invalid": "UNAUTHORIZED",
  "workspace-unknown": "NOT_FOUND",
  "workspace-epoch-fenced": "PRECONDITION_FAILED",
  "workspace-split-brain": "CONFLICT",
  "lease-epoch-fenced": "PRECONDITION_FAILED",
  "verb-refused": "FORBIDDEN",
  "command-conflict": "CONFLICT",
  "subscription-overflow": "TOO_MANY_REQUESTS",
  "subscription-resnapshot-required": "PRECONDITION_FAILED",
  "subscription-source-failed": "INTERNAL_SERVER_ERROR",
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

/** Read a HostError, data.hostError, or legacy data.code failure on either link. */
export function readHostError(error: unknown): HostError {
  const data = isRecord(error) && isRecord(error.data) ? error.data : null;
  for (const envelope of [data?.hostError, error]) {
    if (isHostError(envelope)) return copyHostError(envelope);
    // Additive reason names must not hide a code this client already knows.
    if (
      isRecord(envelope) &&
      isHostErrorCode(envelope.code) &&
      typeof envelope.message === "string"
    ) {
      return { code: envelope.code, message: envelope.message };
    }
  }
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
