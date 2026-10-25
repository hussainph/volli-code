/**
 * The local dev issuer: a tiny OAuth 2.0 + PKCE authorization server in
 * main's process, for unpackaged builds and tests, so the whole sign-in path
 * (browser, loopback callback, code exchange, refresh, sealed storage, the
 * backend's `ensureViewer`) runs without a WorkOS account.
 *
 * It signs ES256 access tokens as the Convex fixture's TEST issuer
 * (`convex/functions/auth.config.ts`: `TEST_ISSUER`, `TEST_AUDIENCE`, and
 * `fixture/jwt.ts`'s key id), with the fixture's private key, so a backend
 * started by `pnpm -C convex with-backend --deploy -- …` trusts them: that
 * command hands the key to what it runs as `VOLLI_CONVEX_TEST_PRIVATE_KEY`.
 * No cloud deployment trusts that issuer.
 *
 * `/authorize` approves at once (there is no one to ask: the person is the
 * one configured subject) and redirects to the loopback callback with a
 * code; it refuses any redirect that is not loopback `http`. `/token` speaks
 * standard form-encoded `authorization_code` (S256 checked, single use) and
 * rotating `refresh_token` grants.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { isAccountConnection } from "@volli/shared";

import { signEs256Jwt } from "./jwt";
import { pkceChallenge } from "./pkce";
import {
  postTokenRequest,
  tokensFrom,
  type AccountProvider,
  type AuthorizationRequest,
} from "./provider";

/** The Convex fixture's test issuer, audience and key id (see the module comment). */
export const DEV_ISSUER = "https://test.volli.invalid";
export const DEV_AUDIENCE = "volli-test";
export const DEV_KEY_ID = "volli-test-1";
export const DEV_CLIENT_ID = "volli-desktop-dev";

const CODE_TTL_MS = 60_000;
const ACCESS_TTL_SECONDS = 300;

export interface DevIssuerOptions {
  /** PKCS#8 PEM of the fixture's P-256 key. */
  readonly privateKeyPem: string;
  /** Who signs in; the subject is `dev:<subject>`. */
  readonly subject?: string;
  readonly displayName?: string;
  readonly email?: string;
  /** Lifetime of each access token; tests shorten it. */
  readonly accessTtlSeconds?: number;
  readonly now?: () => number;
}

export interface DevIssuer {
  /** `http://127.0.0.1:<port>`. */
  readonly baseUrl: string;
  close(): Promise<void>;
}

interface PendingCode {
  readonly challenge: string;
  readonly redirectUri: string;
  readonly expiresAt: number;
}

function isLoopbackRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "";
  } catch {
    return false;
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error("too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

/** Starts the issuer on a free loopback port. */
export async function startDevIssuer(options: DevIssuerOptions): Promise<DevIssuer> {
  const now = options.now ?? Date.now;
  const subject = `dev:${options.subject ?? "dev-user"}`;
  const codes = new Map<string, PendingCode>();
  // A refresh token is good once: each refresh replaces it.
  const refreshTokens = new Map<string, string>();
  const sessionId = `dev_session_${randomUUID()}`;

  const accessToken = (): string => {
    const issuedAt = Math.floor(now() / 1000);
    return signEs256Jwt(options.privateKeyPem, DEV_KEY_ID, {
      iss: DEV_ISSUER,
      aud: DEV_AUDIENCE,
      sub: subject,
      sid: sessionId,
      name: options.displayName ?? "Dev User",
      email: options.email ?? "dev-user@volli.invalid",
      email_verified: true,
      iat: issuedAt,
      exp: issuedAt + (options.accessTtlSeconds ?? ACCESS_TTL_SECONDS),
    });
  };
  const grant = (response: ServerResponse): void => {
    const refreshToken = randomBytes(32).toString("base64url");
    refreshTokens.set(refreshToken, subject);
    json(response, 200, {
      token_type: "Bearer",
      access_token: accessToken(),
      refresh_token: refreshToken,
      expires_in: options.accessTtlSeconds ?? ACCESS_TTL_SECONDS,
    });
  };
  const refuse = (response: ServerResponse, description: string): void =>
    json(response, 400, { error: "invalid_grant", error_description: description });

  const authorize = (url: URL, response: ServerResponse): void => {
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const state = url.searchParams.get("state");
    const challenge = url.searchParams.get("code_challenge");
    if (
      url.searchParams.get("response_type") !== "code" ||
      url.searchParams.get("client_id") !== DEV_CLIENT_ID ||
      url.searchParams.get("code_challenge_method") !== "S256" ||
      !isLoopbackRedirect(redirectUri) ||
      state === null ||
      challenge === null ||
      !isAccountConnection(url.searchParams.get("provider"))
    ) {
      json(response, 400, { error: "invalid_request" });
      return;
    }
    const code = randomBytes(24).toString("base64url");
    codes.set(code, { challenge, redirectUri, expiresAt: now() + CODE_TTL_MS });
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", state);
    response.writeHead(302, { location: target.toString(), "cache-control": "no-store" });
    response.end();
  };

  const token = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const form = new URLSearchParams(await readBody(request));
    if (form.get("client_id") !== DEV_CLIENT_ID) {
      json(response, 401, { error: "invalid_client" });
      return;
    }
    switch (form.get("grant_type")) {
      case "authorization_code": {
        const code = form.get("code") ?? "";
        const pending = codes.get(code);
        codes.delete(code);
        if (
          pending === undefined ||
          pending.expiresAt <= now() ||
          pending.redirectUri !== form.get("redirect_uri") ||
          pkceChallenge(form.get("code_verifier") ?? "") !== pending.challenge
        ) {
          refuse(response, "The code is unknown, used, expired or not this verifier's.");
          return;
        }
        grant(response);
        return;
      }
      case "refresh_token": {
        const refreshToken = form.get("refresh_token") ?? "";
        if (!refreshTokens.delete(refreshToken)) {
          refuse(response, "The refresh token is unknown or already used.");
          return;
        }
        grant(response);
        return;
      }
      default:
        json(response, 400, { error: "unsupported_grant_type" });
    }
  };

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/authorize") {
      authorize(url, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/token") {
      token(request, response).catch(() => json(response, 400, { error: "invalid_request" }));
      return;
    }
    json(response, 404, { error: "not_found" });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  // Never what keeps the process alive.
  server.unref();
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface DevIssuerProviderOptions extends DevIssuerOptions {
  readonly fetch?: typeof fetch;
}

/**
 * The dev issuer as a provider adapter. The issuer starts on first use and
 * stops at {@link AccountProvider.dispose}; it keeps no browser session, so
 * sign-out opens nothing.
 */
export function devIssuerProvider(options: DevIssuerProviderOptions): AccountProvider {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let issuer: Promise<DevIssuer> | null = null;
  const started = (): Promise<DevIssuer> => {
    issuer ??= startDevIssuer(options);
    return issuer;
  };
  const tokenRequest = async (grant: Record<string, string>) => {
    const { baseUrl } = await started();
    const body = await postTokenRequest(fetchImpl, `${baseUrl}/token`, {
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams({ client_id: DEV_CLIENT_ID, ...grant }).toString(),
    });
    return tokensFrom(body, now());
  };
  return {
    kind: "dev",
    async authorizationUrl(request: AuthorizationRequest) {
      const { baseUrl } = await started();
      const url = new URL(`${baseUrl}/authorize`);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: DEV_CLIENT_ID,
        redirect_uri: request.redirectUri,
        state: request.state,
        code_challenge: request.codeChallenge,
        code_challenge_method: "S256",
        provider: request.connection,
      }).toString();
      return url.toString();
    },
    exchangeCode: ({ code, codeVerifier, redirectUri }) =>
      tokenRequest({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }),
    refresh: (refreshToken) =>
      tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }),
    logoutUrl: () => null,
    dispose() {
      const running = issuer;
      issuer = null;
      void running?.then((live) => live.close());
    },
  };
}
