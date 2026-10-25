/**
 * A fake GitHub for the App's tests: the OAuth token endpoint (code exchange
 * with PKCE, single-use refresh tokens that end the previous access token),
 * the REST endpoints the backend calls, App JWT verification against the
 * test key, and grant revocation. Installed as the global `fetch`.
 */

import { vi } from "vite-plus/test";

export const API = "https://api.github.test";
export const WEB = "https://github.test";
export const SITE = "https://volli.convex.site.test";
export const APP_ID = "1001";
export const CLIENT_ID = "Iv1.testclient";
export const CLIENT_SECRET = "test-client-secret";
export const SLUG = "volli-test";
export const WEBHOOK_SECRET = "webhook-secret-new";
export const OLD_WEBHOOK_SECRET = "webhook-secret-old";

const encoder = new TextEncoder();

function b64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromB64Url(text: string): Uint8Array<ArrayBuffer> {
  const base = text.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(base + "=".repeat((4 - (base.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function sha256B64Url(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export async function signBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return `sha256=${[...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export interface FakeUser {
  id: number;
  login: string;
  name: string | null;
  emails: { email: string; primary: boolean; verified: boolean; visibility: string | null }[];
  /** Installation ids this user can reach. */
  installations: number[];
}

export interface FakeInstallation {
  id: number;
  account: { id: number; login: string; type: "User" | "Organization" };
  repository_selection: "all" | "selected";
  permissions: Record<string, string>;
  events: string[];
  suspended_at: string | null;
  repositories: FakeRepo[];
}

export interface FakeRepo {
  id: number;
  name: string;
  owner: { login: string };
  default_branch: string;
  archived: boolean;
}

export interface FakeDelivery {
  id: number;
  guid: string;
  delivered_at: string;
  status: string;
}

function json(value: unknown, status = 200): Response {
  return new Response(value === null ? null : JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export class FakeGithub {
  users = new Map<number, FakeUser>();
  installations = new Map<number, FakeInstallation>();
  /** Pending authorization codes: code → (user, PKCE challenge). */
  codes = new Map<string, { userId: number; challenge: string }>();
  access = new Map<string, number>();
  refresh = new Map<string, number>();
  installationTokens = new Set<string>();
  deliveries: FakeDelivery[] = [];
  redelivered: number[] = [];
  revokedGrants: number[] = [];
  refreshCalls = 0;
  /** Seconds a new access token lives (8 h by default). */
  accessTtl = 8 * 3600;
  /** Paths answered 503 (GitHub down) when matched. */
  down: RegExp | null = null;
  publicKey: CryptoKey | null = null;
  privateKeyPem = "";
  private counter = 0;

  async init(): Promise<this> {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    this.publicKey = pair.publicKey;
    const pkcs8 = b64(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    this.privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/gu)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
    return this;
  }

  addUser(user: Partial<FakeUser> & { id: number; login: string }): FakeUser {
    const full: FakeUser = {
      name: null,
      emails: [
        {
          email: `${user.login}@example.test`,
          primary: true,
          verified: true,
          visibility: "private",
        },
      ],
      installations: [],
      ...user,
    };
    this.users.set(full.id, full);
    return full;
  }

  addInstallation(
    installation: Partial<FakeInstallation> & { id: number; account: FakeInstallation["account"] },
  ): FakeInstallation {
    const full: FakeInstallation = {
      repository_selection: "selected",
      permissions: { contents: "write", metadata: "read" },
      events: ["pull_request"],
      suspended_at: null,
      repositories: [],
      ...installation,
    };
    this.installations.set(full.id, full);
    return full;
  }

  /** What GitHub does when the person approves the authorize URL: a code for the redirect. */
  authorize(url: string, userId: number): { code: string; state: string } {
    const parsed = new URL(url);
    const code = `code-${++this.counter}`;
    this.codes.set(code, { userId, challenge: parsed.searchParams.get("code_challenge")! });
    return { code, state: parsed.searchParams.get("state")! };
  }

  private mintPair(userId: number) {
    const access = `ghu_fake${++this.counter}`;
    const refresh = `ghr_fake${++this.counter}`;
    this.access.set(access, userId);
    this.refresh.set(refresh, userId);
    return {
      access_token: access,
      refresh_token: refresh,
      expires_in: this.accessTtl,
      refresh_token_expires_in: 15_897_600,
      token_type: "bearer",
      scope: "",
    };
  }

  /** Every live access token of a user (a refresh ends the old one). */
  tokensOf(userId: number): string[] {
    return [...this.access].filter(([, id]) => id === userId).map(([token]) => token);
  }

  private async verifyJwt(header: string | null): Promise<boolean> {
    const jwt = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const [h, p, s] = jwt.split(".");
    if (h === undefined || p === undefined || s === undefined) return false;
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      this.publicKey!,
      fromB64Url(s),
      encoder.encode(`${h}.${p}`),
    );
    const claims = JSON.parse(new TextDecoder().decode(fromB64Url(p))) as {
      iss: string;
      exp: number;
      iat: number;
    };
    return ok && claims.iss === CLIENT_ID && claims.exp - claims.iat <= 600;
  }

  private userOf(header: string | null): FakeUser | null {
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const id = this.access.get(token);
    return id === undefined ? null : (this.users.get(id) ?? null);
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization");
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, string>) : {};
    if (this.down?.test(url.pathname)) return json({ message: "down" }, 503);

    if (url.origin === WEB && url.pathname === "/login/oauth/access_token" && method === "POST") {
      // GitHub answers form-encoded unless asked for JSON.
      if (headers.get("accept") !== "application/json") {
        return new Response("error=unsupported", {
          headers: { "content-type": "application/x-www-form-urlencoded" },
        });
      }
      if (body["client_id"] !== CLIENT_ID || body["client_secret"] !== CLIENT_SECRET) {
        return json({ error: "incorrect_client_credentials" });
      }
      if (body["grant_type"] === "refresh_token") {
        this.refreshCalls += 1;
        const userId = this.refresh.get(body["refresh_token"]!);
        if (userId === undefined) return json({ error: "bad_refresh_token" });
        this.refresh.delete(body["refresh_token"]!);
        // A refresh ends every access token the grant issued before.
        for (const token of this.tokensOf(userId)) this.access.delete(token);
        return json(this.mintPair(userId));
      }
      const pending = this.codes.get(body["code"]!);
      if (pending === undefined) return json({ error: "bad_verification_code" });
      this.codes.delete(body["code"]!);
      if ((await sha256B64Url(body["code_verifier"] ?? "")) !== pending.challenge) {
        return json({ error: "bad_verification_code" });
      }
      if (body["redirect_uri"] !== `${SITE}/github/oauth/callback`) {
        return json({ error: "redirect_uri_mismatch" });
      }
      return json(this.mintPair(pending.userId));
    }

    if (url.origin !== API) return json({ message: "unknown host" }, 404);
    const path = url.pathname;

    if (path === "/user" || path === "/user/emails" || path === "/user/installations") {
      const user = this.userOf(auth);
      if (user === null) return json({ message: "Bad credentials" }, 401);
      if (path === "/user") return json({ id: user.id, login: user.login, name: user.name });
      if (path === "/user/emails") return json(user.emails);
      const installations = user.installations.flatMap((id) => {
        const found = this.installations.get(id);
        return found === undefined ? [] : [found];
      });
      return json({ total_count: installations.length, installations });
    }

    const clientAuth = auth === `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`;
    if (path === `/applications/${CLIENT_ID}/token` && method === "POST") {
      if (!clientAuth) return json({ message: "Bad credentials" }, 401);
      return this.access.has(body["access_token"]!)
        ? json({ token: body["access_token"] })
        : json({ message: "Not Found" }, 404);
    }

    let match = /^\/applications\/([^/]+)\/grant$/u.exec(path);
    if (match && method === "DELETE") {
      if (auth !== `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}` || match[1] !== CLIENT_ID) {
        return json({ message: "Bad credentials" }, 401);
      }
      const userId = this.access.get(body["access_token"]!);
      if (userId === undefined) return json({ message: "Not Found" }, 404);
      this.revokedGrants.push(userId);
      for (const [token, id] of this.access) if (id === userId) this.access.delete(token);
      for (const [token, id] of this.refresh) if (id === userId) this.refresh.delete(token);
      return json(null, 204);
    }

    if (path.startsWith("/app/")) {
      if (!(await this.verifyJwt(auth))) return json({ message: "Bad JWT" }, 401);
      match = /^\/app\/installations\/(\d+)$/u.exec(path);
      if (match) {
        const found = this.installations.get(Number(match[1]));
        return found === undefined ? json({ message: "Not Found" }, 404) : json(found);
      }
      match = /^\/app\/installations\/(\d+)\/access_tokens$/u.exec(path);
      if (match && method === "POST") {
        if (!this.installations.has(Number(match[1]))) return json({ message: "Not Found" }, 404);
        const token = `ghs_${match[1]}_${++this.counter}`;
        this.installationTokens.add(token);
        return json({ token, expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
      }
      if (path === "/app/installations") return json([...this.installations.values()]);
      if (path === "/app/hook/deliveries") return json(this.deliveries);
      match = /^\/app\/hook\/deliveries\/(\d+)\/attempts$/u.exec(path);
      if (match && method === "POST") {
        this.redelivered.push(Number(match[1]));
        return json({}, 202);
      }
    }

    if (path === "/installation/repositories" || path.startsWith("/repositories/")) {
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!this.installationTokens.has(token)) return json({ message: "Bad credentials" }, 401);
      const installation = this.installations.get(Number(token.split("_")[1]));
      const repos = installation?.repositories ?? [];
      if (path === "/installation/repositories") {
        return json({ total_count: repos.length, repositories: repos });
      }
      const repo = repos.find((entry) => String(entry.id) === path.split("/")[2]);
      return repo === undefined ? json({ message: "Not Found" }, 404) : json(repo);
    }

    return json({ message: "Not Found" }, 404);
  };
}

/** A root key for P4's sealing: `kid:base64(32 bytes)`. */
export function rootKeys(): string {
  return `k1:${btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))}`;
}

/** A fake GitHub installed as `fetch`, and the deployment variables pointing at it. */
export async function installFakeGithub(): Promise<FakeGithub> {
  const github = await new FakeGithub().init();
  vi.stubGlobal("fetch", github.fetch);
  vi.stubEnv("GITHUB_APP_ID", APP_ID);
  vi.stubEnv("GITHUB_APP_SLUG", SLUG);
  vi.stubEnv("GITHUB_APP_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", CLIENT_SECRET);
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", github.privateKeyPem);
  vi.stubEnv("GITHUB_WEBHOOK_SECRETS", `${WEBHOOK_SECRET},${OLD_WEBHOOK_SECRET}`);
  vi.stubEnv("GITHUB_API_URL", API);
  vi.stubEnv("GITHUB_WEB_URL", WEB);
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  vi.stubEnv("VOLLI_SECRETS_ROOT_KEYS", rootKeys());
  return github;
}
