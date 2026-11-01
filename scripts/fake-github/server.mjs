#!/usr/bin/env node
/**
 * A fake GitHub on one loopback port, for acceptance lanes that run a real
 * backend and a real box (VC-1043, the BYO runner lane). It is a separate
 * process boundary, not a stubbed `fetch`: the pinned Convex backend calls its
 * API over HTTP, and `git` inside a container clones from and pushes to it.
 * (`convex/test/github-fake.ts` is the in-process twin for `convex-test`.)
 *
 * One origin, laid out the way GitHub Enterprise Server is, so one URL pair
 * points a deployment at it:
 *
 * - **Web** (`GITHUB_WEB_URL` = the origin): `GET /login/oauth/authorize`
 *   approves as the signed-in fake user and redirects back with a code;
 *   `POST /login/oauth/access_token` exchanges a code (PKCE S256, exact
 *   `redirect_uri`) or a single-use refresh token for an expiring
 *   `ghu_`/`ghr_` pair. A refresh ends every access token the grant issued.
 * - **REST** (`GITHUB_API_URL` = `<origin>/api/v3`): the endpoints the backend
 *   calls (`lib/github/client.ts`): `/user`, `/user/emails`,
 *   `/user/installations`, the App's `/app/...` (RS256 App JWT verified
 *   against the key {@link FakeGithub.appEnv} hands the deployment),
 *   installation tokens, `/installation/repositories`, `/repositories/:id`,
 *   and the client-authenticated token check and grant deletion.
 * - **Git smart HTTP** (`<origin>/<owner>/<repo>.git`): `git http-backend`
 *   over bare repositories under `gitRoot`. Every request needs HTTP Basic
 *   with the user name `x-access-token` and, as the password, a live user
 *   access token whose user reaches the repository through an installation,
 *   or an installation token for an installation that holds it. Anything
 *   else is a 401 with GitHub's `WWW-Authenticate`, so `git` fails the way it
 *   does against a private repository.
 *
 * **One port, two schemes.** With `tls` (a key and certificate for
 * `hostname`), the same port also answers HTTPS: the first byte of each
 * connection picks the protocol (a TLS handshake starts with 0x16). A backend
 * reaches the API and web flow over plain HTTP while a box's `git` reaches the
 * very same origin as `https://<hostname>:<port>`, which is the form a runner's
 * GitHub remotes take (`normalizeGitRemoteUrl` in `@volli/shared/cloud`).
 * `hostname` names the fake in URLs (a box refuses a loopback literal as a
 * remote); the lane maps it to the loopback in `/etc/hosts`.
 *
 * Binds 127.0.0.1 by default. Each request is recorded (never a token: the
 * log names the credential's kind only) for evidence.
 *
 * CLI: `node scripts/fake-github/server.mjs [--port 0] [--git-root <dir>]`
 * prints `{ origin, apiUrl, webUrl }` as one JSON line and serves until
 * SIGTERM. No dependencies beyond `node:` builtins and the system `git`.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";

export const FAKE_GITHUB_APP = Object.freeze({
  appId: "4242",
  slug: "volli-e2e",
  clientId: "Iv1.volli-e2e",
  clientSecret: "volli-e2e-client-secret",
  webhookSecret: "volli-e2e-webhook-secret",
});

/** The API prefix, as on GitHub Enterprise Server. */
export const API_PREFIX = "/api/v3";
const ACCESS_TTL_S = 8 * 3600;
const REFRESH_TTL_S = 15_897_600;
const GIT_USER = "x-access-token";
const GIT_PATH = /^\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\.git(\/.*)$/u;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const sha256b64url = (text) => createHash("sha256").update(text).digest("base64url");

function json(response, status, value, headers = {}) {
  const body = value === null ? "" : JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

function readBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((done, fail) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => done(Buffer.concat(chunks)));
    request.once("error", fail);
  });
}

