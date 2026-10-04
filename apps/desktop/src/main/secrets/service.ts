import { randomUUID } from "node:crypto";
import type { SecretRequestMetadata, SecretScope } from "@volli/shared";
import type { SecretsResult } from "../../ipc/secrets";
import { isSecretName, type SecretStore, type SecretWaitPublisher } from "@volli/host-core/secrets";
export type { SecretWaitPublisher } from "@volli/host-core/secrets";

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

  list(projectId?: string): SecretsResult {
    return {
      ok: true,
      requests: [...this.#pending.values()]
        .map(({ metadata }) => Object.assign({}, metadata))
        .filter((m) => projectId === undefined || m.projectId === projectId),
      secrets: this.store.list(projectId),
    };
  }

  submit(requestId: string, value: string, scope: SecretScope): Promise<void> {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) throw new Error("This credential request is no longer waiting.");
    if (!["session", "project", "always"].includes(scope)) throw new Error("Invalid secret scope.");
    const { metadata } = pending;
    this.store.put({
      name: metadata.name,
      value,
      scope,
      sessionId: metadata.sessionId,
      projectId: metadata.projectId,
    });
    return pending.settle("signed in");
  }

  decline(id: string): Promise<void> {
    const pending = this.#pending.get(id);
    if (pending === undefined) throw new Error("This credential request is no longer waiting.");
    return pending.settle("declined");
  }

  replace(id: string, value: string): void {
    const metadata = this.store.list().find((m) => m.id === id);
    if (metadata === undefined) throw new Error("This stored secret no longer exists.");
    this.store.put({
      name: metadata.name,
      scope: metadata.scope,
      ...(metadata.sessionId === undefined ? {} : { sessionId: metadata.sessionId }),
      ...(metadata.projectId === undefined ? {} : { projectId: metadata.projectId }),
      value,
    });
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
