import type { RemoteHost, RemoteHostLink } from "./remote-hosts";
import { redactLogText } from "./structured-log";

/** Bounds for the additive host-health output, shared by its producer and wire validator. */
export const REMOTE_HOST_HEALTH_LIMITS = {
  hostId: 128,
  version: 128,
  providerId: 128,
  providerName: 120,
  sshCode: 128,
  errorCode: 128,
  errorReason: 128,
  diagnostic: 600,
  features: 256,
  feature: 128,
  signInExpiry: 128,
} as const;

const URL_SECRETS = /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@'"]*@)?([^\s?#'"]*)[?#][^\s'"]*/giu;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]*@/giu;

/** The existing host-project oneLine policy, also usable before renderer-local publication. */
export function remoteHostDiagnostic(
  text: string,
  max: number = REMOTE_HOST_HEALTH_LIMITS.diagnostic,
): string {
  const scrubbed = redactLogText(
    text
      .replace(/\bvdc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[redacted]")
      .replace(URL_SECRETS, "$1$2?[redacted]")
      .replace(URL_USERINFO, "$1[redacted]@"),
    Number.MAX_SAFE_INTEGER,
  );
  const line = scrubbed
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

type HostHealth = {
  reachability: RemoteHostLink;
  lastWelcome: NonNullable<RemoteHost["lastWelcome"]> | null;
  signInExpiry: NonNullable<RemoteHost["signInExpiry"]> | null;
  lastSshFailure: NonNullable<RemoteHost["lastSshFailure"]> | null;
};

/** Bound the producer's whole new envelope, without narrowing any previously published host fields. */
export function boundedRemoteHostHealth(health: HostHealth): HostHealth {
  const limits = REMOTE_HOST_HEALTH_LIMITS;
  const state = health.reachability.state;
  const welcome = health.lastWelcome;
  const failure = health.lastSshFailure;
  return {
    reachability: {
      ...health.reachability,
      state:
        "error" in state
          ? {
              ...state,
              error: {
                code: remoteHostDiagnostic(state.error.code, limits.errorCode),
                reason: remoteHostDiagnostic(state.error.reason, limits.errorReason),
                message: remoteHostDiagnostic(state.error.message),
              },
            }
          : state,
    },
    // Never truncate identity/version into a different fact: omit invalid evidence instead.
    lastWelcome:
      welcome === null ||
      welcome.hostId.length > limits.hostId ||
      welcome.version.length > limits.version
        ? null
        : {
            ...welcome,
            features: welcome.features
              .slice(0, limits.features)
              .map((feature) => feature.slice(0, limits.feature)),
          },
    signInExpiry:
      health.signInExpiry === null
        ? null
        : health.signInExpiry
            .filter((expiry) => expiry.providerId.length <= limits.providerId)
            .slice(0, limits.signInExpiry)
            .map((expiry) => ({
              providerId: expiry.providerId,
              name: remoteHostDiagnostic(expiry.name, limits.providerName),
              expiresAt: expiry.expiresAt,
              expired: expiry.expired,
            })),
    lastSshFailure:
      failure === null
        ? null
        : {
            code: remoteHostDiagnostic(failure.code, limits.sshCode),
            line: remoteHostDiagnostic(failure.line),
          },
  };
}
