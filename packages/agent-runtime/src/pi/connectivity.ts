/**
 * What the host can tell the runtime about the machine's network and sleep.
 *
 * A port rather than a probe, because the runtime is plain TypeScript and the
 * only honest sources — Electron's `net.isOnline()` and `powerMonitor` — live
 * in main. The runtime asks it two questions when a provider request has
 * failed for its transport (is there a network to retry on; wait until there
 * is) and listens for one event (the machine woke, so every socket opened
 * before it slept is suspect).
 *
 * `isOnline` answers the platform's opinion, which is "an interface is up", not
 * "the provider is reachable". It is only ever used to tell a machine with no
 * network apart from one whose network is failing, and the second case keeps
 * its bounded budget.
 */
export interface ConnectivityPort {
  isOnline(): boolean;
  /**
   * Resolves once the network is back. Rejects only when `signal` aborts — a
   * person pressed Stop, or the attachment closed — and the caller reads its
   * own state to tell which.
   */
  waitUntilOnline(signal: AbortSignal): Promise<void>;
  /** The machine woke from sleep. Returns the unsubscribe. */
  onResume(listener: () => void): () => void;
}

/**
 * The port for a host that knows nothing about its network: every test, and
 * any non-Electron host. Always online means every transient failure spends
 * the bounded online budget, which is exactly what the runtime did before the
 * port existed.
 */
export const ALWAYS_ONLINE: ConnectivityPort = {
  isOnline: () => true,
  waitUntilOnline: () => Promise.resolve(),
  onResume: () => () => undefined,
};
