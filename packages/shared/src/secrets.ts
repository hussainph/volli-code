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

// --- Credential status: what a client is told about stored credentials -------
//
// Filled by host-core's secret store and sealed inventory, carried by a client's
// IPC contract, so a client names them without depending on host-core (VC-632).

/** Why a secret key could not be used. Each one has a fix a person can make. */
export type SecretKeyRefusal =
  /** The key file grants group or other users any access. */
  | "too-open"
  /** The key file belongs to another user. */
  | "wrong-owner"
  /** The key path names something other than a regular file. */
  | "not-a-file"
  /** The key file holds something other than one base64-encoded 32-byte key. */
  | "malformed"
  /** The key file could not be read or written. */
  | "unreadable"
  /**
   * The key file's filesystem cannot make hard links (some FUSE, s3fs and
   * container volumes), so Volli cannot create the key there atomically.
   */
  | "no-hard-links"
  /** Sealed secrets exist and their key file does not. */
  | "missing"
  /** The key file is not the key the secrets were sealed with. */
  | "wrong-key"
  /** The secrets were sealed by a different adapter (the macOS keychain). */
  | "other-adapter"
  /**
   * The key backend cannot open the key now: the OS keychain is locked,
   * denied access, unavailable, or no longer holds the key.
   */
  | "unavailable"
  /** `VOLLI_SECRET_KEY_FILE` is not an absolute path. */
  | "relative-path";

export type CredentialFamily =
  /** A person's Project or Always Session secret: an environment variable. */
  | "session-env"
  /** A web search provider's API key. */
  | "web-search"
  /** One MCP server's stored values and OAuth record, bound to its endpoint. */
  | "mcp"
  /** One model provider's Pi credential: an API key or an OAuth grant. */
  | "pi-provider"
  /** This host's own private key material (M2 pairing). */
  | "host-private"
  /** A paired device's verifier, bound to the host, workspace and device. */
  | "device-verifier"
  /** A worker's verifier, bound to the host, workspace and worker. */
  | "worker-verifier";

export type CredentialState = "ready" | "empty" | "locked" | "refused" | "corrupt";

/**
 * The kinds of credential a host keeps sealed under its key: the typed
 * inventory's families (host-core's `secrets/credential-families.ts`). The legacy Session store
 * gates `session-env` alone.
 */
export type CredentialKind = CredentialFamily;

/**
 * Why credentials are `locked` or `refused`: the key's refusal,
 * `store-unreadable` when the sealed file itself cannot be opened for reading,
 * or `newer-format` when it opened and a newer Volli wrote it (VC-642): this
 * build leaves it alone rather than rewrite a schema it does not know.
 */
export type CredentialReason =
  | SecretKeyRefusal
  | "store-unreadable"
  | "newer-format"
  /**
   * Another Volli process held the credential lock at that instant (VC-642).
   * Transient: reported for that one read, never remembered, never reset.
   */
  | "busy"
  /**
   * The key comes from an asynchronous backend (desktop's keychain, VC-643)
   * and has not been fetched yet this launch. Transient, like `busy`: never
   * remembered, never reset; fetching it is the way out.
   */
  | "key-pending"
  /**
   * The credential lock file cannot be used: a symlink, not a regular file,
   * another user's, or not lockable (VC-642). The store it guards may be
   * perfectly good, so it is fixed (moved aside), never reset.
   */
  | "lock-unusable";

export interface CredentialStatus {
  readonly state: CredentialState;
  /** Why credentials are `locked` or `refused`; `null` otherwise. */
  readonly reason: CredentialReason | null;
  /** What this state makes unavailable. Empty when `ready` or `empty`. */
  readonly unavailable: readonly CredentialKind[];
}

/**
 * The person-only credential door's answer: host-core's `SecretService`
 * fills it, and a client's IPC contract carries it.
 * `credentials` says whether stored secrets opened (VC-641): while they are
 * locked, `secrets` holds only the Session-scoped ones in memory.
 */
export type SecretsResult =
  | {
      ok: true;
      requests: readonly SecretRequestMetadata[];
      secrets: readonly SecretMetadata[];
      credentials: CredentialStatus;
    }
  | { ok: false; error: string };

/** The door's answer to an unlock or a reset (VC-641). */
export type CredentialsResult =
  | { ok: true; credentials: CredentialStatus }
  | { ok: false; error: string };
