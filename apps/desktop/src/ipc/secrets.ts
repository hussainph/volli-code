/** Person-only credential IPC. These channels have no verb or socket equivalent. */
import type { SecretScope } from "@volli/shared";
export type { SecretMetadata, SecretRequestMetadata, SecretScope } from "@volli/shared";

/** The door's answer type; defined beside the service that fills it (VC-622). */
export type {
  CredentialsResult,
  CredentialStatus,
  SecretsResult,
} from "@volli/host-core/secrets/service";
export interface SecretSubmitInput {
  requestId: string;
  value: string;
  scope: SecretScope;
}
export interface SecretReplaceInput {
  id: string;
  value: string;
}
