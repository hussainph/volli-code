/**
 * Pi's own credentials, read from Pi's own file.
 *
 * The product decision is that **Pi owns provider credentials and refresh
 * behavior**: Volli stores no token, mints no token, and refreshes no token.
 * What it has to supply is the one thing `@earendil-works/pi-ai` deliberately
 * leaves to its host — somewhere durable to keep them. `createModels()` defaults
 * to `InMemoryCredentialStore`, whose own doc says "Apps inject persistent
 * stores", so a runtime built on the default is a runtime that has never read a
 * credential in its life and reports every provider as unconfigured.
 *
 * pi-ai ships no persistent store (only the in-memory one), so this is it: the
 * same `auth.json` the `pi` CLI writes, in the same place, in the same shape —
 * `{ "<providerId>": Credential }`, one type-tagged credential per provider.
 * Nothing here understands OAuth. `Models.getAuth()` runs the refresh itself
 * *inside* {@link PiFileCredentialStore.modify}, which is exactly why `modify`
 * is the only write path and why it hands `fn` the credential it just read: a
 * rotated token is written back through this store by Pi, under Pi's own lock
 * discipline, and stays valid for the next process that reads the file.
 *
 * **Nothing here may leak a secret.** The file's contents never reach an error
 * message — a malformed file is reported by path alone, never by quoting what
 * failed to parse, because V8's own `JSON.parse` message quotes the offending
 * source text and here that text is a token.
 *
 * Pi's `AuthStorage` takes an advisory `proper-lockfile` lock on this exact
 * path for the entire async read-modify-write. This store does the same for
 * `modify` and `delete`, so a Pi CLI refresh and a Volli refresh cannot each
 * write a valid-but-stale credential map over the other. Writes remain whole-
 * file atomic renames and errors remain free of credential bytes.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Credential, CredentialInfo, CredentialStore, Models } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import lockfile from "proper-lockfile";

import {
  attachRefreshableCatalog,
  modelsDevCatalogSource,
  PiFileModelsStore,
} from "./model-catalog";

/** The file Pi keeps its credentials in, inside its agent directory. */
const AUTH_FILE = "auth.json";

/**
 * Volli's model-catalog cache, in the same directory. Volli's own file — the
 * `pi` CLI neither reads nor writes it — but it belongs to the profile the
 * credentials belong to, so an isolated `$PI_CODING_AGENT_DIR` isolates both.
 */
const MODELS_FILE = "volli-models.json";

/** Owner-only, matching what the `pi` CLI leaves on disk. */
const AUTH_FILE_MODE = 0o600;

/** Pi's `FileAuthStorageBackend` treats a stale auth lock as expired after 30s. */
const AUTH_LOCK_STALE_MS = 30_000;

export interface PiCredentialOptions {
  /**
   * Pi's agent directory. Defaults to `$PI_CODING_AGENT_DIR` when set, else
   * `~/.pi/agent` — and `~` is the process's own `HOME`, which is what lets a
   * packaged smoke run against an isolated profile instead of a developer's.
   */
  agentDir?: string;
}

/**
 * Where Pi's credentials live for this process — Pi's own rule, not ours.
 *
 * `$PI_CODING_AGENT_DIR` then `~/.pi/agent`, and a leading `~` in the override
 * expands, exactly as the `pi` CLI's `getAgentDir()` resolves it. Reading the
 * same file the same way is the whole point: a person who logged in with `pi`
 * is logged in here, and one who moved their profile moved this too.
 */
export function piAuthFilePath(options: PiCredentialOptions = {}): string {
  const configured = options.agentDir ?? process.env.PI_CODING_AGENT_DIR;
  const agentDir =
    configured !== undefined && configured.length > 0
      ? expandTilde(configured)
      : join(homedir(), ".pi", "agent");
  return join(agentDir, AUTH_FILE);
}

