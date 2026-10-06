import { CredentialLockBusyError, retryWhileBusy } from "./credential-lock";
import type { CredentialStatus } from "./credential-state";

/**
 * Reads that encode contention in their status (rather than throwing) must
 * retry it explicitly. Keep the final snapshot and its status together; a
 * genuinely stuck lock answers busy after the bound, never stale ready.
 * Each attempt is synchronous; the thread and the lock are free between them.
 */
export async function waitForCredentialRead<T>(
  read: () => T,
  status: (result: T) => CredentialStatus,
  timeoutMs: number,
): Promise<T> {
  let last!: T;
  try {
    return await retryWhileBusy(() => {
      last = read();
      if (status(last).reason === "busy") throw new CredentialLockBusyError();
      return last;
    }, timeoutMs);
  } catch (error) {
    if (!(error instanceof CredentialLockBusyError)) throw error;
    return last;
  }
}
