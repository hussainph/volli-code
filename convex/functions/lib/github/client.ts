/**
 * A small GitHub REST client for the App's backend calls, over `fetch`.
 *
 * Every failure is a {@link GithubApiError} with a typed `kind`: a rate limit
 * (with when it resets), GitHub being unreachable or failing, a 401, a 404,
 * or a refusal. Rate-limit headers are logged per credential class when a
 * budget runs low, never a token. Base URLs come from the App configuration,
 * so tests run against a fake GitHub.
 */

import {
  readGithubInstallation,
  readVerifiedGithubEmails,
  type GithubEmail,
  type GithubInstallationFacts,
} from "@volli/shared/cloud";

import type { GithubAppConfig } from "./config";

export type GithubCredential =
  | { readonly kind: "user"; readonly token: string }
  | { readonly kind: "installation"; readonly token: string }
  | { readonly kind: "app"; readonly jwt: string }
  | { readonly kind: "client" }
  /** GitHub's OAuth token endpoint: the client id and secret ride in the body. */
  | { readonly kind: "oauth" };

export type GithubApiErrorKind =
  | "rate_limited"
  | "unavailable"
  | "unauthorized"
  | "not_found"
  | "refused";

export class GithubApiError extends Error {
  override readonly name = "GithubApiError";
  constructor(
    readonly kind: GithubApiErrorKind,
    readonly status: number,
    message: string,
    /** When the rate limit resets (epoch ms), for `rate_limited`. */
    readonly resetAt: number | null = null,
    /** GitHub's OAuth `error` code, for the token endpoint's refusals. */
    readonly oauthError: string | null = null,
  ) {
    super(message);
  }
}

/** A user access token pair as GitHub's token endpoint returns it. */
export interface GithubTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
}

export interface GithubUser {
  readonly githubUserId: string;
  readonly login: string;
  readonly name: string | null;
}

export interface GithubRepository {
  readonly githubRepoId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string | null;
  readonly archived: boolean;
}

export interface GithubDelivery {
  readonly id: string;
  readonly guid: string;
  readonly deliveredAt: number;
  readonly ok: boolean;
}

/** At most this many pages of 100 are read from any list. */
const MAX_PAGES = 10;
const LOW_BUDGET = 500;
const TIMEOUT_MS = 8_000;
/** The token endpoint gets longer: a refresh it answers late has already rotated the pair. */
const TOKEN_TIMEOUT_MS = 20_000;

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function idText(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^[0-9]+$/u.test(value)) return value;
  return null;
}

function nextLink(headers: Headers): string | null {
  const link = headers.get("link");
  if (link === null) return null;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/u.exec(part);
    if (match) return match[1]!;
  }
  return null;
}

function readRepository(value: unknown): GithubRepository | null {
  const repo = record(value);
  const githubRepoId = idText(repo["id"]);
  const owner = record(repo["owner"])["login"];
  const name = repo["name"];
  if (githubRepoId === null || typeof owner !== "string" || typeof name !== "string") return null;
  return {
    githubRepoId,
    owner,
    name,
    defaultBranch: typeof repo["default_branch"] === "string" ? repo["default_branch"] : null,
    archived: repo["archived"] === true,
  };
}

