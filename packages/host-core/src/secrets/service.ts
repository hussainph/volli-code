import { randomUUID } from "node:crypto";
import type {
  CredentialsResult,
  SecretRequestMetadata,
  SecretScope,
  SecretsResult,
} from "@volli/shared";
import {
  CredentialLockBusyError,
  isSecretName,
  retryWhileBusy,
  type CredentialStatus,
  type SecretStore,
  type SecretWaitPublisher,
} from "./index";
export type { CredentialStatus, SecretWaitPublisher } from "./index";
/** The credential door's answers are client wire vocabulary (`@volli/shared`, VC-632). */
export type { CredentialsResult, SecretsResult } from "@volli/shared";

interface SecretOwner {
  sessionId: string;
  sessionLabel: string;
  projectId: string;
  projectLabel: string;
}
type Outcome = "signed in" | "declined" | "still missing";
interface Pending {
  metadata: SecretRequestMetadata;
  settle: (outcome: Outcome, announce?: boolean) => Promise<void>;
  abandon: () => void;
}

/**
 * How long the person's door waits, asynchronously, for another Volli process
 * to let go of the credential lock (VC-642). The thread stays free: each
 * attempt refuses at once, and the next one is a timer away.
 */
export const CREDENTIAL_DOOR_WAIT_MS = 2_000;

/** Values enter only through person IPC. The Engine owns waiting facts and
 * Attention; this map holds only the live promise correlations needed to deliver
 * a dedicated write-only submission. Neither generic answers nor facts carry values.
 */
export class SecretService {
  readonly #pending = new Map<string, Pending>();
  readonly #owners = new Map<string, SecretOwner>();
  constructor(readonly store: SecretStore) {}

  environment(sessionId: string): Record<string, string> {
    const owner = this.#owners.get(sessionId);
    return owner === undefined ? {} : this.store.environment(sessionId, owner.projectId);
  }

