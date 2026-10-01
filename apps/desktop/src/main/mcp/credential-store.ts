/**
 * Where MCP credentials rest: one user-only file beside the profile database
 * (VC-470).
 *
 * WHY A FILE, AND NOT THE KEYCHAIN OR THE DATABASE. The database is out by the
 * ticket's own rule — a token must never reach the project database, a backup
 * bundle, `mcp_operations`, an audit record or a transcript, and the database
 * is what backups copy. The keychain is out by this repository's own finding
 * (`docs/research/env-credential-ux-architecture-review.md`): Electron's
 * `safeStorage` raised a macOS prompt on every access whenever the build's
 * signature had changed, guarded little, and was removed from Web Access for
 * exactly that reason. What every peer does — Pi's `auth.json` and
 * `mcp-auth.json`, opencode, Codex — is a file readable only by the user, and
 * that is this: `mcp-credentials.json`, mode 0600, written whole and renamed
 * into place so a crash mid-write leaves the previous file rather than half of
 * a new one. Backups exclude it by name (`backup/decisions.ts`).
 *
 * WHAT IT HOLDS, per server id:
 * - `secrets` — values a person typed into Settings, by slot
 *   (`header:authorization`, `env:API_KEY`, `oauth:client-secret`).
 * - `oauth` — what pi-mcp's OAuth client persists: the dynamic client
 *   registration, the tokens and their expiry, the discovered metadata. Never
 *   the PKCE verifier or the `state` of a sign-in in progress: those live in
 *   the memory of the one sign-in that minted them, so a background connection
 *   that is refused cannot overwrite the verifier of a sign-in a person is
 *   halfway through in the browser.
 * - `signInRequired` — that the server refused a connection for want of
 *   authorization, with the challenge it gave. Not a credential, but auth state
 *   with the same lifetime, and keeping it here means the database schema does
 *   not move for it.
 *
 * Nothing here is ever logged, and no error this module raises quotes a value.
 */
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

/** pi-mcp's persisted OAuth state, minus the two fields that live only in memory. */
export interface McpStoredOAuthState {
  serverUrl: string;
  clientInformation?: Record<string, unknown> & { client_id: string };
  tokens?: Record<string, unknown> & { access_token: string; token_type: string };
  tokensExpireAt?: number;
  discovery?: Record<string, unknown> & { authorizationServerUrl: string };
}

/** The last authorization refusal a server gave, kept until a person signs in. */
export interface McpSignInRequirement {
  /** Epoch ms of the refusal. */
  at: number;
  /**
   * The endpoint that refused. A requirement recorded against another URL —
   * an agent previewing a different endpoint under the same id, say — says
   * nothing about this one, and is ignored.
   */
  serverUrl: string;
  /** The server asked for scope the grant lacks (403 `insufficient_scope`). */
  insufficientScope: boolean;
  /** The scope the challenge named, when it named one. */
  scope?: string;
  /** The `resource_metadata` URL the challenge named, when it named one. */
  resourceMetadataUrl?: string;
}

export interface McpServerCredentialRecord {
  secrets?: Readonly<Record<string, string>>;
  oauth?: McpStoredOAuthState;
  signInRequired?: McpSignInRequirement;
}

/** The store every MCP credential reader and writer goes through. */
export interface McpCredentialStore {
  read(serverId: string): McpServerCredentialRecord | undefined;
  /** Replace one server's record with whatever `change` returns; `undefined` deletes it. */
  update(
    serverId: string,
    change: (
      current: McpServerCredentialRecord | undefined,
    ) => McpServerCredentialRecord | undefined,
  ): void;
  delete(serverId: string): void;
  /**
   * A counter that moves whenever a server's SECRETS change — not its tokens.
   *
   * An attachment that opened a client with yesterday's environment value asks
   * this before each call and reopens when it moved, which is how a running
   * Session picks up a value a person just stored without being reattached.
   * Tokens are deliberately not counted: they are read per request already,
   * and a refresh must not tear down a working connection.
   */
  revision(serverId: string): number;
}

interface StoreFile {
  version: 1;
  servers: Record<string, McpServerCredentialRecord>;
}

function emptyRecord(record: McpServerCredentialRecord): boolean {
  return (
    (record.secrets === undefined || Object.keys(record.secrets).length === 0) &&
    record.oauth === undefined &&
    record.signInRequired === undefined
  );
}

function sameSecrets(
  left: McpServerCredentialRecord | undefined,
  right: McpServerCredentialRecord | undefined,
): boolean {
  return JSON.stringify(left?.secrets ?? {}) === JSON.stringify(right?.secrets ?? {});
}

