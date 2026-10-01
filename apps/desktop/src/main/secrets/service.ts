import { randomUUID } from "node:crypto";
import type { SecretRequestMetadata, SecretScope, SecretsResult } from "../../ipc/secrets";
import { isSecretName, type SecretStore } from "./store";

interface SecretOwner {
  sessionId: string;
  sessionLabel: string;
  projectId: string;
  projectLabel: string;
}
type Outcome = "signed in" | "declined" | "still missing";
interface Pending {
  metadata: SecretRequestMetadata;
  settle: (outcome: Outcome) => void;
}

/** Values enter only through person IPC. Requests and outcomes contain metadata only.
 * No ledger, chat command, CLI verb, event bus, or logger carries a submission.
 * The polling projection is intentionally separate from Session interactions:
 * generic interaction.resolve (including an agent's socket) cannot answer it.
 */
export class SecretService {
  readonly #pending = new Map<string, Pending>();
  readonly #owners = new Map<string, SecretOwner>();
  constructor(readonly store: SecretStore) {}

  environment(sessionId: string): Record<string, string> {
    const owner = this.#owners.get(sessionId);
    return owner === undefined ? {} : this.store.environment(sessionId, owner.projectId);
  }

  port(owner: SecretOwner) {
    this.#owners.set(owner.sessionId, owner);
    return {
      redact: (text: string) => this.store.redact(text),
      hasValues: () => this.store.hasValues(),
      request: async (
        input: { name: string; purpose?: string; toolCallId: string },
        signal: AbortSignal,
      ): Promise<Outcome> => {
        if (!isSecretName(input.name) || signal.aborted) return "still missing";
        if (Object.hasOwn(this.store.environment(owner.sessionId, owner.projectId), input.name)) {
          return "signed in";
        }
        // One prompt per Session at a time; do not let parallel calls flood the person.
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
        return new Promise<Outcome>((resolve) => {
          const finish = (outcome: Outcome) => {
            this.#pending.delete(id);
            signal.removeEventListener("abort", abort);
            resolve(outcome);
          };
          const abort = () => finish("still missing");
          this.#pending.set(id, { metadata, settle: finish });
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
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

  submit(requestId: string, value: string, scope: SecretScope): void {
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
    pending.settle("signed in");
  }

  decline(id: string): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) throw new Error("This credential request is no longer waiting.");
    pending.settle("declined");
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

  endSession(sessionId: string): void {
    for (const pending of this.#pending.values()) {
      if (pending.metadata.sessionId === sessionId) pending.settle("still missing");
    }
    this.store.endSession(sessionId);
    this.#owners.delete(sessionId);
  }
}
