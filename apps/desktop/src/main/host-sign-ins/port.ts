/**
 * Sign-ins on a remote host, wired to VC-700's engine (VC-702 PR 2).
 *
 * - {@link hostLinkSignIns}: one host's client link (`createHostLink`, VC-670)
 *   as the sign-in service's {@link HostSignInHostLink}. It calls the host's
 *   `sign-ins` and `auth.callback` operations and checks every answer against
 *   the published schemas, so a host that answers badly is a failure, never a
 *   row.
 * - {@link remoteSignInsPort}: the handler map's `hostSignIns.*` port over
 *   {@link HostSignInService}. A sign-in is keyed by host and provider, one at
 *   a time each, and lives as long as its `hostSignIns.run` stream: ending
 *   the stream cancels it on the host.
 * - {@link signInPreflight}: what `hosts.signIn` (the host chip's "Sign in
 *   again") does now. It answers once the host can take a sign-in; the window
 *   then opens that host's sign-in rows and starts the provider's sign-in
 *   through `hostSignIns.run`.
 */
import type { RemoteSignInsPort } from "@volli/host-core/handlers";
import type { HostLink } from "@volli/host-protocol/client-link";
import { hostSignInStatusSchema, hostSignInUpdateSchema } from "@volli/session-rpc";
import type { HostSignInStatus, HostSignInUpdate } from "@volli/shared";

import { HostUnreachableError, type HostSignInHostLink, type HostSignInService } from "./service";
import { isOpenableSignInUrl, REFUSED_SIGN_IN_LINK, type HostSignInRun } from "./sign-in-runner";

/** The update kinds this build reads; any other is a newer host's, and skipped. */
const KNOWN_UPDATE_KINDS: ReadonlySet<string> = new Set(
  hostSignInUpdateSchema.options.map((option) => option.shape.kind.value),
);

/**
 * Whether an update's page, if it names one, is one this Mac opens: an
 * http(s) page of bounded length. The published schema stays as it is (a
 * narrower output is a protocol break); the bound is this Client's own.
 */
function opensOnlyAWebPage(update: HostSignInUpdate): boolean {
  if (update.kind === "auth-url") return isOpenableSignInUrl(update.url);
  if (update.kind === "device-code") return isOpenableSignInUrl(update.verificationUri);
  return true;
}

/** The status a host answered, checked: a malformed answer is the host's failure. */
function status(value: unknown): HostSignInStatus {
  return hostSignInStatusSchema.parse(value);
}

/** One host's link as the sign-in service calls it. */
export function hostLinkSignIns(link: HostLink): HostSignInHostLink {
  return {
    status: async () => status(await link.query("signIns.status")),
    setApiKey: async (input) => status(await link.mutate("signIns.setApiKey", input)),
    setGitCredential: async (input) => status(await link.mutate("signIns.setGitCredential", input)),
    start: async (input) => {
      const answer = (await link.mutate("signIns.start", input)) as { flowId?: unknown };
      if (typeof answer?.flowId !== "string") throw new Error("The host started no sign-in.");
      return { flowId: answer.flowId };
    },
    subscribe: (flow, observer) =>
      link.subscribe("signIns.subscribe", flow, {
        onData: (data) => {
          const parsed = hostSignInUpdateSchema.safeParse(data);
          if (parsed.success && opensOnlyAWebPage(parsed.data as HostSignInUpdate)) {
            observer.onData(parsed.data as HostSignInUpdate);
            return;
          }
          // An update this build does not know (the union is open) is skipped;
          // a known one that breaks its schema ends the sign-in, here and on
          // the host. A page this Mac won't open is the one said by name.
          const kind = (data as { kind?: unknown } | null)?.kind;
          if (typeof kind !== "string" || !KNOWN_UPDATE_KINDS.has(kind)) return;
          void link.mutate("signIns.cancel", flow).catch(() => undefined);
          observer.onData({
            kind: "failed",
            message:
              kind === "auth-url" || kind === "device-code"
                ? REFUSED_SIGN_IN_LINK
                : "The host sent a sign-in step Volli can’t read",
          });
        },
        onResnapshot: (error) => observer.onError(error),
        onError: (error) => observer.onError(error),
        onComplete: () => observer.onComplete(),
      }),
    deliver: async (input) => {
      const answer = (await link.mutate("auth.callback.deliver", input)) as { status?: unknown };
      if (typeof answer?.status !== "number") throw new Error("The host did not say how it went.");
      return { status: answer.status };
    },
    answer: (input) => link.mutate("signIns.answer", input),
    cancel: (flow) => link.mutate("signIns.cancel", flow),
  };
}

/** Which of a host's links can take a sign-in now: the engine's `signInLink`. */
export interface SignInLinkSource {
  signInLink(hostId: string): HostLink | null;
}

/** The service's link lookup over the engine: a ready link granted `sign-ins`, or none. */
export function engineSignInLinks(engine: SignInLinkSource): {
  linkFor(hostId: string): HostSignInHostLink | null;
} {
  return {
    linkFor: (hostId) => {
      const link = engine.signInLink(hostId);
      return link === null ? null : hostLinkSignIns(link);
    },
  };
}

/** `hosts.signIn`: answers once the host can take a sign-in now; the window runs it. */
export async function signInPreflight(service: HostSignInService, hostId: string): Promise<void> {
  await service.status(hostId);
}

const runKey = (hostId: string, providerId: string): string => `${hostId}\u0000${providerId}`;

/** The handler map's `hostSignIns.*` port. */
export function remoteSignInsPort(service: HostSignInService): RemoteSignInsPort {
  const runs = new Map<string, HostSignInRun>();
  const running = (hostId: string, providerId: string): HostSignInRun => {
    const run = runs.get(runKey(hostId, providerId));
    if (run === undefined) throw new Error("That sign-in is no longer running.");
    return run;
  };
  return {
    status: (hostId) => service.status(hostId),
    macKeys: () => service.macKeys(),
    sendFromThisMac: (hostId, providerId) => service.sendFromThisMac(hostId, providerId, true),
    setApiKey: (hostId, providerId, key) => service.setApiKey(hostId, providerId, key),
    setGitCredential: (hostId, input) => service.setGitCredential(hostId, input),
    run(hostId, providerId, listener) {
      const key = runKey(hostId, providerId);
      // One at a time per host and provider: a new one replaces the old.
      void runs.get(key)?.cancel();
      const run = service.signInOnHost(hostId, providerId, (event) => void listener(event));
      runs.set(key, run);
      void run.ended.then(() => {
        if (runs.get(key) === run) runs.delete(key);
      });
      return () => {
        if (runs.get(key) !== run) return;
        runs.delete(key);
        void run.cancel();
      };
    },
    answer: async (hostId, providerId, promptId, value) => {
      await running(hostId, providerId).answer(promptId, value);
    },
    cancel: async (hostId, providerId) => {
      await runs.get(runKey(hostId, providerId))?.cancel();
    },
  };
}

export { HostUnreachableError };
