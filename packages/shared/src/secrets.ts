/** Transport-neutral, metadata-only credential vocabulary. Values are never Session data. */
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