/** A JSON or form body as a flat record (the token endpoint accepts both). */
function fieldsOf(request, raw) {
  const type = String(request.headers["content-type"] ?? "");
  const text = raw.toString("utf8");
  if (text === "") return {};
  if (type.startsWith("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function sameSecret(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The fake's own git: no system or global config (no hooks, signing or helpers). */
const OWN_GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

function git(args, options = {}) {
  const result = spawnSync("git", args, { encoding: "utf8", env: OWN_GIT_ENV, ...options });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout;
}

/** Parse a CGI response: headers, a blank line, the body. */
function splitCgi(output) {
  let end = output.indexOf("\r\n\r\n");
  let gap = 4;
  if (end === -1) {
    end = output.indexOf("\n\n");
    gap = 2;
  }
  if (end === -1) return { status: 502, headers: {}, body: output };
  const headers = {};
  let status = 200;
  for (const line of output.subarray(0, end).toString("latin1").split(/\r?\n/u)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "status") status = Number.parseInt(value, 10) || 200;
    else headers[name] = value;
  }
  return { status, headers, body: output.subarray(end + gap) };
}

/** A duplex over `socket` whose readable side starts with `first`. */
function replaying(socket, first) {
  const stream = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk, encoding, done) {
      socket.write(chunk, encoding, done);
    },
    final(done) {
      socket.end();
      done();
    },
    destroy(error, done) {
      socket.destroy();
      done(error);
    },
  });
  stream.remoteAddress = socket.remoteAddress;
  stream.push(first);
  socket.on("data", (chunk) => {
    if (!stream.push(chunk)) socket.pause();
  });
  socket.once("end", () => stream.push(null));
  socket.once("close", () => stream.destroy());
  return stream;
}

export class FakeGithub {
  /** @type {Map<number, {id:number,login:string,name:string|null,emails:object[],installations:number[]}>} */
  users = new Map();
  /** @type {Map<number, object>} */
  installations = new Map();
  /** code → { userId, challenge, redirectUri } */
  codes = new Map();
  /** access token → { userId, expiresAt } */
  access = new Map();
  /** refresh token → userId */
  refresh = new Map();
  /** installation token → { installationId, expiresAt } */
  installationTokens = new Map();
  /** Every request, without credentials. */
  requests = [];
  /** The user the "browser" is signed in as on the authorize page. */
  signedInUserId = null;
  #counter = 0;
  #server = null;
  #protocols = [];
  #ownsGitRoot = false;

  #tls = null;

