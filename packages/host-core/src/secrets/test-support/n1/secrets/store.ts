import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  isSecretKeyUnavailable,
  SecretKeyUnavailableError,
  type SecretKeyPort,
} from "../ports/secret-key";
import {
  archiveSealedStore,
  CREDENTIALS_EMPTY,
  CREDENTIALS_READY,
  credentialStatusFor,
  credentialsUnavailable,
  SealedStoreUnreadableError,
  type CredentialStatus,
  type SealedStoreArchive,
} from "./credential-state";
import { pendingNoticeSecretStart } from "./pending-notice-secret";

import {
  payloadSecretSpans,
  pemSecretSpans,
  type SecretMetadata,
  type SecretScope,
} from "@volli/shared";
export type { SecretMetadata, SecretScope } from "@volli/shared";

export interface SecretInput {
  name: string;
  value: string;
  scope: SecretScope;
  sessionId?: string;
  projectId?: string;
}

interface SecretRecord extends SecretMetadata {
  value: string;
}

const CONTROL_NAMES = new Set([
  "PATH",
  "HOME",
  "ENV",
  "BASH_ENV",
  "SHELL",
  "IFS",
  "CDPATH",
  "GLOBIGNORE",
  "SHELLOPTS",
  "BASHOPTS",
  "ZDOTDIR",
  "FPATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "USER",
  "LOGNAME",
  "PWD",
  "OLDPWD",
  "TMPDIR",
  "TMP",
  "TEMP",
  "COMSPEC",
  "PATHEXT",
  "PROMPT_COMMAND",
  "PS0",
  "PS1",
  "PS2",
  "PS4",
  "HISTFILE",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONINSPECT",
  "RUBYOPT",
  "RUBYLIB",
  "PERL5OPT",
  "PERL5LIB",
  "PERLLIB",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "GIT_EXEC_PATH",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "GIT_PROXY_COMMAND",
  "GIT_TEMPLATE_DIR",
  "GIT_PAGER",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
  "PAGER",
  "EDITOR",
  "VISUAL",
  "LESSOPEN",
  "LESSCLOSE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
]);
const CONTROL_PREFIXES = /^(?:LD_|DYLD_|VOLLI_|ELECTRON_|BASH_FUNC_|NPM_CONFIG_|GIT_CONFIG_)/;

/** Credentials are data, never controls over executable lookup or process startup. */
export function isSecretName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    /^[A-Z][A-Z0-9_]{0,127}$/.test(name) &&
    !CONTROL_NAMES.has(name) &&
    !CONTROL_PREFIXES.test(name)
  );
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function validate(input: SecretInput): void {
  if (
    !isSecretName(input.name) ||
    typeof input.value !== "string" ||
    input.value.length === 0 ||
    input.value.includes("\0") ||
    !["session", "project", "always"].includes(input.scope) ||
    (input.scope === "session" && !validId(input.sessionId)) ||
    (input.scope === "project" && !validId(input.projectId)) ||
    (input.sessionId !== undefined && !validId(input.sessionId)) ||
    (input.projectId !== undefined && !validId(input.projectId))
  ) {
    throw new Error("Invalid secret input.");
  }
}

/** KMP borders keep both complete matches and trailing previews linear. */
function secretBorders(value: string): Uint32Array {
  const borders = new Uint32Array(value.length);
  for (let i = 1, matched = 0; i < value.length; i += 1) {
    while (matched > 0 && value[i] !== value[matched]) matched = borders[matched - 1]!;
    if (value[i] === value[matched]) matched += 1;
    borders[i] = matched;
  }
  return borders;
}

function trailingSecretPrefix(text: string, value: string, borders: Uint32Array): number {
  if (value.length < 2 || text.length === 0) return 0;
  let matched = 0;
  // Scan fewer than value.length units, so only a proper prefix can match.
  for (let i = Math.max(0, text.length - value.length + 1); i < text.length; i += 1) {
    while (matched > 0 && text[i] !== value[matched]) matched = borders[matched - 1]!;
    if (text[i] === value[matched]) matched += 1;
  }
  return matched;
}

function metadata(record: SecretRecord): SecretMetadata {
  const { value: _value, ...result } = record;
  return result;
}

function sameSlot(left: SecretMetadata, right: SecretMetadata): boolean {
  return (
    left.name === right.name &&
    left.scope === right.scope &&
    (left.scope !== "session" || left.sessionId === right.sessionId) &&
    (left.scope !== "project" || left.projectId === right.projectId)
  );
}

/** What {@link SecretStore.reset} did. */
export interface SecretStoreReset {
  /** The sealed file's new name beside it, or `null` when there was none. */
  readonly archive: string | null;
  /**
   * Whether the move was synced to disk. `false`: it happened, but a power
   * cut could leave the store under its old name too. Tell the person.
   */
  readonly synced: boolean;
  readonly status: CredentialStatus;
}