/** Shared bookkeeping for both stores: records, revisions, and the empty-record rule. */
abstract class RecordStore implements McpCredentialStore {
  readonly #revisions = new Map<string, number>();

  protected abstract records(): Record<string, McpServerCredentialRecord>;
  protected abstract persist(records: Record<string, McpServerCredentialRecord>): void;

  read(serverId: string): McpServerCredentialRecord | undefined {
    const record = this.records()[serverId];
    return record === undefined ? undefined : structuredClone(record);
  }

  update(
    serverId: string,
    change: (
      current: McpServerCredentialRecord | undefined,
    ) => McpServerCredentialRecord | undefined,
  ): void {
    const records = this.records();
    const current = records[serverId];
    const next = change(current === undefined ? undefined : structuredClone(current));
    const kept = next === undefined || emptyRecord(next) ? undefined : structuredClone(next);
    // Nothing changed: no write. A save or refresh that touches no credential
    // must not depend on the file being writable.
    if (JSON.stringify(kept) === JSON.stringify(current)) return;
    const updated = { ...records };
    if (kept === undefined) delete updated[serverId];
    else updated[serverId] = kept;
    this.persist(updated);
    if (!sameSecrets(current, kept)) {
      this.#revisions.set(serverId, this.revision(serverId) + 1);
    }
  }

  delete(serverId: string): void {
    this.update(serverId, () => undefined);
  }

  revision(serverId: string): number {
    return this.#revisions.get(serverId) ?? 0;
  }
}

/** Process memory only: tests, and a launch without a profile directory. */
export class MemoryMcpCredentialStore extends RecordStore {
  #records: Record<string, McpServerCredentialRecord> = {};

  protected records(): Record<string, McpServerCredentialRecord> {
    return this.#records;
  }

  protected persist(records: Record<string, McpServerCredentialRecord>): void {
    this.#records = records;
  }
}

/** The credential file's name, beside the profile database. */
export const MCP_CREDENTIAL_FILE_NAME = "mcp-credentials.json";

/** The file permissions the credential file is written with and held to. */
export const MCP_CREDENTIAL_FILE_MODE = 0o600;

/**
 * The user-only file store.
 *
 * Synchronous on purpose: the file is a few kilobytes, writes are rare (a
 * sign-in, a token refresh, a person saving a secret), and a synchronous
 * read-modify-write cannot interleave with another one in the same process —
 * which an async chain would have to be built to guarantee.
 *
 * A file this build cannot read is moved aside to `<file>.unreadable` rather
 * than overwritten, and the store starts empty: the person signs in or stores
 * the value again, and nothing they had is destroyed by Volli failing to parse
 * it. The warning names the file, never its contents.
 */
export class FileMcpCredentialStore extends RecordStore {
  readonly #path: string;
  #cache: Record<string, McpServerCredentialRecord> | null = null;

  constructor(path: string) {
    super();
    this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  protected records(): Record<string, McpServerCredentialRecord> {
    if (this.#cache !== null) return this.#cache;
    this.#cache = this.#load();
    return this.#cache;
  }

  protected persist(records: Record<string, McpServerCredentialRecord>): void {
    const file: StoreFile = { version: 1, servers: records };
    const temporary = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, {
      mode: MCP_CREDENTIAL_FILE_MODE,
    });
    // A umask can only narrow the mode `writeFileSync` asked for; chmod pins it
    // exactly, in case the temporary name already existed with wider bits.
    chmodSync(temporary, MCP_CREDENTIAL_FILE_MODE);
    renameSync(temporary, this.#path);
    this.#cache = records;
  }

  #load(): Record<string, McpServerCredentialRecord> {
    // One open file, checked and read through the same descriptor: no window
    // in which the path could be swapped between the check and the read.
    let fd: number;
    try {
      fd = openSync(this.#path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    try {
      if ((fstatSync(fd).mode & 0o077) !== 0) fchmodSync(fd, MCP_CREDENTIAL_FILE_MODE);
      const parsed = JSON.parse(readFileSync(fd, "utf8")) as unknown;
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        (parsed as Partial<StoreFile>).version !== 1 ||
        (parsed as Partial<StoreFile>).servers === null ||
        typeof (parsed as Partial<StoreFile>).servers !== "object"
      ) {
        throw new Error("unrecognised credential file");
      }
      return (parsed as StoreFile).servers;
    } catch {
      const aside = `${this.#path}.unreadable`;
      try {
        renameSync(this.#path, aside);
      } catch {
        // Nothing more to do: the next write replaces it.
      }
      console.warn(
        `[volli] MCP credential file ${this.#path} could not be read; moved aside to ${aside}. Sign in again or re-enter the stored values in Settings.`,
      );
      return {};
    } finally {
      closeSync(fd);
    }
  }
}