export function githubClient(
  config: GithubAppConfig,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
) {
  const apiOrigin = new URL(config.apiUrl).origin;

  async function send(
    credential: GithubCredential,
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown; headers: Headers }> {
    const headers: Record<string, string> = {
      // The token endpoint answers form-encoded unless asked for JSON.
      accept: credential.kind === "oauth" ? "application/json" : "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": `${config.slug}-volli`,
    };
    if (credential.kind === "user" || credential.kind === "installation") {
      headers["authorization"] = `Bearer ${credential.token}`;
    } else if (credential.kind === "app") {
      headers["authorization"] = `Bearer ${credential.jwt}`;
    } else if (credential.kind === "client") {
      headers["authorization"] = `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`;
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(credential.kind === "oauth" ? TOKEN_TIMEOUT_MS : TIMEOUT_MS),
      });
    } catch {
      throw new GithubApiError("unavailable", 0, "GitHub is unavailable.");
    }
    const remaining = Number(response.headers.get("x-ratelimit-remaining") ?? Number.NaN);
    const reset = Number(response.headers.get("x-ratelimit-reset") ?? Number.NaN);
    if (Number.isFinite(remaining) && remaining < LOW_BUDGET) {
      console.warn(
        `github: ${credential.kind} budget low (${remaining} left, resets ${Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : "?"})`,
      );
    }
    let json: unknown = null;
    const textBody = await response.text();
    if (textBody !== "") {
      try {
        json = JSON.parse(textBody);
      } catch {
        json = null;
      }
    }
    const status = response.status;
    if (status >= 200 && status < 300) return { status, json, headers: response.headers };
    const message = String(record(json)["message"] ?? `GitHub answered ${status}.`).slice(0, 300);
    const retryAfter = Number(response.headers.get("retry-after") ?? Number.NaN);
    if ((status === 403 || status === 429) && (remaining === 0 || Number.isFinite(retryAfter))) {
      const resetAt = Number.isFinite(retryAfter)
        ? Date.now() + retryAfter * 1000
        : Number.isFinite(reset)
          ? reset * 1000
          : null;
      throw new GithubApiError("rate_limited", status, message, resetAt);
    }
    if (status === 401) throw new GithubApiError("unauthorized", status, message);
    if (status === 404) throw new GithubApiError("not_found", status, message);
    if (status >= 500) throw new GithubApiError("unavailable", status, message);
    throw new GithubApiError("refused", status, message);
  }

  const api = (credential: GithubCredential, method: string, path: string, body?: unknown) =>
    send(credential, method, `${config.apiUrl}${path}`, body);

  /**
   * Every page of a list (100 a page, at most {@link MAX_PAGES}); `complete`
   * is false when the limit cut it short.
   */
  async function pages(
    credential: GithubCredential,
    path: string,
    items: (json: unknown) => unknown[],
  ): Promise<{ items: unknown[]; complete: boolean }> {
    const out: unknown[] = [];
    let url: string | null = `${config.apiUrl}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    for (let page = 0; url !== null && page < MAX_PAGES; page += 1) {
      const { json, headers } = await send(credential, "GET", url);
      out.push(...items(json));
      const next = nextLink(headers);
      // Follow GitHub's own pagination only, never a link to elsewhere.
      url = next !== null && new URL(next).origin === apiOrigin ? next : null;
    }
    return { items: out, complete: url === null };
  }

  async function tokenRequest(params: Record<string, string>): Promise<GithubTokenSet> {
    const now = Date.now();
    const { json } = await send(
      { kind: "oauth" },
      "POST",
      `${config.webUrl}/login/oauth/access_token`,
      {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...params,
      },
    );
    const body = record(json);
    if (typeof body["error"] === "string") {
      throw new GithubApiError(
        "refused",
        200,
        String(body["error_description"] ?? body["error"]).slice(0, 300),
        null,
        body["error"],
      );
    }
    const accessToken = body["access_token"];
    const refreshToken = body["refresh_token"];
    const expiresIn = Number(body["expires_in"]);
    const refreshExpiresIn = Number(body["refresh_token_expires_in"]);
    if (
      typeof accessToken !== "string" ||
      typeof refreshToken !== "string" ||
      !Number.isFinite(expiresIn) ||
      !Number.isFinite(refreshExpiresIn)
    ) {
      // The App must keep "Expire user authorization tokens" on.
      throw new GithubApiError("refused", 200, "GitHub did not return an expiring token pair.");
    }
    return {
      accessToken,
      refreshToken,
      accessExpiresAt: now + expiresIn * 1000,
      refreshExpiresAt: now + refreshExpiresIn * 1000,
    };
  }

  return {
    /** The web flow's code exchange (with the PKCE verifier). */
    exchangeCode: (code: string, codeVerifier: string, redirectUri: string) =>
      tokenRequest({ code, code_verifier: codeVerifier, redirect_uri: redirectUri }),

    /** A refresh: a new pair, and the old access and refresh tokens stop working. */
    refresh: (refreshToken: string) =>
      tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }),

    async user(token: string): Promise<GithubUser> {
      const { json } = await api({ kind: "user", token }, "GET", "/user");
      const body = record(json);
      const githubUserId = idText(body["id"]);
      if (githubUserId === null || typeof body["login"] !== "string") {
        throw new GithubApiError("unavailable", 200, "GitHub answered with an unreadable user.");
      }
      return {
        githubUserId,
        login: body["login"],
        name: typeof body["name"] === "string" && body["name"] !== "" ? body["name"] : null,
      };
    },

    async userEmails(token: string): Promise<GithubEmail[]> {
      const { json } = await api({ kind: "user", token }, "GET", "/user/emails?per_page=100");
      return readVerifiedGithubEmails(json);
    },

    /** The installations the person can reach through the App. */
    async userInstallations(token: string): Promise<GithubInstallationFacts[]> {
      const { items } = await pages({ kind: "user", token }, "/user/installations", (json) => {
        const list = record(json)["installations"];
        return Array.isArray(list) ? list : [];
      });
      return items.flatMap((item) => readGithubInstallation(item) ?? []);
    },

    /** One installation as the App sees it, or `null` once it is gone. */
    async installation(
      jwt: string,
      installationId: string,
    ): Promise<GithubInstallationFacts | null> {
      try {
        const { json } = await api(
          { kind: "app", jwt },
          "GET",
          `/app/installations/${installationId}`,
        );
        return readGithubInstallation(json);
      } catch (error) {
        if (error instanceof GithubApiError && error.kind === "not_found") return null;
        throw error;
      }
    },

    async appInstallations(
      jwt: string,
    ): Promise<{ installations: GithubInstallationFacts[]; complete: boolean }> {
      const { items, complete } = await pages({ kind: "app", jwt }, "/app/installations", (json) =>
        Array.isArray(json) ? json : [],
      );
      return {
        installations: items.flatMap((item) => readGithubInstallation(item) ?? []),
        complete,
      };
    },

    /** A one-hour installation token, never stored. */
    async installationToken(jwt: string, installationId: string): Promise<string> {
      const { json } = await api(
        { kind: "app", jwt },
        "POST",
        `/app/installations/${installationId}/access_tokens`,
        { permissions: { metadata: "read" } },
      );
      const token = record(json)["token"];
      if (typeof token !== "string") {
        throw new GithubApiError(
          "unavailable",
          200,
          "GitHub did not return an installation token.",
        );
      }
      return token;
    },

    /** The repositories an installation's selection holds. */
    async installationRepositories(
      token: string,
    ): Promise<{ repositories: GithubRepository[]; complete: boolean }> {
      const { items, complete } = await pages(
        { kind: "installation", token },
        "/installation/repositories",
        (json) => {
          const list = record(json)["repositories"];
          return Array.isArray(list) ? list : [];
        },
      );
      return { repositories: items.flatMap((item) => readRepository(item) ?? []), complete };
    },

    /** One repository by GitHub's id (which survives renames), or `null` when unreachable. */
    async repository(token: string, githubRepoId: string): Promise<GithubRepository | null> {
      try {
        const { json } = await api(
          { kind: "installation", token },
          "GET",
          `/repositories/${githubRepoId}`,
        );
        return readRepository(json);
      } catch (error) {
        if (error instanceof GithubApiError && error.kind === "not_found") return null;
        throw error;
      }
    },

    /** Whether GitHub still honours a user access token (`false`: revoked, expired or unknown). */
    async tokenValid(accessToken: string): Promise<boolean> {
      try {
        await api({ kind: "client" }, "POST", `/applications/${config.clientId}/token`, {
          access_token: accessToken,
        });
        return true;
      } catch (error) {
        if (
          error instanceof GithubApiError &&
          (error.kind === "not_found" || error.status === 422)
        ) {
          return false;
        }
        throw error;
      }
    },

    /** Ends the person's authorization and every token it issued. Gone already is fine. */
    async deleteGrant(accessToken: string): Promise<void> {
      try {
        await api({ kind: "client" }, "DELETE", `/applications/${config.clientId}/grant`, {
          access_token: accessToken,
        });
      } catch (error) {
        if (
          error instanceof GithubApiError &&
          (error.kind === "not_found" || error.status === 422)
        ) {
          return;
        }
        throw error;
      }
    },

    /** The App's webhook deliveries, newest first, back to `since`. */
    async deliveries(jwt: string, since: number): Promise<GithubDelivery[]> {
      const out: GithubDelivery[] = [];
      let url: string | null = `${config.apiUrl}/app/hook/deliveries?per_page=100`;
      for (let page = 0; url !== null && page < MAX_PAGES; page += 1) {
        const { json, headers } = await send({ kind: "app", jwt }, "GET", url);
        let older = false;
        for (const item of Array.isArray(json) ? json : []) {
          const row = record(item);
          const id = idText(row["id"]);
          const deliveredAt = Date.parse(String(row["delivered_at"]));
          if (id === null || typeof row["guid"] !== "string" || !Number.isFinite(deliveredAt)) {
            continue;
          }
          if (deliveredAt < since) {
            older = true;
            continue;
          }
          out.push({ id, guid: row["guid"], deliveredAt, ok: row["status"] === "OK" });
        }
        const next = nextLink(headers);
        url = !older && next !== null && new URL(next).origin === apiOrigin ? next : null;
      }
      return out;
    },

    async redeliver(jwt: string, deliveryId: string): Promise<void> {
      await api({ kind: "app", jwt }, "POST", `/app/hook/deliveries/${deliveryId}/attempts`);
    },
  };
}
