/**
 * Which sign-in provider, backend, HTTP-actions site and transcript store this build talks to.
 *
 * A packaged build uses only its compiled public deployment config (or is
 * `unconfigured` when the build names none). An
 * unpackaged build reads them from its environment:
 *
 * - `VOLLI_ACCOUNT_PROVIDER=dev`: the local dev issuer (`./dev-issuer`),
 *   signing with `VOLLI_CONVEX_TEST_PRIVATE_KEY`, the fixture key
 *   `pnpm -C convex with-backend --deploy -- …` hands what it runs (with
 *   `VOLLI_CONVEX_URL`). Optional `VOLLI_ACCOUNT_DEV_SUBJECT` names who signs in.
 * - `VOLLI_WORKOS_CLIENT_ID` (and optionally `VOLLI_WORKOS_API_BASE`): a
 *   WorkOS environment, normally its staging one.
 * - `VOLLI_CONVEX_URL`: the backend `accounts.ensureViewer` runs on.
 * - `VOLLI_CONVEX_SITE_URL`: the explicit HTTP-actions origin (never inferred).
 * - `VOLLI_CLOUD_STORAGE_ORIGIN`: the exact transcript-store origin (HTTPS,
 *   or HTTP loopback for a local fixture, as with the backend URLs).
 * Invalid dev origins become `problem` plus null, never a startup exception.
 *
 * A packaged build ignores all of these: its sign-in is never redirected by
 * an environment variable.
 */
import { exactOrigin, type PackagedCloudConfig } from "../deployment-config";

export type AccountProviderConfig =
  | { readonly kind: "workos"; readonly clientId: string; readonly apiBase: string | null }
  | {
      readonly kind: "dev";
      readonly privateKeyPem: string;
      readonly subject: string | null;
      readonly email?: string;
    };

export interface AccountConfig {
  readonly provider: AccountProviderConfig | null;
  /** The Convex deployment URL, or `null` when this build names none. */
  readonly backendUrl: string | null;
  /** HTTP actions for runner credential exchange; never derived from the backend hostname. */
  readonly siteUrl: string | null;
  /** Exact origin for visibility-authorized transcript GETs, not a public bucket. */
  readonly storageOrigin: string | null;
  /** Why the environment named something unusable, for main's log; `null` when nothing was. */
  readonly problem: string | null;
}

function value(env: Readonly<Record<string, string | undefined>>, name: string): string | null {
  const raw = env[name]?.trim();
  return raw === undefined || raw === "" ? null : raw;
}

function httpUrl(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? raw : null;
  } catch {
    return null;
  }
}

export function resolveAccountConfig(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly packaged: boolean;
  /** Compiled into main by the release build. Packaged runtime environment is never consulted. */
  readonly build?: PackagedCloudConfig | null;
}): AccountConfig {
  if (input.packaged) {
    return input.build == null
      ? { provider: null, backendUrl: null, siteUrl: null, storageOrigin: null, problem: null }
      : {
          provider: { kind: "workos", clientId: input.build.workosClientId, apiBase: null },
          backendUrl: input.build.backendUrl,
          siteUrl: input.build.siteUrl,
          storageOrigin: input.build.storageOrigin,
          problem: null,
        };
  }
  const { env } = input;
  const problems: string[] = [];
  const origin = (name: string, allowLoopback: boolean) => {
    const raw = value(env, name);
    if (raw === null) return null;
    try {
      return exactOrigin(raw, allowLoopback);
    } catch {
      problems.push(`${name} is not an exact permitted origin`);
      return null;
    }
  };
  const backendUrl = origin("VOLLI_CONVEX_URL", true);
  const siteUrl = origin("VOLLI_CONVEX_SITE_URL", true);
  const storageOrigin = origin("VOLLI_CLOUD_STORAGE_ORIGIN", true);
  let provider: AccountProviderConfig | null = null;
  const requested = value(env, "VOLLI_ACCOUNT_PROVIDER");
  const clientId = value(env, "VOLLI_WORKOS_CLIENT_ID");
  if (requested === "dev") {
    const privateKeyPem = value(env, "VOLLI_CONVEX_TEST_PRIVATE_KEY");
    if (privateKeyPem === null) {
      problems.push("VOLLI_ACCOUNT_PROVIDER=dev needs VOLLI_CONVEX_TEST_PRIVATE_KEY");
    } else {
      const email = value(env, "VOLLI_ACCOUNT_DEV_EMAIL");
      provider = {
        kind: "dev",
        privateKeyPem,
        subject: value(env, "VOLLI_ACCOUNT_DEV_SUBJECT"),
        ...(email === null ? {} : { email }),
      };
    }
  } else if (requested !== null && requested !== "workos") {
    problems.push(`VOLLI_ACCOUNT_PROVIDER must be "dev" or "workos"`);
  } else if (clientId !== null) {
    const rawBase = value(env, "VOLLI_WORKOS_API_BASE");
    const apiBase = httpUrl(rawBase);
    if (rawBase !== null && apiBase === null) problems.push("VOLLI_WORKOS_API_BASE is not a URL");
    provider = { kind: "workos", clientId, apiBase };
  } else if (requested === "workos") {
    problems.push("VOLLI_ACCOUNT_PROVIDER=workos needs VOLLI_WORKOS_CLIENT_ID");
  }
  return {
    provider,
    backendUrl,
    siteUrl,
    storageOrigin,
    problem: problems.length === 0 ? null : problems.join("; "),
  };
}