/**
 * Main-process-only credential owner. Scope is explicit person intent supplied
 * by the caller; this class never infers or widens it. Session values and the
 * redaction history live only for this store's lifetime (one application launch).
 * Persistent mutations commit on disk before changing the in-memory view.
 *
 * A sealed file this store cannot open never throws from a read (VC-641,
 * `credential-state.ts`): listing, availability, injection and redaction
 * carry on with the Session-scoped values in memory, and {@link status} says
 * why stored ones are missing. Persistent saves are refused with the original
 * refusal until {@link unlock} or {@link reset}. The failure is remembered, so
 * a locked keychain is asked once, not by every read.
 */
export class SecretStore {
  readonly #path: string;
  readonly #codec: SecretKeyPort;
  #persistent: SecretRecord[] | null = null;
  #status: CredentialStatus | null = null;
  #failure: Error | null = null;
  #sessions: SecretRecord[] = [];
  readonly #history = new Map<string, string>();

  /**
   * `codec` is the host's secret-key adapter: the keychain on desktop, the key
   * file on a headless host (see `ports/secret-key.ts`).
   */
  constructor(path: string, codec: SecretKeyPort) {
    this.#path = path;
    this.#codec = codec;
  }

  /** Replaces the same name in the same scope, retaining its stable id. */
  put(input: SecretInput): SecretMetadata {
    validate(input);
    const records = input.scope === "session" ? this.#sessions : this.#writable();
    const record: SecretRecord = {
      id: randomUUID(),
      name: input.name,
      value: input.value,
      scope: input.scope,
      ...(input.scope === "session" ? { sessionId: input.sessionId } : {}),
      ...(input.scope !== "always" && input.projectId !== undefined
        ? { projectId: input.projectId }
        : {}),
      lastUsedAt: null,
    };
    const previous = records.find((item) => sameSlot(item, record));
    if (previous) record.id = previous.id;
    const next = [...records.filter((item) => !sameSlot(item, record)), record];
    if (record.scope === "session") this.#sessions = next;
    else this.#persist(next);
    this.#history.set(record.value, record.name);
    return metadata(record);
  }

