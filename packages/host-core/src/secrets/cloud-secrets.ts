/**
 * Volli Cloud team secrets on the runner: the fetch-and-inject seam.
 *
 * When a runner's product store is the cloud, a Session's team secrets
 * (Workspace, project and the owner's personal ones, already resolved by the
 * backend for this Session's claim) arrive through a {@link CloudSecretSource}
 * the cloud store supplies: it asks the backend's runner door with the
 * runner's own token and returns the response body as received. This module
 * owns everything after that:
 *
 * - the body is checked with the shared codec (`parseRunnerSecretSet`) and
 *   must answer THIS Session's claim, for the Session purpose; anything else
 *   is refused whole, never partly injected;
 * - every `secret` value joins the store's redaction history BEFORE it is
 *   returned for injection (`SecretStore.adoptDelivered`), so output, tool
 *   results, shell spills and anything later uploaded are scrubbed of it.
 *   `env` values are not: they are plain by kind, shown to every reader, and
 *   scrubbing `1` or `development` from all output would only mangle it;
 * - the set is held in memory only, fetched at a Session's first command,
 *   asked for again after {@link CLOUD_SECRETS_MAX_AGE_MS} (so a rotation, a
 *   removal or a revoked membership reaches a long-running Session) and
 *   dropped when the Session's secrets end; it is never written to the
 *   Working copy, the ledger, a transcript or a log.
 *
 * With the `local` product store there is no source and nothing here runs.
 */

import { parseRunnerSecretSet, type SecretPurpose } from "@volli/shared/cloud";

import type { SecretStore } from "./store";

/** Asks the backend for a claimed Session's resolved set. Supplied by the cloud product store. */
export interface CloudSecretSource {
  /**
   * The response body for `sessionId`'s set, as received (unparsed). Rejects
   * on a refusal (not claimed, revoked, not a member) or a transport failure;
   * the command that asked fails and the next one asks again.
   */
  fetch(input: { sessionId: string; purpose: SecretPurpose }): Promise<unknown>;
}

export class CloudSecretsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CloudSecretsError";
  }
}

/** How long a fetched set serves a Session's commands before it is asked for again. */
export const CLOUD_SECRETS_MAX_AGE_MS = 5 * 60 * 1000;

interface HeldSet {
  readonly at: number;
  readonly set: Promise<Record<string, string>>;
}

/** Per-Session team environments, held in memory. */
export class CloudSessionSecrets {
  readonly #sets = new Map<string, HeldSet>();
  readonly #source: CloudSecretSource;
  readonly #store: Pick<SecretStore, "adoptDelivered">;
  readonly #now: () => number;

  constructor(
    source: CloudSecretSource,
    store: Pick<SecretStore, "adoptDelivered">,
    now: () => number = () => Date.now(),
  ) {
    this.#source = source;
    this.#store = store;
    this.#now = now;
  }

  /**
   * The Session's team environment for its tools. Concurrent callers share
   * one fetch; `signal` abandons this caller's wait, not the shared fetch.
   */
  environment(sessionId: string, signal?: AbortSignal): Promise<Record<string, string>> {
    let held = this.#sets.get(sessionId);
    if (held === undefined || this.#now() - held.at >= CLOUD_SECRETS_MAX_AGE_MS) {
      const fetching: HeldSet = { at: this.#now(), set: this.#fetch(sessionId) };
      held = fetching;
      this.#sets.set(sessionId, fetching);
      // A failed fetch is not remembered: the next command asks again.
      fetching.set.catch(() => {
        if (this.#sets.get(sessionId) === fetching) this.#sets.delete(sessionId);
      });
    }
    return signal === undefined ? held.set : abandonable(held.set, signal);
  }

  /** Forgets a Session's set: the next attachment fetches what is current then. */
  end(sessionId: string): void {
    this.#sets.delete(sessionId);
  }

  async #fetch(sessionId: string): Promise<Record<string, string>> {
    const body = await this.#source.fetch({ sessionId, purpose: "session" });
    let set;
    try {
      set = parseRunnerSecretSet(body);
    } catch (error) {
      throw new CloudSecretsError("The team secrets the backend sent could not be read.", {
        cause: error,
      });
    }
    if (
      set.claim.kind !== "session" ||
      set.claim.sessionId !== sessionId ||
      set.purpose !== "session"
    ) {
      throw new CloudSecretsError("The backend sent team secrets for a different claim.");
    }
    // Redaction first: no value is handed out before it can be scrubbed.
    this.#store.adoptDelivered(set.entries.filter((entry) => entry.kind === "secret"));
    return Object.fromEntries(set.entries.map((entry) => [entry.name, entry.value]));
  }
}

function abandonable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abandon = () => reject(signal.reason);
    signal.addEventListener("abort", abandon, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abandon));
  });
}
