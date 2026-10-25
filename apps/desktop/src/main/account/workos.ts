/**
 * The WorkOS AuthKit adapter: WorkOS User Management as a public client, PKCE
 * in place of a client secret (no API key ships in the app).
 *
 * - Authorize: `GET {api}/user_management/authorize` with `provider` set to
 *   `GitHubOAuth` or `GoogleOAuth`, so the button skips AuthKit's chooser.
 * - Code and refresh: `POST {api}/user_management/authenticate`, JSON, with
 *   `client_id` and no secret. Refresh tokens rotate.
 * - Sign-out: the browser visits `{api}/user_management/sessions/logout`,
 *   which ends the hosted session cookie.
 *
 * Config-driven (the environment's client id; its API base), and untested
 * against WorkOS itself until the account exists: the request shapes are
 * held by `workos.test.ts` against a stand-in server.
 */
import type { AccountConnection } from "@volli/shared";

import {
  postTokenRequest,
  tokensFrom,
  type AccountProvider,
  type AuthorizationRequest,
  type ProviderTokens,
} from "./provider";

export const WORKOS_DEFAULT_API_BASE = "https://api.workos.com";

/** WorkOS's names for the two buttons' identity providers. */
export const WORKOS_PROVIDERS: Readonly<Record<AccountConnection, string>> = {
  github: "GitHubOAuth",
  google: "GoogleOAuth",
};

export interface WorkosProviderOptions {
  /** The WorkOS environment's client id (`client_…`). */
  readonly clientId: string;
  /** Defaults to {@link WORKOS_DEFAULT_API_BASE}; a custom auth domain later. */
  readonly apiBase?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

function profileOf(body: Record<string, unknown>): ProviderTokens["profile"] {
  const user = body["user"];
  if (user === null || typeof user !== "object") return { displayName: null, email: null };
  const fields = user as Record<string, unknown>;
  const name = [fields["first_name"], fields["last_name"]]
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .join(" ");
  return {
    displayName: name === "" ? null : name,
    email: typeof fields["email"] === "string" ? fields["email"] : null,
  };
}

export function workosProvider(options: WorkosProviderOptions): AccountProvider {
  const apiBase = (options.apiBase ?? WORKOS_DEFAULT_API_BASE).replace(/\/+$/u, "");
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const authenticate = async (grant: Record<string, string>): Promise<ProviderTokens> => {
    const body = await postTokenRequest(fetchImpl, `${apiBase}/user_management/authenticate`, {
      contentType: "application/json",
      body: JSON.stringify({ client_id: options.clientId, ...grant }),
    });
    return tokensFrom(body, now(), profileOf(body));
  };
  return {
    kind: "workos",
    async authorizationUrl(request: AuthorizationRequest) {
      const url = new URL(`${apiBase}/user_management/authorize`);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: options.clientId,
        redirect_uri: request.redirectUri,
        state: request.state,
        code_challenge: request.codeChallenge,
        code_challenge_method: "S256",
        provider: WORKOS_PROVIDERS[request.connection],
      }).toString();
      return url.toString();
    },
    exchangeCode: ({ code, codeVerifier }) =>
      authenticate({ grant_type: "authorization_code", code, code_verifier: codeVerifier }),
    refresh: (refreshToken) =>
      authenticate({ grant_type: "refresh_token", refresh_token: refreshToken }),
    logoutUrl(sessionId) {
      const url = new URL(`${apiBase}/user_management/sessions/logout`);
      url.searchParams.set("session_id", sessionId);
      return url.toString();
    },
  };
}
