/** Person-only credential IPC. These channels have no verb or socket equivalent. */
import type { SecretScope } from "@volli/shared";
export type { SecretMetadata, SecretRequestMetadata, SecretScope } from "@volli/shared";

/** The door's answer types: client wire vocabulary in `@volli/shared` (VC-632), never host-core. */
export type { CredentialsResult, CredentialStatus, SecretsResult } from "@volli/shared";
/** Expiry is distinct from a retryable save failure; older clients ignore the optional flag. */
export type SecretRequestResult = { ok: true } | { ok: false; error: string; expired?: boolean };

export interface SecretSubmitInput {
  requestId: string;
  value: string;
  scope: SecretScope;
}
export interface SecretReplaceInput {
  id: string;
  value: string;
}