/** Where the refreshed model catalog persists — resolved by the same rule. */
export function piModelsFilePath(options: PiCredentialOptions = {}): string {
  return join(dirname(piAuthFilePath(options)), MODELS_FILE);
}

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * The model collection the runtime uses when its host injects none.
 *
 * Pi's built-in providers, wired to Pi's own credentials. The `models` seam on
 * {@link import("./runtime").PiRuntimeHostOptions} stays exactly what it was —
 * a test injects a scripted collection and never comes near this.
 *
 * The OAuth registration is not optional here, and it is the difference between
 * this working from source and working in the packaged app. A provider's OAuth
 * flow is loaded by pi-ai through a *deliberately* bundler-opaque dynamic import
 * (`auth/oauth/load.ts` — a variable specifier, so Node-only callback-server and
 * PKCE code stays out of bundles that do not need it). Inside Electron main's
 * bundle that specifier resolves relative to the emitted chunk, where no such
 * file exists, and the first token derivation dies with `Cannot find module` —
 * reported to the Session as `auth`, which reads as "sign in again" for a
 * credential that was never the problem. `registerBunOAuthFlows` is pi-ai's own
 * answer for a host that bundles: it imports the flows statically, so the
 * dynamic path is never taken. Bun is its origin, not its requirement.
 */
export function piOwnedModels(options: PiCredentialOptions = {}): Models {
  return piOwnedModelAccess(options).models;
}

/**
 * The provider collection and the store behind it, as one value.
 *
 * They are separable in Pi's types and inseparable in fact: `Models` hides its
 * store, so a caller handed only the collection can ask whether a provider
 * resolves auth but not whether *this profile* stored anything — and those are
 * different questions. A provider reading `ANTHROPIC_API_KEY` out of the
 * environment answers yes to the first and no to the second, and only the
 * second decides whether there is anything to sign out of.
 *
 * Returning the pair also keeps the singleton honest. Two collections would
 * mean two credential stores, two write chains and two catalog caches over one
 * file — safe, because the file lock is cross-process and already survives the
 * `pi` CLI writing alongside us, but pointless. Sign-in and execution share one.
 */
export function piOwnedModelAccess(options: PiCredentialOptions = {}): PiModelAccess {
  registerBunOAuthFlows();
  const credentials = new PiFileCredentialStore(piAuthFilePath(options));
  // The store is what lets a refreshed catalog outlive this process: without
  // it pi falls back to `InMemoryModelsStore` and every fetched model dies at
  // restart. The wrapping is what makes "Refresh models" mean something — pi's
  // built-in catalogs are frozen at publish time, and an unwrapped provider
  // has no `refreshModels` for the button to reach (see `model-catalog.ts`).
  const models = builtinModels({
    credentials,
    modelsStore: new PiFileModelsStore(piModelsFilePath(options)),
  });
  attachRefreshableCatalog(models, modelsDevCatalogSource());
  // Start restoration eagerly, but make its completion part of the returned
  // access value. Every product path that can read or execute a model awaits
  // this promise, so a model that exists only in the persisted overlay is
  // present before the first lookup after restart, and a restore failure
  // reaches the caller waiting on that operation instead of being discarded.
  const catalogReady = restoreCatalogs(models);
  return { models, credentials, catalogReady };
}

async function restoreCatalogs(models: Models): Promise<void> {
  const restored = await models.refresh({ allowNetwork: false });
  if (restored.errors.size > 0) {
    const providers = [...restored.errors.keys()].toSorted().join(", ");
    // Provider ids only. A credential or provider error may contain a response
    // body, and startup diagnostics have no reason to carry those bytes.
    throw new Error(`Could not restore model catalogs for: ${providers}.`);
  }
}

/** Pi's providers, the credential store, and completion of local catalog restore. */
export interface PiModelAccess {
  models: Models;
  credentials: CredentialStore;
  catalogReady: Promise<void>;
}

/**
 * `auth.json`, as a {@link CredentialStore}.
 *
 * One write chain for the whole file rather than pi-ai's per-provider chains:
 * every provider lives in the same document, so two concurrent per-provider
 * read-modify-writes would race on it and the later write would drop the
 * earlier one's entry. Each pass re-reads the file rather than caching it, so a
 * credential another process (the `pi` CLI itself) refreshed in the meantime is
 * carried forward instead of clobbered.
 *
 * `AuthOperationOptions.signal` is not accepted: every operation here is a
 * local file read or an atomic rename, and there is nothing worth cancelling
 * between them.
 */
