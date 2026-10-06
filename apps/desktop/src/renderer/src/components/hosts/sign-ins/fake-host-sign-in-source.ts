/**
 * A host's sign-ins with nothing behind them, for tests and the lab (VC-702).
 * Every answer is scripted; no key is read from anywhere and nothing is sent.
 * The real source is desktop main's, over a host's link (VC-700).
 */
import type { HostSignInRunEvent, HostSignInStatus } from "@volli/shared";

import type { HostSignInRunHandle, HostSignInSource, SendRefusal } from "./host-sign-in-controller";

export interface FakeHostSignInSource extends HostSignInSource {
  /** What each call asked for, in order; a pasted value is recorded as its length only. */
  readonly calls: string[];
  /** The running sign-ins' event sinks, by provider id, so a test plays the host. */
  readonly running: Map<string, (event: HostSignInRunEvent) => void>;
  /** The answers each running sign-in received. */
  readonly answers: { providerId: string; promptId: string; length: number }[];
  setStatus(status: HostSignInStatus): void;
  failNextStatus(): void;
}

export function fakeHostSignInSource(input: {
  status: HostSignInStatus;
  macKeys?: readonly string[];
  /** What "Send from this Mac" answers. */
  send?: { ok: true; status: HostSignInStatus } | { ok: false; reason: SendRefusal };
}): FakeHostSignInSource {
  let status = input.status;
  let failStatus = false;
  const calls: string[] = [];
  const running = new Map<string, (event: HostSignInRunEvent) => void>();
  const answers: { providerId: string; promptId: string; length: number }[] = [];
  return {
    calls,
    running,
    answers,
    setStatus: (next) => {
      status = next;
    },
    failNextStatus: () => {
      failStatus = true;
    },
    status: async (hostId) => {
      calls.push(`status ${hostId}`);
      if (failStatus) {
        failStatus = false;
        throw new Error("host-unreachable");
      }
      return status;
    },
    macKeys: async () => input.macKeys ?? [],
    sendFromThisMac: async (hostId, providerId) => {
      calls.push(`send ${hostId} ${providerId}`);
      const sent = input.send ?? { ok: true as const, status };
      if (sent.ok) status = sent.status;
      return sent;
    },
    setApiKey: async (hostId, providerId, key) => {
      calls.push(`setApiKey ${hostId} ${providerId} (${key.length})`);
      return status;
    },
    setGitCredential: async (hostId, credential) => {
      calls.push(`setGitCredential ${hostId} ${credential.host} (${credential.password.length})`);
      return status;
    },
    signInOnHost: (hostId, providerId, onEvent): HostSignInRunHandle => {
      calls.push(`signIn ${hostId} ${providerId}`);
      running.set(providerId, onEvent);
      return {
        answer: async (promptId, value) => {
          answers.push({ providerId, promptId, length: value.length });
        },
        cancel: async () => {
          calls.push(`cancel ${providerId}`);
          running.get(providerId)?.({ kind: "cancelled" });
        },
      };
    },
    openExternal: (url) => {
      calls.push(`open ${url}`);
    },
  };
}
