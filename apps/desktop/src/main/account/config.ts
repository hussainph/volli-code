/**
 * Which sign-in provider and backend this build talks to.
 *
 * No WorkOS environment or Convex deployment exists yet, so a packaged build
 * names neither and its account is `unconfigured`; the release pipeline bakes
 * them in once they exist (the go-live checklist on VC-884). An unpackaged
 * build reads them from its environment:
 *
 * - `VOLLI_ACCOUNT_PROVIDER=dev`: the local dev issuer (`./dev-issuer`),
 *   signing with `VOLLI_CONVEX_TEST_PRIVATE_KEY`, the fixture key
 *   `pnpm -C convex with-backend --deploy -- …` hands what it runs (with
 *   `VOLLI_CONVEX_URL`). Optional `VOLLI_ACCOUNT_DEV_SUBJECT` names who signs in.
 * - `VOLLI_WORKOS_CLIENT_ID` (and optionally `VOLLI_WORKOS_API_BASE`): a
 *   WorkOS environment, normally its staging one.
 * - `VOLLI_CONVEX_URL`: the backend `accounts.ensureViewer` runs on.
 *
 * A packaged build ignores all of these: its sign-in is never redirected by
 * an environment variable.
 */
export type AccountProviderConfig =
  | { readonly kind: "workos"; readonly clientId: string; readonly apiBase: string | null }
  | { readonly kind: "dev"; readonly privateKeyPem: string; readonly subject: string | null };

export interface AccountConfig {
  readonly provider: AccountProviderConfig | null;
  /** The Convex deployment URL, or `null` when this build names none. */
  readonly backendUrl: string | null;
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
}): AccountConfig {
  if (input.packaged) return { provider: null, backendUrl: null, problem: null };
  const { env } = input;
  const rawBackend = value(env, "VOLLI_CONVEX_URL");
  const backendUrl = httpUrl(rawBackend);
  const problems: string[] = [];
  if (rawBackend !== null && backendUrl === null) problems.push("VOLLI_CONVEX_URL is not a URL");
  let provider: AccountProviderConfig | null = null;
  const requested = value(env, "VOLLI_ACCOUNT_PROVIDER");
  const clientId = value(env, "VOLLI_WORKOS_CLIENT_ID");
  if (requested === "dev") {
    const privateKeyPem = value(env, "VOLLI_CONVEX_TEST_PRIVATE_KEY");
    if (privateKeyPem === null) {
      problems.push("VOLLI_ACCOUNT_PROVIDER=dev needs VOLLI_CONVEX_TEST_PRIVATE_KEY");
    } else {
      provider = { kind: "dev", privateKeyPem, subject: value(env, "VOLLI_ACCOUNT_DEV_SUBJECT") };
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
  return { provider, backendUrl, problem: problems.length === 0 ? null : problems.join("; ") };
}