export class PiFileCredentialStore implements CredentialStore {
  readonly #path: string;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return (await this.#load())[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const stored = await this.#load();
    return Object.entries(stored).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.#serialize(() =>
      this.#withPiLock(async () => {
        const stored = await this.#load();
        const current = stored[providerId];
        const next = await fn(current);
        // Undefined means "leave the entry alone", which is not the same as
        // deleting it — an OAuth refresh that decided the held token is still
        // good takes this path and must not rewrite the file.
        if (next === undefined) return current;
        await this.#save({ ...stored, [providerId]: next });
        return next;
      }),
    );
  }

  delete(providerId: string): Promise<void> {
    return this.#serialize(() =>
      this.#withPiLock(async () => {
        const stored = await this.#load();
        if (stored[providerId] === undefined) return;
        const { [providerId]: _removed, ...rest } = stored;
        await this.#save(rest);
      }),
    );
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    // A failed pass must not poison the chain for the next one, so the tail
    // this store keeps is the settled one and the caller gets the rejection.
    const run = this.#chain.then(work, work);
    this.#chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Pi creates the `0600` file before locking it because `proper-lockfile`
   * locks a path by creating its neighboring `.lock` directory. `realpath:
   * false` is likewise Pi's option: the file may have just been created and
   * must not be resolved through a symlink.
   */
  async #withPiLock<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(this.#path, "{}", { encoding: "utf8", mode: AUTH_FILE_MODE, flag: "wx" });
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw new Error(`Could not initialize Pi credentials at ${this.#path}.`, { cause: error });
      }
    }

    let release: (() => Promise<void>) | undefined;
    let compromised: Error | undefined;
    try {
      release = await this.#acquirePiLock((error) => {
        compromised = error;
      });
      if (compromised) throw compromised;
      const result = await work();
      if (compromised) throw compromised;
      return result;
    } finally {
      // Pi likewise ignores an unlock failure after a compromised lock. The
      // original write/read error is more useful and cannot include file data.
      await release?.().catch(() => undefined);
    }
  }

  async #acquirePiLock(onCompromised: (error: Error) => void): Promise<() => Promise<void>> {
    const deadline = Date.now() + AUTH_LOCK_STALE_MS;
    let retry = 0;
    while (true) {
      try {
        return await lockfile.lock(this.#path, {
          realpath: false,
          retries: 0,
          stale: AUTH_LOCK_STALE_MS,
          onCompromised,
        });
      } catch (error) {
        const remaining = deadline - Date.now();
        if (lockErrorCode(error) !== "ELOCKED" || remaining <= 0) {
          throw new Error(`Could not lock Pi credentials at ${this.#path}.`, { cause: error });
        }
        const maximumDelay = Math.min(10 * 2 ** retry, 1_000);
        retry++;
        const delay = Math.min(Math.round(maximumDelay * (1 + Math.random())), remaining);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async #load(): Promise<Record<string, Credential>> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      // No file is no credentials, which is a state Pi already has a word for.
      if (isMissing(error)) return {};
      // The cause is safe to carry here and only here: a filesystem error names
      // the path it could not open, never a byte of what is inside it.
      throw new Error(`Could not read Pi credentials at ${this.#path}.`, { cause: error });
    }
    const stored = readCredentials(text);
    if (stored === null) throw new Error(`Pi credentials at ${this.#path} are unreadable.`);
    return stored;
  }

  /**
   * Written whole, then renamed over the old file: a partial write here is a
   * profile that can no longer reach any provider, and rename is the one
   * filesystem operation that cannot leave one behind.
   */
  async #save(stored: Record<string, Credential>): Promise<void> {
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.#path), { recursive: true });
    try {
      // Byte-for-byte the `pi` CLI's own serialization, so a file this wrote
      // and a file `pi` wrote are not distinguishable by their formatting.
      await writeFile(temporary, JSON.stringify(stored, null, 2), {
        encoding: "utf8",
        mode: AUTH_FILE_MODE,
      });
      await rename(temporary, this.#path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

/**
 * The stored map, or null when the file is not one.
 *
 * Entries that are not credentials are dropped rather than fatal: an unknown
 * key is a newer `pi` writing something this version has no reading of, and
 * that is not a reason to refuse the providers alongside it.
 */
function readCredentials(text: string): Record<string, Credential> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const stored: Record<string, Credential> = {};
  for (const [providerId, value] of Object.entries(parsed)) {
    const credential = asCredential(value);
    if (credential !== undefined) stored[providerId] = credential;
  }
  return stored;
}

function asCredential(value: unknown): Credential | undefined {
  if (!isRecord(value)) return undefined;
  return value.type === "api_key" || value.type === "oauth" ? (value as Credential) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

function lockErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}
