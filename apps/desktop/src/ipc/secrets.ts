/** Person-only credential IPC. These channels have no verb or socket equivalent. */
export type SecretScope = "session" | "project" | "always";
export interface SecretMetadata {
  id: string;
  name: string;
  scope: SecretScope;
  sessionId?: string;
  projectId?: string;
  lastUsedAt: number | null;
}
export interface SecretRequestMetadata {
  id: string;
  name: string;
  sessionId: string;
  sessionLabel: string;
  projectId: string;
  projectLabel: string;
  /** Untrusted agent prose; never the title or controls of a credential card. */
  agentSays: string | null;
}
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
