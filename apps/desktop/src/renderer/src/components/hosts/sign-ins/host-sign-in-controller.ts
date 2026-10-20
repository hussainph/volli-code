/**
 * One host's sign-in rows, as state that changes (VC-702). The rows read
 * {@link HostSignInController.getSnapshot} through `useSyncExternalStore`;
 * every action is the person's explicit intent and goes to the
 * {@link HostSignInSource}.
 *
 * **The source is the seam.** Desktop main implements it over a host's link
 * (VC-700's host registry): it reads this Mac's own key for "Send from this
 * Mac" (the key never enters the renderer), runs the relay for a subscription
 * login, and calls the host. Tests and the lab use a fake. Nothing here holds
 * a credential: a pasted key passes straight through to the source.
 */
import { normalizeGitHost, type HostSignInRunEvent, type HostSignInStatus } from "@volli/shared";

import {
  IDLE,
  gitRowKey,
  providerRowKey,
  reduceSignIn,
  signInRowsOf,
  type RowFlow,
  type SignInRowView,
} from "./host-sign-in-model";

/** A sign-in running on the host, as this Mac drives it. */
export interface HostSignInRunHandle {
  /** Answers the step the flow waits on (the pasted redirect included). */
  answer(promptId: string, value: string): Promise<unknown>;
  cancel(): Promise<void>;
}

/** Why "Send from this Mac" sent nothing. */
export type SendRefusal = "no-key" | "subscription" | "send-failed";

/** What the rows need from one host, by host id. */
export interface HostSignInSource {
  /** The host's sign-ins: availability only. */
  status(hostId: string): Promise<HostSignInStatus>;
  /** The providers this Mac holds a key for: availability only, never a value. */
  macKeys(): Promise<readonly string[]>;
  /** After the person's confirm: this Mac's key for one provider, sent to the host. */
  sendFromThisMac(
    hostId: string,
    providerId: string,
  ): Promise<{ ok: true; status: HostSignInStatus } | { ok: false; reason: SendRefusal }>;
  /** A key the person pasted, stored on the host. */
  setApiKey(hostId: string, providerId: string, key: string): Promise<HostSignInStatus>;
  /** A push token the person pasted, stored on the host. */
  setGitCredential(
    hostId: string,
    input: { host: string; username: string; password: string },
  ): Promise<HostSignInStatus>;
  /** Runs a subscription login on the host; the relay and the browser are the source's. */
  signInOnHost(
    hostId: string,
    providerId: string,
    onEvent: (event: HostSignInRunEvent) => void,
  ): HostSignInRunHandle;
  /** Opens a page in this Mac's browser (a device code's verification page). */
  openExternal(url: string): void;
}

export interface HostSignInSnapshot {
  /** Null until the host has answered once. */
  readonly rows: readonly SignInRowView[] | null;
  readonly flows: Readonly<Record<string, RowFlow>>;
  /** The host could not be read; the rows keep what they last showed. */
  readonly unreachable: boolean;
}

const SEND_REFUSED: Record<SendRefusal, string> = {
  "no-key": "This Mac has no key for it to send",
  subscription: "A subscription signs in on the host, not from this Mac",
  "send-failed": "The key did not reach the host",
};

/** The events after which a row's sign-in holds nothing open. */
const RUN_ENDS: ReadonlySet<HostSignInRunEvent["kind"]> = new Set([
  "done",
  "failed",
  "cancelled",
  "lost",
]);

export class HostSignInController {
  readonly #source: HostSignInSource;
  readonly #hostId: string;
  readonly #listeners = new Set<() => void>();
  readonly #runs = new Map<string, HostSignInRunHandle>();
  #status: HostSignInStatus | null = null;
  #macKeys: ReadonlySet<string> = new Set();
  /** Hosts added on this surface only; storing a token makes the host's status own its row. */
  readonly #gitHosts = new Set<string>();
  #flows: Record<string, RowFlow> = {};
  #unreachable = false;
  /**
   * Bumped by {@link dispose}: work begun before answers into nothing. Not a
   * one-way flag, as StrictMode disposes a controller and then uses it again.
   */
  #epoch = 0;
  #snapshot: HostSignInSnapshot = { rows: null, flows: {}, unreachable: false };

  constructor(source: HostSignInSource, hostId: string) {
    this.#source = source;
    this.#hostId = hostId;
  }

  getSnapshot = (): HostSignInSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Reads the host's status and this Mac's keys again. */
  async refresh(): Promise<void> {
    const epoch = this.#epoch;
    try {
      const [status, macKeys] = await Promise.all([
        this.#source.status(this.#hostId),
        this.#source.macKeys(),
      ]);
      if (epoch !== this.#epoch) return;
      this.#status = status;
      this.#macKeys = new Set(macKeys);
      this.#unreachable = false;
    } catch {
      if (epoch !== this.#epoch) return;
      this.#unreachable = true;
    }
    this.#publish();
  }

  /** "Send from this Mac": first the confirm. */
  requestSend(providerId: string): void {
    this.#setFlow(providerRowKey(providerId), { kind: "confirm-send" });
  }

  /** The person confirmed: this Mac's key goes to the host. */
  async confirmSend(providerId: string): Promise<void> {
    const key = providerRowKey(providerId);
    if (this.#flows[key]?.kind !== "confirm-send") return;
    const shown = this.#show(key, { kind: "sending" });
    const sent = await this.#source.sendFromThisMac(this.#hostId, providerId).catch(() => ({
      ok: false as const,
      reason: "send-failed" as const,
    }));
    if (!shown()) return;
    if (sent.ok) {
      this.#status = sent.status;
      this.#setFlow(key, IDLE);
    } else {
      this.#setFlow(key, { kind: "failed", message: SEND_REFUSED[sent.reason] });
    }
  }

