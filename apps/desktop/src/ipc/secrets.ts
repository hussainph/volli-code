/** Person-only credential IPC. These channels have no verb or socket equivalent. */
import type { SecretMetadata, SecretRequestMetadata, SecretScope } from "@volli/shared";
export type { SecretMetadata, SecretRequestMetadata, SecretScope } from "@volli/shared";

export type SecretsResult =
  | { ok: true; requests: readonly SecretRequestMetadata[]; secrets: readonly SecretMetadata[] }
  | { ok: false; error: string };
export interface SecretSubmitInput {
  requestId: string;
  value: string;
  scope: SecretScope;
}
export interface SecretReplaceInput {
  id: string;
  value: string;
}