  /** Omit the filter to manage all scopes; a project filter includes global secrets. */
  list(projectId?: string): SecretMetadata[] {
    return [...this.#readable(), ...this.#sessions]
      .filter(
        (item) =>
          projectId === undefined || item.scope === "always" || item.projectId === projectId,
      )
      .map(metadata);
  }

  revoke(id: string): void {
    if (this.#sessions.some((item) => item.id === id)) {
      this.#sessions = this.#sessions.filter((item) => item.id !== id);
      return;
    }
    // A locked store lists no stored id, so there is nothing of it to revoke.
    const records = this.#readable();
    if (records.some((item) => item.id === id)) {
      this.#persist(records.filter((item) => item.id !== id));
    }
  }

  /** Availability is metadata-only and never updates last use. */
  available(name: string, sessionId: string, projectId: string): boolean {
    return this.#select(sessionId, projectId).has(name);
  }

  #select(sessionId: string, projectId: string): Map<string, SecretRecord> {
    const persistent = this.#readable();
    const selected = new Map<string, SecretRecord>();
    for (const scope of ["always", "project", "session"] as const) {
      for (const item of [...persistent, ...this.#sessions]) {
        if (
          item.scope === scope &&
          (scope !== "project" || item.projectId === projectId) &&
          (scope !== "session" || item.sessionId === sessionId) &&
          (scope !== "session" || item.projectId === undefined || item.projectId === projectId)
        )
          selected.set(item.name, item);
      }
    }
    return selected;
  }

  /** Nearest scope wins: session > project > always. Only injected values count as used. */
  environment(sessionId: string, projectId: string): Record<string, string> {
    const selected = this.#select(sessionId, projectId);
    const persistent = this.#readable();
    const used = new Set([...selected.values()].map((item) => item.id));
    const at = Date.now();
    if (persistent.some((item) => used.has(item.id))) {
      this.#persist(
        persistent.map((item) =>
          used.has(item.id) ? Object.assign({}, item, { lastUsedAt: at }) : item,
        ),
      );
    }
    this.#sessions = this.#sessions.map((item) =>
      used.has(item.id) ? Object.assign({}, item, { lastUsedAt: at }) : item,
    );
    return Object.fromEntries([...selected].map(([name, item]) => [name, item.value]));
  }

  /** Includes revoked/replaced values that may remain in process output this launch. */
  hasValues(): boolean {
    this.#readable();
    return this.#history.size > 0;
  }

  /** A single literal replacement pass never reinterprets generated markers. */
  redact(text: string): string {
    return this.#redact(text, false);
  }

  /** Withhold a live preview's trailing credential prefix, including a newline. */
  redactPartial(text: string): string {
    return this.#redact(text, true);
  }

  #redact(text: string, partial: boolean): string {
    this.#readable();
    if (text.length === 0 || (!partial && this.#history.size === 0)) return text;
    // Match source text only. A large stored credential must not become a
    // native regex (which can exceed the engine's compilation bound).
    const lengths = new Uint32Array(text.length);
    const sharedLengths = new Map<number, number>();
    if (partial) {
      // Both redactors inspect ORIGINAL text. Replacing a stored "Bearer"
      // or "-" must not hide a shared delimiter; shared replacement must
      // not expose the remainder of an overlapping multiline exact value.
      for (const span of [...payloadSecretSpans(text), ...pemSecretSpans(text, true)]) {
        const length = span.end - span.start;
        lengths[span.start] = Math.max(lengths[span.start]!, length);
        sharedLengths.set(span.start, lengths[span.start]!);
      }
      const from = pendingNoticeSecretStart(text);
      if (from !== null) {
        const length = text.length - from;
        lengths[from] = Math.max(lengths[from]!, length);
        sharedLengths.set(from, lengths[from]!);
      }
    }
    let hidden = 0;
    let partialName = "";
    for (const [value, name] of this.#history) {
      const borders = secretBorders(value);
      for (let at = 0, matched = 0; at < text.length; at += 1) {
        while (matched > 0 && text[at] !== value[matched]) matched = borders[matched - 1]!;
        if (text[at] === value[matched]) matched += 1;
        if (matched !== value.length) continue;
        const start = at - value.length + 1;
        lengths[start] = Math.max(lengths[start]!, value.length);
        matched = borders[matched - 1]!;
      }
      if (!partial) continue;
      const length = trailingSecretPrefix(text, value, borders);
      if (length > hidden) {
        hidden = length;
        partialName = name;
      }
    }
    const partialAt = hidden === 0 ? text.length : text.length - hidden;
    if (hidden > 0) lengths[partialAt] = Math.max(lengths[partialAt]!, hidden);
    const parts: string[] = [];
    let copied = 0;
    for (let at = 0; at < text.length; at += 1) {
      const length = lengths[at]!;
      if (length === 0) continue;
      const name =
        sharedLengths.get(at) === length
          ? null
          : at === partialAt && length === hidden
            ? partialName
            : this.#history.get(text.slice(at, at + length))!;
      let end = at + length;
      // Overlapping complete values/prefixes are one protected span. Never
      // preserve a suffix just because another credential started earlier.
      for (let next = at + 1; next < end; next += 1) end = Math.max(end, next + lengths[next]!);
      parts.push(text.slice(copied, at), name === null ? "[redacted]" : `‹secret:${name}›`);
      copied = end;
      at = end - 1;
    }
    parts.push(text.slice(copied));
    return parts.join("");
  }

  endSession(sessionId: string): void {
    this.#sessions = this.#sessions.filter((item) => item.sessionId !== sessionId);
  }

  /**
   * Where stored credentials stand, settling it now if nothing has asked yet.
   * Metadata only: no value, key byte or path.
   */
  status(): CredentialStatus {
    this.#open();
    return this.#status!;
  }

  /**
   * The refusal sentence behind a `locked` or `refused` key, for an
   * operator's log: it names the fix and may name the key file's path, never
   * a key byte or a secret. `null` otherwise, a corrupt store included.
   */
  problem(): string | null {
    this.#open();
    return isSecretKeyUnavailable(this.#failure) ? this.#failure.message : null;
  }

  /**
   * Tries a locked, refused or corrupt store again: after the key was put
   * back, the keychain unlocked or the mode fixed. A store that opened is
   * left as it is.
   */
  unlock(): CredentialStatus {
    if (this.#failure !== null) {
      this.#failure = null;
      this.#status = null;
    }
    return this.status();
  }

  /**
   * Gives up stored credentials this store cannot open: the sealed file is
   * moved aside (kept, never deleted; see `archiveSealedStore`) and the store
   * starts empty, ready for the secrets to be entered again. Only for
   * `locked` or `corrupt`: open stored credentials are revoked instead, and a
   * `refused` key configuration is fixed instead, since moving a store that
   * key may well open would not help. Person or local-admin intent only.
   */
  reset(now: Date = new Date()): SecretStoreReset {
    const status = this.status();
    if (status.state === "refused") {
      throw new Error(
        "Saved secrets are refused because the key configuration is unsafe. Fix it; a reset cannot.",
      );
    }
    if (!credentialsUnavailable(status)) {
      throw new Error("Saved secrets are not locked, so there is nothing to reset.");
    }
    let archived: SealedStoreArchive | null;
    try {
      archived = archiveSealedStore(this.#path, now);
    } catch {
      // Never a path or a filesystem error's text.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Could not set the saved secrets aside.");
    }
    this.#failure = null;
    this.#status = null;
    return {
      archive: archived?.name ?? null,
      synced: archived?.synced ?? true,
      status: this.status(),
    };
  }

  #requireEncryption(): void {
    if (!this.#codec.isEncryptionAvailable()) throw new Error("Secret encryption is unavailable.");
  }

  /** Stored records for a read: none while they are unavailable. */
  #readable(): SecretRecord[] {
    return this.#open() ?? [];
  }

  /** Stored records to change: a locked store refuses with the reason it is locked. */
  #writable(): SecretRecord[] {
    const records = this.#open();
    if (records === null) throw this.#failure!;
    return records;
  }

  /** Settles the status once per unlock; `null` while stored credentials are unavailable. */
  #open(): SecretRecord[] | null {
    if (this.#persistent !== null) return this.#persistent;
    if (this.#failure !== null) return null;
    try {
      this.#codec.probe?.();
      const records = this.#load();
      this.#persistent = records ?? [];
      this.#status = records === null ? CREDENTIALS_EMPTY : CREDENTIALS_READY;
      return this.#persistent;
    } catch (error) {
      this.#failure = error as Error;
      this.#status = credentialStatusFor(error);
      return null;
    }
  }

  /** The sealed records, `null` when there is no sealed file, or a sanitized throw. */
  #load(): SecretRecord[] | null {
    let fd: number;
    try {
      fd = openSync(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      // Credential storage errors must not retain paths, values, or a nested cause.
      throw new SealedStoreUnreadableError();
    }
    try {
      if (!fstatSync(fd).isFile()) throw new Error();
      fchmodSync(fd, 0o600);
      if (!this.#codec.isEncryptionAvailable()) {
        throw new SecretKeyUnavailableError(
          "unavailable",
          "Secret encryption is unavailable here, so saved secrets stay locked.",
        );
      }
      const parsed: unknown = JSON.parse(this.#codec.decryptString(readFileSync(fd)));
      if (parsed === null || typeof parsed !== "object") throw new Error();
      const file = parsed as { version?: unknown; secrets?: unknown };
      if (file.version !== 1 || !Array.isArray(file.secrets)) throw new Error();
      const records: SecretRecord[] = [];
      for (const candidate of file.secrets) {
        if (candidate === null || typeof candidate !== "object") throw new Error();
        const item = candidate as SecretRecord;
        validate(item);
        if (
          !validId(item.id) ||
          item.scope === "session" ||
          item.sessionId !== undefined ||
          (item.scope === "always" && item.projectId !== undefined) ||
          (item.lastUsedAt !== null &&
            (typeof item.lastUsedAt !== "number" ||
              !Number.isFinite(item.lastUsedAt) ||
              item.lastUsedAt < 0)) ||
          records.some((previous) => previous.id === item.id || sameSlot(previous, item))
        )
          throw new Error();
        // Whitelist fields: no unknown decrypted property can leak through list().
        records.push({
          id: item.id,
          name: item.name,
          value: item.value,
          scope: item.scope,
          ...(item.projectId !== undefined ? { projectId: item.projectId } : {}),
          lastUsedAt: item.lastUsedAt,
        });
      }
      for (const item of records) this.#history.set(item.value, item.name);
      return records;
    } catch (error) {
      // A key a person must fix says how (its message never holds key bytes).
      if (isSecretKeyUnavailable(error)) throw error;
      // Never include the codec, parser or filesystem error, its cause, or the path.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Could not decrypt secret storage.");
    } finally {
      try {
        closeSync(fd);
      } catch {
        // Closing the read descriptor is best-effort; never expose a cleanup error.
      }
    }
  }

  #persist(records: SecretRecord[]): void {
    const temporary = `${this.#path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    let fd: number | undefined;
    try {
      this.#requireEncryption();
      const encrypted = this.#codec.encryptString(JSON.stringify({ version: 1, secrets: records }));
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error();
      fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(fd, encrypted);
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.#path);
    } catch (error) {
      if (isSecretKeyUnavailable(error)) throw error;
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Could not persist encrypted secrets.");
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* Preserve the sanitized operation error. */
        }
      }
      // Cleanup is best-effort; never let an underlying error disclose data.
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* Nothing was committed. */
      }
    }
    this.#persistent = records;
    this.#status = CREDENTIALS_READY;
    // Some filesystems cannot sync directories. The file itself is already synced.
    try {
      const directory = openSync(dirname(this.#path), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch {
      /* Atomic rename has already committed. */
    }
  }
}
