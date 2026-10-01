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

/** Inject safeStorage at the application edge; importing this module never loads Electron. */
export interface SecretCodec {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export type SecretScope = "session" | "project" | "always";

export interface SecretMetadata {
  id: string;
  name: string;
  scope: SecretScope;
  sessionId?: string;
  projectId?: string;
  lastUsedAt: number | null;
}

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

/**
 * Main-process-only credential owner. Scope is explicit person intent supplied
 * by the caller; this class never infers or widens it. Session values and the
 * redaction history live only for this store's lifetime (one application launch).
 * Persistent mutations commit on disk before changing the in-memory view.
 */
export class SecretStore {
  readonly #path: string;
  readonly #codec: SecretCodec;
  #persistent: SecretRecord[] | null = null;
  #sessions: SecretRecord[] = [];
  readonly #history = new Map<string, string>();

  constructor(path: string, codec: SecretCodec) {
    this.#path = path;
    this.#codec = codec;
  }

  /** Replaces the same name in the same scope, retaining its stable id. */
  put(input: SecretInput): SecretMetadata {
    validate(input);
    const records = input.scope === "session" ? this.#sessions : this.#load();
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
    return [...this.#load(), ...this.#sessions]
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
    const records = this.#load();
    if (records.some((item) => item.id === id)) {
      this.#persist(records.filter((item) => item.id !== id));
    }
  }

  /** Nearest scope wins: session > project > always. Only injected values count as used. */
  environment(sessionId: string, projectId: string): Record<string, string> {
    const persistent = this.#load();
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
    this.#load();
    return this.#history.size > 0;
  }

  /** A single replacement pass prevents short secrets from rewriting generated markers. */
  redact(text: string): string {
    this.#load();
    const values = [...this.#history.keys()].toSorted((left, right) => right.length - left.length);
    if (values.length === 0) return text;
    const pattern = values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    return text.replace(
      new RegExp(pattern, "g"),
      (value) => `‹secret:${this.#history.get(value)}›`,
    );
  }

  endSession(sessionId: string): void {
    this.#sessions = this.#sessions.filter((item) => item.sessionId !== sessionId);
  }

  #requireEncryption(): void {
    if (!this.#codec.isEncryptionAvailable()) throw new Error("Secret encryption is unavailable.");
  }

  #load(): SecretRecord[] {
    if (this.#persistent !== null) return this.#persistent;
    let fd: number;
    try {
      fd = openSync(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#persistent = [];
        return this.#persistent;
      }
      // Credential storage errors must not retain paths, values, or a nested cause.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Could not read secret storage.");
    }
    try {
      if (!fstatSync(fd).isFile()) throw new Error();
      fchmodSync(fd, 0o600);
      this.#requireEncryption();
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
      this.#persistent = records;
      for (const item of records) this.#history.set(item.value, item.name);
      return records;
    } catch {
      // Never include the codec, parser or filesystem error, its cause, or the path.
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
    } catch {
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
