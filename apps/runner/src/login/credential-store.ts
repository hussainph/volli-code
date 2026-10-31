import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import type { PiModelAccess } from "@volli/agent-runtime";
import {
  CREDENTIAL_INVENTORY_FILE_NAME,
  CredentialLock,
  credentialsUnavailable,
  fileCredentialKeyring,
  SealedInventory,
  type CredentialStatus,
} from "@volli/host-core/secrets";

type Store = PiModelAccess["credentials"];
type Credential = NonNullable<Awaited<ReturnType<Store["read"]>>>;
const UNAVAILABLE =
  "Runner model credentials are unavailable. Check the runner's secret key and permissions.";

/**
 * Runner-owned Pi credentials; never the person's ~/.pi/agent/auth.json.
 * Pi owns the opaque credential and refresh. A separate Pi operation lock
 * serializes refresh/login/logout across processes, including the async
 * refresh callback; inventory writes merge under the shared credential lock.
 */
export class RunnerCredentialStore implements Store {
  readonly #inventory: SealedInventory;
  readonly #operations: CredentialLock;

  constructor(dataDir: string, keyPath: string) {
    this.#inventory = new SealedInventory({
      path: join(dataDir, CREDENTIAL_INVENTORY_FILE_NAME),
      keyring: fileCredentialKeyring({ path: keyPath }),
      families: ["pi-provider"],
    });
    this.#operations = new CredentialLock(join(dataDir, "pi-credentials.lock"));
  }

  read: Store["read"] = (providerId, options) =>
    this.#operations.with(() => retryInventory(() => this.#read(providerId), options?.signal));

  list: Store["list"] = (options) =>
    this.#operations.with(() =>
      retryInventory(() => {
        const snapshot = this.#inventory.snapshot("pi-provider");
        assertAvailable(snapshot.status);
        return snapshot.records.map((record) => {
          const credential = this.#read(record.selector["provider"]!);
          if (credential === undefined)
            throw new Error("Runner model credentials changed while reading.");
          return { providerId: record.selector["provider"]!, type: credential.type };
        });
      }, options?.signal),
    );

  modify: Store["modify"] = (providerId, fn, options) =>
    this.#operations.with(async () => {
      const current = await retryInventory(() => this.#read(providerId), options?.signal);
      const next = await fn(current);
      options?.signal?.throwIfAborted();
      if (next === undefined) return current;
      await retryInventory(
        () => this.#inventory.put("pi-provider", { provider: providerId }, { ...next }),
        options?.signal,
      );
      return next;
    });

  delete: Store["delete"] = (providerId, options) =>
    this.#operations.with(async () => {
      await retryInventory(
        () => this.#inventory.remove("pi-provider", { provider: providerId }),
        options?.signal,
      );
    });

  #read(providerId: string): Credential | undefined {
    const snapshot = this.#inventory.snapshot("pi-provider");
    assertAvailable(snapshot.status);
    if (!snapshot.records.some((record) => record.selector["provider"] === providerId))
      return undefined;
    const record = this.#inventory.get("pi-provider", { provider: providerId });
    assertAvailable(this.#inventory.status());
    if (record === null) throw new Error("Runner model credentials changed while reading.");
    // The inventory validates the object-valued family; Pi owns its contents.
    const value = record.value as Record<string, unknown>;
    if (value["type"] !== "api_key" && value["type"] !== "oauth") {
      throw new Error("Runner model credentials have an invalid format.");
    }
    return value as unknown as Credential;
  }
}

function assertAvailable(status: CredentialStatus): void {
  if (status.reason === "busy")
    throw Object.assign(new Error("Runner model credentials are busy. Try again."), {
      code: "credential-lock-busy",
    });
  if (credentialsUnavailable(status)) throw new Error(UNAVAILABLE);
}

/** A busy inventory is transient, not an empty credential set or a lost key. */
async function retryInventory<T>(read: () => T, signal: AbortSignal | undefined): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    signal?.throwIfAborted();
    try {
      return read();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "credential-lock-busy" ||
        Date.now() >= deadline
      )
        throw error;
      await pause(25, undefined, { signal });
    }
  }
}
