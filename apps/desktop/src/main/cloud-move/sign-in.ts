/** A running move waits through account absence before reading fresh credentials. */
import type { AccountSnapshot } from "@volli/shared";

export function moveSignIn(options: {
  account: {
    snapshot(): AccountSnapshot;
    accessToken(): Promise<string | null>;
  };
  identity: {
    current(signal?: AbortSignal): Promise<{ userId: string; runnerId: string } | null>;
  };
  signal(): AbortSignal | undefined;
  waitForSignIn(signal: AbortSignal): Promise<boolean>;
}) {
  const absent = () => {
    const snapshot = options.account.snapshot();
    return snapshot.state !== "signed-in" || snapshot.account?.userId == null;
  };
  const read = async <T>(
    signal: AbortSignal | undefined,
    current: () => Promise<T | null>,
  ): Promise<T | null> => {
    for (;;) {
      if (signal !== undefined && !(await options.waitForSignIn(signal))) return null;
      const value = await current();
      if (signal?.aborted) return null;
      // Absence can begin during an async identity/token read, too. Discard
      // that result and read afresh after recovery, never reuse an old token.
      // Only an active lane has grace; context reads and new starts never wait.
      if (signal === undefined || !absent()) return value;
    }
  };
  return {
    current: () => {
      const signal = options.signal();
      return read(signal, () => options.identity.current(signal));
    },
    accessToken: async () => {
      const signal = options.signal();
      const token = await read(signal, () => options.account.accessToken());
      signal?.throwIfAborted();
      return token;
    },
  };
}