  constructor({ gitRoot, bind = "127.0.0.1", hostname = bind, tls, app = FAKE_GITHUB_APP } = {}) {
    this.bind = bind;
    this.host = hostname;
    this.#tls = tls ?? null;
    this.app = app;
    this.#ownsGitRoot = gitRoot === undefined;
    this.gitRoot = gitRoot ?? mkdtempSync(join(tmpdir(), "volli-fake-github-"));
    mkdirSync(this.gitRoot, { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    this.publicKey = publicKey;
  }

  get origin() {
    if (this.#server === null) throw new Error("the fake GitHub is not listening");
    const { port } = this.#server.address();
    return `http://${this.host}:${port}`;
  }

  /** The same origin over HTTPS (only with `tls`): where a box's git reaches it. */
  get httpsOrigin() {
    if (this.#tls === null) throw new Error("the fake GitHub has no TLS certificate");
    return this.origin.replace(/^http:/u, "https:");
  }

  get apiUrl() {
    return `${this.origin}${API_PREFIX}`;
  }

  get webUrl() {
    return this.origin;
  }

  /**
   * The deployment variables that point a backend's GitHub App at this fake
   * (`convex/functions/lib/github/config.ts`). The private key is this run's
   * own throwaway key; nothing else trusts it.
   */
  appEnv() {
    return {
      GITHUB_APP_ID: this.app.appId,
      GITHUB_APP_SLUG: this.app.slug,
      GITHUB_APP_CLIENT_ID: this.app.clientId,
      GITHUB_APP_CLIENT_SECRET: this.app.clientSecret,
      GITHUB_APP_PRIVATE_KEY: this.privateKeyPem,
      GITHUB_WEBHOOK_SECRETS: this.app.webhookSecret,
      GITHUB_API_URL: this.apiUrl,
      GITHUB_WEB_URL: this.webUrl,
    };
  }

  addUser({ id, login, name = null, email = `${login}@users.noreply.example.test` }) {
    const user = {
      id,
      login,
      name,
      emails: [{ email, primary: true, verified: true, visibility: "private" }],
      installations: [],
    };
    this.users.set(id, user);
    this.signedInUserId ??= id;
    return user;
  }

  /**
   * An installation of the App on `account`, holding `repositories`
   * (`{ id, owner, name }`), reachable by `userIds`.
   */
  addInstallation({ id, account, repositories = [], userIds = [] }) {
    const installation = {
      id,
      account: { id: account.id, login: account.login, type: account.type ?? "User" },
      repository_selection: "selected",
      permissions: { contents: "write", metadata: "read", pull_requests: "write" },
      events: ["pull_request", "push"],
      suspended_at: null,
      repositories: repositories.map((repo) => ({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: { login: repo.owner },
        default_branch: repo.defaultBranch ?? "main",
        archived: false,
        private: true,
      })),
    };
    this.installations.set(id, installation);
    for (const userId of userIds) this.users.get(userId)?.installations.push(id);
    return installation;
  }

  /** The bare repository's path on disk. */
  repoPath(owner, name) {
    return join(this.gitRoot, owner, `${name}.git`);
  }

  /**
   * A bare repository `<owner>/<name>.git` with one commit on `branch`
   * (a README), so a clone has something to check out.
   */
  createRepo(owner, name, { branch = "main", files = { "README.md": `# ${name}\n` } } = {}) {
    const bare = this.repoPath(owner, name);
    mkdirSync(bare, { recursive: true });
    git(["init", "--bare", "--quiet", `--initial-branch=${branch}`, bare]);
    // Pushes over smart HTTP are this fake's job, whoever the CGI user is.
    git(["-C", bare, "config", "http.receivepack", "true"]);
    const work = mkdtempSync(join(tmpdir(), "volli-fake-github-seed-"));
    try {
      git(["init", "--quiet", `--initial-branch=${branch}`, work]);
      for (const [path, content] of Object.entries(files)) {
        const target = join(work, path);
        mkdirSync(join(target, ".."), { recursive: true });
        spawnSync("sh", ["-c", 'cat > "$1"', "sh", target], { input: content });
      }
      const identity = [
        "-c",
        "user.name=Fake GitHub",
        "-c",
        "user.email=seed@example.test",
        "-c",
        "commit.gpgsign=false",
      ];
      git(["-C", work, "add", "--all"]);
      git(["-C", work, ...identity, "commit", "--quiet", "-m", "Initial commit"]);
      git(["-C", work, "push", "--quiet", bare, `HEAD:refs/heads/${branch}`]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    return bare;
  }

  /** `refs/heads/...` → sha, read straight from the bare repository. */
  refs(owner, name) {
    const out = git([
      "-C",
      this.repoPath(owner, name),
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    ]);
    return Object.fromEntries(
      out
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" ")),
    );
  }

  /** One commit's subject, author and trailers, for evidence. */
  commit(owner, name, rev) {
    const out = git([
      "-C",
      this.repoPath(owner, name),
      "log",
      "-1",
      "--format=%H%x00%an <%ae>%x00%s%x00%(trailers:only,unfold)",
      rev,
    ]);
    const [sha, author, subject, trailers] = out.replace(/\n$/u, "").split("\0");
    return { sha, author, subject, trailers: (trailers ?? "").trim() };
  }

  /**
   * What GitHub does when the signed-in person approves the authorize URL:
   * the code the redirect carries. Same rules as the HTTP door.
   */
  authorize(url, userId = this.signedInUserId) {
    const parsed = new URL(url);
    const params = parsed.searchParams;
    if (params.get("client_id") !== this.app.clientId) throw new Error("unknown client_id");
    if (params.get("code_challenge_method") !== "S256") throw new Error("PKCE S256 required");
    if (!this.users.has(userId)) throw new Error(`no fake user ${userId}`);
    const code = `fake-code-${++this.#counter}-${randomBytes(6).toString("hex")}`;
    this.codes.set(code, {
      userId,
      challenge: params.get("code_challenge"),
      redirectUri: params.get("redirect_uri"),
    });
    const redirect = new URL(params.get("redirect_uri"));
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", params.get("state") ?? "");
    return { code, state: params.get("state"), redirect: redirect.toString() };
  }

  /** Every live access token of a user. */
  tokensOf(userId) {
    const now = Date.now();
    return [...this.access]
      .filter(([, entry]) => entry.userId === userId && entry.expiresAt > now)
      .map(([token]) => token);
  }

  #mintPair(userId) {
    const accessToken = `ghu_${randomBytes(18).toString("hex")}`;
    const refreshToken = `ghr_${randomBytes(18).toString("hex")}`;
    this.access.set(accessToken, { userId, expiresAt: Date.now() + ACCESS_TTL_S * 1000 });
    this.refresh.set(refreshToken, userId);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: ACCESS_TTL_S,
      refresh_token_expires_in: REFRESH_TTL_S,
      token_type: "bearer",
      scope: "",
    };
  }

  /**
   * SETUP for probes that need a git credential without the backend: a live
   * access token for `userId`, as if the person had just connected.
   */
  issueAccessToken(userId) {
    if (!this.users.has(userId)) throw new Error(`no fake user ${userId}`);
    return this.#mintPair(userId).access_token;
  }

  #userOfToken(token) {
    const entry = this.access.get(token);
    if (entry === undefined || entry.expiresAt <= Date.now()) return null;
    return this.users.get(entry.userId) ?? null;
  }

  #bearer(request) {
    const header = String(request.headers.authorization ?? "");
    return header.startsWith("Bearer ")
      ? header.slice(7)
      : header.startsWith("token ")
        ? header.slice(6)
        : "";
  }

