/**
 * The host's key-provider port for sign-ins (VC-702; hosted guardrail 3).
 *
 * Where a host keeps what a person sends it: a model API key, into the host's
 * own Pi auth storage, and a git push credential, into a store Volli's
 * credential helper reads. host-core names the port and never a location;
 * hostd composes files under its data directory (0600, the service user's),
 * and a hosted control plane composes its own key service in the same shape.
 *
 * Write-only from a Client's side. `get` exists for the credential helper
 * alone, which answers git on this host, never a protocol read.
 */

/** A git push credential: what git sends as user and password over HTTPS. */
export interface GitCredential {
  readonly username: string;
  readonly password: string;
}

/** Push credentials, one per git remote host (`github.com`, `git.example.com:8443`). */
export interface GitCredentialStore {
  /** The hosts that hold a credential: availability only. */
  hosts(): Promise<readonly string[]>;
  /** The credential for one host, for the credential helper; null when none. */
  get(host: string): Promise<GitCredential | null>;
  /** Stores or replaces one host's credential. */
  set(host: string, credential: GitCredential): Promise<void>;
  /** Removes one host's credential; nothing when it held none. */
  clear(host: string): Promise<void>;
}

/** One stored model credential, as availability: never its value. */
export interface StoredModelCredential {
  readonly providerId: string;
  readonly type: "api-key" | "oauth";
  /** An OAuth access token's expiry (ms since epoch), or null for a key. */
  readonly expiresAt: number | null;
}

/** Model credentials, in the host's Pi auth storage. */
export interface ModelCredentialStore {
  setApiKey(providerId: string, key: string): Promise<void>;
  stored(): Promise<readonly StoredModelCredential[]>;
}

export interface HostSignInKeyProvider {
  readonly models: ModelCredentialStore;
  readonly git: GitCredentialStore;
}