  port(owner: SecretOwner, wait?: SecretWaitPublisher, allowInjection = true) {
    if (allowInjection) this.#owners.set(owner.sessionId, owner);
    let closed = false;
    return {
      redact: (text: string) => this.store.redact(text),
      hasValues: () => this.store.hasValues(),
      request: async (
        input: { name: string; purpose?: string; toolCallId: string },
        signal: AbortSignal,
      ): Promise<Outcome> => {
        if (closed || !allowInjection || !isSecretName(input.name) || signal.aborted) {
          return "still missing";
        }
        if (this.store.available(input.name, owner.sessionId, owner.projectId)) {
          return "signed in";
        }
        // One live correlation per Session; durable waiting state lives in the Engine.
        if ([...this.#pending.values()].some((p) => p.metadata.sessionId === owner.sessionId)) {
          return "still missing";
        }
        const id = randomUUID();
        const metadata: SecretRequestMetadata = {
          id,
          name: input.name,
          ...owner,
          agentSays: typeof input.purpose === "string" ? input.purpose.slice(0, 500) : null,
        };
        const result = Promise.withResolvers<Outcome>();
        // Commit the open fact before a settlement can resume the model. Calling
        // opened synchronously also lets IPC discover the live correlation immediately.
        const opening = wait?.opened(metadata) ?? Promise.resolve();
        let settling: Promise<void> | null = null;
        const abandon = () => {
          this.#pending.delete(id);
          signal.removeEventListener("abort", abort);
          result.resolve("still missing");
        };
        const finish = (outcome: Outcome, announce = true): Promise<void> => {
          if (settling !== null) return settling;
          settling = (async () => {
            await opening;
            if (announce) await wait?.settled(metadata, outcome);
            this.#pending.delete(id);
            signal.removeEventListener("abort", abort);
            result.resolve(outcome);
          })().finally(() => {
            settling = null;
          });
          return settling;
        };
        const abort = () => void finish("still missing").catch(abandon);
        this.#pending.set(id, { metadata, settle: finish, abandon });
        signal.addEventListener("abort", abort, { once: true });
        void opening.catch(abandon);
        if (signal.aborted) abort();
        return result.promise;
      },
      // Engine cancellation has already committed its fact; do not announce it twice.
      withdraw: async (id: string) => {
        const pending = this.#pending.get(id);
        if (pending?.metadata.sessionId === owner.sessionId) {
          await pending.settle("still missing", false).catch(pending.abandon);
        }
      },
      cancelPending: async () => {
        for (const pending of this.#pending.values()) {
          if (pending.metadata.sessionId === owner.sessionId) {
            // Executor teardown must finish even when the ledger is unavailable.
            await pending.settle("still missing").catch(pending.abandon);
          }
        }
      },
      dispose: async () => {
        closed = true;
        await this.endSession(owner.sessionId);
      },
    };
  }

  /**
   * Stored secrets and their status from one read (VC-642), waiting
   * asynchronously, bounded, while another process holds the lock; still busy
   * after that, the status says `busy` and the listing holds only what is
   * in memory.
   */
  async list(projectId?: string): Promise<SecretsResult> {
    const snapshot = await whenFree(
      () => this.store.snapshot(projectId),
      (result) => result.credentials,
    );
    return {
      ok: true,
      requests: [...this.#pending.values()]
        .map(({ metadata }) => Object.assign({}, metadata))
        .filter((m) => projectId === undefined || m.projectId === projectId),
      secrets: snapshot.secrets,
      credentials: snapshot.credentials,
    };
  }

  /** Tries locked stored secrets again; a person's explicit action. */
  async unlock(): Promise<CredentialsResult> {
    this.store.unlock();
    return {
      ok: true,
      credentials: await whenFree(
        () => this.store.status(),
        (status) => status,
      ),
    };
  }

  /** Revokes a stored secret, waiting asynchronously while another process holds the lock. */
  async revoke(id: string): Promise<void> {
    await retryWhileBusy(() => this.store.revoke(id), CREDENTIAL_DOOR_WAIT_MS);
  }

  /** Sets locked stored secrets aside and starts empty; a person's explicit, confirmed action. */
  async reset(): Promise<CredentialsResult> {
    const { status, synced } = await retryWhileBusy(
      () => this.store.reset(),
      CREDENTIAL_DOOR_WAIT_MS,
    );
    if (!synced) {
      // The move happened; only its durability across a power cut is unknown.
      console.warn("[volli] saved secrets were set aside, but the directory could not be synced");
    }
    return { ok: true, credentials: status };
  }

  submit(requestId: string, value: string, scope: SecretScope): Promise<void> {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) throw new Error("This credential request is no longer waiting.");
    if (!["session", "project", "always"].includes(scope)) throw new Error("Invalid secret scope.");
    const { metadata } = pending;
    const save = () =>
      this.store.put({
        name: metadata.name,
        value,
        scope,
        sessionId: metadata.sessionId,
        projectId: metadata.projectId,
      });
    try {
      save();
    } catch (error) {
      if (!(error instanceof CredentialLockBusyError)) throw error;
      // Another process has the lock: wait for it asynchronously, bounded.
      return retryWhileBusy(save, CREDENTIAL_DOOR_WAIT_MS).then(() => pending.settle("signed in"));
    }
    return pending.settle("signed in");
  }

  decline(id: string): Promise<void> {
    const pending = this.#pending.get(id);
    if (pending === undefined) throw new Error("This credential request is no longer waiting.");
    return pending.settle("declined");
  }

  /** Replaces a secret's value in place, waiting asynchronously while another process holds the lock. */
  async replace(id: string, value: string): Promise<void> {
    await retryWhileBusy(() => {
      const { secrets, credentials } = this.store.snapshot();
      if (credentials.reason === "busy") throw new CredentialLockBusyError();
      const metadata = secrets.find((m) => m.id === id);
      if (metadata === undefined) throw new Error("This stored secret no longer exists.");
      this.store.put({
        name: metadata.name,
        scope: metadata.scope,
        ...(metadata.sessionId === undefined ? {} : { sessionId: metadata.sessionId }),
        ...(metadata.projectId === undefined ? {} : { projectId: metadata.projectId }),
        value,
      });
    }, CREDENTIAL_DOOR_WAIT_MS);
  }

  async endSession(sessionId: string): Promise<void> {
    for (const pending of this.#pending.values()) {
      if (pending.metadata.sessionId === sessionId) {
        await pending.settle("still missing").catch(pending.abandon);
      }
    }
    this.store.endSession(sessionId);
    this.#owners.delete(sessionId);
  }
}

/**
 * Reads with `read` until its status is not `busy`, asynchronously, within
 * {@link CREDENTIAL_DOOR_WAIT_MS}; then answers the last read, busy or not.
 */
async function whenFree<T>(read: () => T, status: (result: T) => CredentialStatus): Promise<T> {
  let last: T | undefined;
  try {
    return await retryWhileBusy(() => {
      last = read();
      if (status(last).reason === "busy") throw new CredentialLockBusyError();
      return last;
    }, CREDENTIAL_DOOR_WAIT_MS);
  } catch (error) {
    if (!(error instanceof CredentialLockBusyError)) throw error;
    return last!;
  }
}