  /** Adds a git host on this surface and opens its token field; an invalid name changes nothing. */
  addGitHost(value: string): boolean {
    const host = normalizeGitHost(value);
    if (host === null) return false;
    this.#gitHosts.add(host);
    this.beginKeyEntry(gitRowKey(host));
    return true;
  }

  /** Paste instead: open the key field. */
  beginKeyEntry(rowKey: string): void {
    this.#setFlow(rowKey, { kind: "key-entry" });
  }

  /** A pasted key for a provider, or a pasted token for a git host. */
  async submitKey(row: SignInRowView, value: string, username = "x-access-token"): Promise<void> {
    if (value.length === 0) return;
    const shown = this.#show(row.key, { kind: "saving" });
    try {
      const status = await (row.kind === "git"
        ? this.#source.setGitCredential(this.#hostId, {
            host: row.id,
            username,
            password: value,
          })
        : this.#source.setApiKey(this.#hostId, row.id, value));
      if (!shown()) return;
      this.#status = status;
      this.#setFlow(row.key, IDLE);
    } catch {
      if (!shown()) return;
      this.#setFlow(row.key, { kind: "failed", message: `${row.label} was not saved on the host` });
    }
  }

  /** Signs a subscription in on the host; the row follows the flow and turns signed-in by itself. */
  beginSignIn(providerId: string): void {
    const key = providerRowKey(providerId);
    if (this.#runs.has(key)) return;
    this.#setFlow(key, reduceSignIn(IDLE, { kind: "progress", message: "Starting" }));
    let current: HostSignInRunHandle | null = null;
    const run = this.#source.signInOnHost(this.#hostId, providerId, (event) => {
      // A run this surface cancelled, or one a newer run replaced, has no say.
      if (current !== null && this.#runs.get(key) !== current) return;
      // The row's flow was set above, before the run could say anything.
      this.#setFlow(key, reduceSignIn(this.#flows[key]!, event));
      if (RUN_ENDS.has(event.kind)) {
        this.#runs.delete(key);
        if (event.kind === "done") void this.refresh();
      }
    });
    current = run;
    this.#runs.set(key, run);
  }

  /** The pasted redirect (or any other step's answer) for a running sign-in. */
  async answer(providerId: string, value: string): Promise<void> {
    const key = providerRowKey(providerId);
    const flow = this.#flows[key];
    const run = this.#runs.get(key);
    if (run === undefined || flow?.kind !== "signing-in" || flow.prompt === null) return;
    const promptId = flow.prompt.promptId;
    this.#setFlow(key, { ...flow, prompt: null });
    await run.answer(promptId, value).catch(() => {
      // Only while this run is still the row's: a cancelled or replaced one,
      // or one the surface let go of, has no say over it.
      if (this.#runs.get(key) !== run) return;
      this.#setFlow(key, { kind: "failed", message: "The host did not take that answer" });
    });
  }

  /** Opens a device code's page in this Mac's browser. */
  openPage(url: string): void {
    this.#source.openExternal(url);
  }

  /** Cancels whatever the row is doing; a running sign-in is cancelled on the host. */
  cancel(rowKey: string): void {
    const run = this.#runs.get(rowKey);
    this.#runs.delete(rowKey);
    if (run !== undefined) void run.cancel();
    this.#setFlow(rowKey, IDLE);
  }

  /** Cancels every running sign-in: the surface went away. */
  dispose(): void {
    this.#epoch += 1;
    for (const run of this.#runs.values()) void run.cancel();
    this.#runs.clear();
    this.#listeners.clear();
  }

  /**
   * Shows `flow` on a row while asking the host, and answers whether the row
   * still shows it: an answer that arrives after the person moved on, or the
   * surface went, changes nothing.
   */
  #show(key: string, flow: RowFlow): () => boolean {
    const epoch = this.#epoch;
    this.#setFlow(key, flow);
    return () => this.#epoch === epoch && this.#flows[key] === flow;
  }

  #setFlow(key: string, flow: RowFlow): void {
    this.#flows = { ...this.#flows, [key]: flow };
    this.#publish();
  }

  #publish(): void {
    this.#snapshot = {
      rows:
        this.#status === null
          ? null
          : signInRowsOf(this.#status, this.#macKeys, [...this.#gitHosts]),
      flows: this.#flows,
      unreachable: this.#unreachable,
    };
    for (const listener of this.#listeners) listener();
  }
}
