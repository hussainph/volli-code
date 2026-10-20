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
  type SecretStore,
  type SecretWaitPublisher,
} from "./index";
import { CREDENTIAL_LOCK_ASYNC_TIMEOUT_MS } from "./credential-lock";
import { waitForCredentialRead } from "./credential-wait";
import { hostLogger } from "../log/root";

const log = hostLogger("secrets");
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
export const CREDENTIAL_DOOR_WAIT_MS = CREDENTIAL_LOCK_ASYNC_TIMEOUT_MS;

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

  /**
   * Command-start read and last-use commit: brief contention must not fail the
   * command, or silently omit stored secrets. A stuck lock still rejects
   * before any process is spawned. The synchronous door remains a try-once API.
   */
  environmentAsync(sessionId: string, signal?: AbortSignal): Promise<Record<string, string>> {
    return retryWhileBusy(() => this.environment(sessionId), CREDENTIAL_DOOR_WAIT_MS, signal);
  }

  port(owner: SecretOwner, wait?: SecretWaitPublisher, allowInjection = true) {
    if (allowInjection) this.#owners.set(owner.sessionId, owner);
    let closed = false;
    const lifetime = new AbortController();
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
        let available: boolean;
        try {
          available = this.store.availableForUse(input.name, owner.sessionId, owner.projectId);
        } catch (error) {
          if (!(error instanceof CredentialLockBusyError)) throw error;
          try {
            available = await this.store.availableAsync(
              input.name,
              owner.sessionId,
              owner.projectId,
              AbortSignal.any([signal, lifetime.signal]),
            );
          } catch (waitError) {
            if (closed || signal.aborted) return "still missing";
            throw waitError;
          }
        }
        if (closed || signal.aborted) return "still missing";
        if (available) return "signed in";
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
        lifetime.abort();
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
    const snapshot = await waitForCredentialRead(
      () => this.store.snapshot(projectId),
      (result) => result.credentials,
      CREDENTIAL_DOOR_WAIT_MS,
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
      credentials: await waitForCredentialRead(
        () => this.store.status(),
        (status) => status,
        CREDENTIAL_DOOR_WAIT_MS,
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
      log.warn("saved secrets were set aside, but the directory could not be synced");
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