  #appJwtValid(request) {
    const [head, payload, signature] = this.#bearer(request).split(".");
    if (!head || !payload || !signature) return false;
    let claims;
    try {
      if (JSON.parse(Buffer.from(head, "base64url").toString()).alg !== "RS256") return false;
      claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    } catch {
      return false;
    }
    let signed;
    try {
      signed = verify(
        "sha256",
        Buffer.from(`${head}.${payload}`),
        this.publicKey,
        Buffer.from(signature, "base64url"),
      );
    } catch {
      return false;
    }
    const now = Math.floor(Date.now() / 1000);
    const issuer = String(claims.iss);
    return (
      signed &&
      (issuer === this.app.appId || issuer === this.app.clientId) &&
      typeof claims.exp === "number" &&
      claims.exp > now &&
      claims.exp - claims.iat <= 600
    );
  }

  #clientAuthValid(request) {
    const expected = `Basic ${Buffer.from(`${this.app.clientId}:${this.app.clientSecret}`).toString("base64")}`;
    return sameSecret(String(request.headers.authorization ?? ""), expected);
  }

  /** Which installation ids hold `<owner>/<name>`. */
  #installationsHolding(owner, name) {
    return [...this.installations.values()]
      .filter((installation) =>
        installation.repositories.some((repo) => repo.owner.login === owner && repo.name === name),
      )
      .map((installation) => installation.id);
  }

  /**
   * Whether a git Basic credential may reach `<owner>/<name>`, and as what
   * (for the request log): `user:<login>`, `installation:<id>` or `null`.
   */
  gitCredentialFor(authorization, owner, name) {
    const header = String(authorization ?? "");
    if (!header.startsWith("Basic ")) return null;
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon === -1 || decoded.slice(0, colon) !== GIT_USER) return null;
    const token = decoded.slice(colon + 1);
    const holding = this.#installationsHolding(owner, name);
    const user = this.#userOfToken(token);
    if (user !== null) {
      return user.installations.some((id) => holding.includes(id)) ? `user:${user.login}` : null;
    }
    const installation = this.installationTokens.get(token);
    if (installation !== undefined && installation.expiresAt > Date.now()) {
      return holding.includes(installation.installationId)
        ? `installation:${installation.installationId}`
        : null;
    }
    return null;
  }

  async #web(request, response, url, record) {
    if (url.pathname === "/login/oauth/authorize" && request.method === "GET") {
      try {
        const { redirect } = this.authorize(url.toString());
        response.writeHead(302, { location: redirect, "content-length": 0 });
        response.end();
      } catch (error) {
        record.error = error.message;
        json(response, 400, { error: "invalid_request", error_description: error.message });
      }
      return true;
    }
    if (url.pathname === "/login/oauth/access_token" && request.method === "POST") {
      const body = fieldsOf(request, await readBody(request));
      // GitHub answers form-encoded unless asked for JSON; the backend asks.
      if (!String(request.headers.accept ?? "").includes("application/json")) {
        response.writeHead(200, { "content-type": "application/x-www-form-urlencoded" });
        response.end("error=unsupported_accept");
        return true;
      }
      if (
        body.client_id !== this.app.clientId ||
        !sameSecret(body.client_secret ?? "", this.app.clientSecret)
      ) {
        json(response, 200, { error: "incorrect_client_credentials" });
        return true;
      }
      if (body.grant_type === "refresh_token") {
        record.grant = "refresh_token";
        const userId = this.refresh.get(body.refresh_token);
        if (userId === undefined) {
          json(response, 200, { error: "bad_refresh_token" });
          return true;
        }
        this.refresh.delete(body.refresh_token);
        for (const token of this.tokensOf(userId)) this.access.delete(token);
        json(response, 200, this.#mintPair(userId));
        return true;
      }
      record.grant = "authorization_code";
      const pending = this.codes.get(body.code);
      if (pending === undefined) {
        json(response, 200, { error: "bad_verification_code" });
        return true;
      }
      this.codes.delete(body.code);
      if (sha256b64url(body.code_verifier ?? "") !== pending.challenge) {
        json(response, 200, { error: "bad_verification_code" });
        return true;
      }
      if (body.redirect_uri !== pending.redirectUri) {
        json(response, 200, { error: "redirect_uri_mismatch" });
        return true;
      }
      json(response, 200, this.#mintPair(pending.userId));
      return true;
    }
    return false;
  }

  async #api(request, response, path, record) {
    const method = request.method;
    const raw = method === "GET" || method === "HEAD" ? Buffer.alloc(0) : await readBody(request);
    const body = fieldsOf(request, raw);
    const notFound = () => json(response, 404, { message: "Not Found" });

    if (path === "/user" || path === "/user/emails" || path === "/user/installations") {
      record.credential = "user";
      const user = this.#userOfToken(this.#bearer(request));
      if (user === null) return json(response, 401, { message: "Bad credentials" });
      if (path === "/user")
        return json(response, 200, { id: user.id, login: user.login, name: user.name });
      if (path === "/user/emails") return json(response, 200, user.emails);
      const installations = user.installations.flatMap((id) => this.installations.get(id) ?? []);
      return json(response, 200, { total_count: installations.length, installations });
    }

    if (path === `/applications/${this.app.clientId}/token` && method === "POST") {
      record.credential = "client";
      if (!this.#clientAuthValid(request))
        return json(response, 401, { message: "Bad credentials" });
      return this.#userOfToken(body.access_token) === null
        ? notFound()
        : json(response, 200, { token: "[redacted]" });
    }
    if (path === `/applications/${this.app.clientId}/grant` && method === "DELETE") {
      record.credential = "client";
      if (!this.#clientAuthValid(request))
        return json(response, 401, { message: "Bad credentials" });
      const user = this.#userOfToken(body.access_token);
      if (user === null) return notFound();
      for (const [token, entry] of this.access)
        if (entry.userId === user.id) this.access.delete(token);
      for (const [token, id] of this.refresh) if (id === user.id) this.refresh.delete(token);
      response.writeHead(204);
      response.end();
      return undefined;
    }

    if (path.startsWith("/app/")) {
      record.credential = "app";
      if (!this.#appJwtValid(request))
        return json(response, 401, { message: "A JSON web token could not be decoded" });
      if (path === "/app/installations")
        return json(response, 200, [...this.installations.values()]);
      let match = /^\/app\/installations\/(\d+)$/u.exec(path);
      if (match) {
        const found = this.installations.get(Number(match[1]));
        return found === undefined ? notFound() : json(response, 200, found);
      }
      match = /^\/app\/installations\/(\d+)\/access_tokens$/u.exec(path);
      if (match && method === "POST") {
        const installationId = Number(match[1]);
        if (!this.installations.has(installationId)) return notFound();
        const token = `ghs_${randomBytes(18).toString("hex")}`;
        const expiresAt = Date.now() + 3600_000;
        this.installationTokens.set(token, { installationId, expiresAt });
        return json(response, 201, { token, expires_at: new Date(expiresAt).toISOString() });
      }
      if (path === "/app/hook/deliveries") return json(response, 200, []);
      return notFound();
    }

    if (path === "/installation/repositories" || path.startsWith("/repositories/")) {
      record.credential = "installation";
      const entry = this.installationTokens.get(this.#bearer(request));
      if (entry === undefined || entry.expiresAt <= Date.now()) {
        return json(response, 401, { message: "Bad credentials" });
      }
      const repos = this.installations.get(entry.installationId)?.repositories ?? [];
      if (path === "/installation/repositories") {
        return json(response, 200, { total_count: repos.length, repositories: repos });
      }
      const repo = repos.find((candidate) => String(candidate.id) === path.split("/")[2]);
      return repo === undefined ? notFound() : json(response, 200, repo);
    }
    return notFound();
  }

  async #git(request, response, url, match, record) {
    const [, owner, name, rest] = match;
    record.repo = `${owner}/${name}`;
    const credential = this.gitCredentialFor(request.headers.authorization, owner, name);
    record.credential = credential ?? "none";
    if (credential === null) {
      response.writeHead(401, {
        "www-authenticate": 'Basic realm="GitHub"',
        "content-type": "text/plain",
      });
      response.end("Invalid username or token.\n");
      return;
    }
    const service = url.searchParams.get("service") ?? rest.replace(/^\//u, "");
    record.service = service;
    const body = await readBody(request);
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_PROJECT_ROOT: this.gitRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${owner}/${name}.git${rest}`,
      QUERY_STRING: url.search.replace(/^\?/u, ""),
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: String(request.headers["content-type"] ?? ""),
      CONTENT_LENGTH: String(body.length),
      REMOTE_USER: credential,
      REMOTE_ADDR: request.socket.remoteAddress ?? "127.0.0.1",
      HTTP_GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
      HTTP_CONTENT_ENCODING: String(request.headers["content-encoding"] ?? ""),
    };
    const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.stdin.end(body);
    const code = await new Promise((done) => child.once("close", done));
    if (code !== 0) record.error = Buffer.concat(err).toString("utf8").slice(0, 500);
    const { status, headers, body: payload } = splitCgi(Buffer.concat(out));
    record.status = status;
    response.writeHead(status, { ...headers, "content-length": payload.length });
    response.end(payload);
  }

  async #handle(request, response) {
    const url = new URL(request.url ?? "/", "http://fake-github.invalid");
    const record = { at: Date.now(), method: request.method, path: url.pathname };
    this.requests.push(record);
    try {
      const gitMatch = GIT_PATH.exec(url.pathname);
      if (gitMatch) return await this.#git(request, response, url, gitMatch, record);
      if (url.pathname.startsWith(`${API_PREFIX}/`)) {
        return await this.#api(request, response, url.pathname.slice(API_PREFIX.length), record);
      }
      if (await this.#web(request, response, url, record)) return undefined;
      json(response, 404, { message: "Not Found" });
    } catch (error) {
      record.error = String(error?.message ?? error);
      if (!response.headersSent) json(response, 500, { message: "fake GitHub fault" });
      else response.destroy();
    } finally {
      record.status ??= response.statusCode;
    }
    return undefined;
  }

  async listen(port = 0) {
    const handler = (request, response) => void this.#handle(request, response);
    const http = createServer(handler);
    this.#protocols = [http];
    if (this.#tls === null) {
      this.#server = http;
    } else {
      const https = createHttpsServer({ key: this.#tls.key, cert: this.#tls.cert }, handler);
      this.#protocols.push(https);
      // Read the first chunk, then hand the protocol it speaks a stream that
      // replays it. (A raw socket cannot be handed over with the chunk put
      // back: TLS and the HTTP parser read the native handle, not the stream.)
      this.#server = createNetServer((socket) => {
        socket.on("error", () => socket.destroy());
        socket.once("data", (first) => {
          (first[0] === 0x16 ? https : http).emit("connection", replaying(socket, first));
        });
      });
    }
    await new Promise((done, fail) => {
      this.#server.once("error", fail);
      this.#server.listen(port, this.bind, done);
    });
    return this;
  }

  async close() {
    if (this.#server !== null) {
      const server = this.#server;
      for (const protocol of this.#protocols) protocol.closeAllConnections?.();
      server.closeAllConnections?.();
      await new Promise((done) => server.close(() => done()));
    }
    if (this.#ownsGitRoot) rmSync(this.gitRoot, { recursive: true, force: true });
  }
}

/** Start a fake GitHub listening on a loopback port. */
export async function startFakeGithub(options = {}) {
  const github = new FakeGithub(options);
  return github.listen(options.port ?? 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const option = (flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const github = await startFakeGithub({
    port: Number(option("--port") ?? 0),
    gitRoot: option("--git-root"),
  });
  process.stdout.write(
    `${JSON.stringify({ origin: github.origin, apiUrl: github.apiUrl, webUrl: github.webUrl })}\n`,
  );
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => void github.close().then(() => process.exit(0)));
  }
}
