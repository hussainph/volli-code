/**
 * When desktop reconciles the web search keys' sealed mirror (VC-643, step E),
 * and when it must stop.
 *
 * - **After first paint, once.** The launch reconcile waits out first paint
 *   and boot, like the transcript repack. It is unattended, so it may fetch
 *   the keychain's key only if this launch has already used the keychain
 *   successfully ({@link observeKeychainUse}); otherwise the mirror stays
 *   pending and the next save or clear a person makes seals it. No new
 *   unattended keychain access, and nothing reads the mirror in step E.
 * - **Never into a quit.** {@link WebSealingLifecycle.stop} runs the moment
 *   the accepted-quit coordinator accepts a quit (`quit-gate.ts`): the launch
 *   timer is cancelled, a busy retry stops, a keychain fetch in flight is
 *   abandoned rather than awaited, and nothing starts afterwards. The keychain
 *   is only ever asked asynchronously (`keychainCredentialKeyring`), so a
 *   fetch already in flight cannot hold Electron's main thread either.
 */

/** What this drives: `WebAccessSettings`. */
export interface WebSealingTarget {
  /** The unattended launch reconcile. Never rejects. */
  reconcileSealing(): Promise<unknown>;
  /** Ends sealing for this launch. */
  stopSealing(): void;
}

export interface WebSealingLifecycle {
  /** Schedules the launch reconcile, `delayMs` from now, unless quit was accepted. Once. */
  afterFirstPaint(): void;
  /** An accepted quit: cancels the timer and stops the mirror. Idempotent; never throws past it. */
  stop(): void;
}

/** How long after first paint the launch reconcile waits. */
export const WEB_SEALING_LAUNCH_DELAY_MS = 5_000;

export function webSealingLifecycle(
  target: WebSealingTarget | null,
  options: { delayMs?: number } = {},
): WebSealingLifecycle {
  const delayMs = options.delayMs ?? WEB_SEALING_LAUNCH_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let scheduled = false;
  let stopped = false;
  return {
    afterFirstPaint() {
      if (target === null || stopped || scheduled) return;
      scheduled = true;
      timer = setTimeout(() => {
        timer = null;
        void target.reconcileSealing();
      }, delayMs);
      // Never what keeps the process alive.
      timer.unref();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      target?.stopSealing();
    },
  };
}

/** The synchronous part of Electron's `safeStorage` the `VSC1` Session-secrets codec uses. */
export interface SyncKeychain {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}

/**
 * Whether this launch has already used the keychain successfully: the
 * Session-secrets store wrapped or unwrapped its key, or the pre-023 web keys
 * were carried out of it. `keychain` is what the store is given instead of
 * `safeStorage`; it forwards every call unchanged and only notes success.
 */
export function observeKeychainUse(source: SyncKeychain): {
  keychain: SyncKeychain;
  used(): boolean;
  markUsed(): void;
} {
  let used = false;
  const keychain: SyncKeychain = {
    isEncryptionAvailable: () => source.isEncryptionAvailable(),
    encryptString(value) {
      const sealed = source.encryptString(value);
      used = true;
      return sealed;
    },
    decryptString(value) {
      const plain = source.decryptString(value);
      used = true;
      return plain;
    },
  };
  if (typeof source.getSelectedStorageBackend === "function") {
    keychain.getSelectedStorageBackend = () => source.getSelectedStorageBackend!();
  }
  return {
    keychain,
    used: () => used,
    markUsed() {
      used = true;
    },
  };
}
