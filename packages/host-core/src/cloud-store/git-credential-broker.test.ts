/**
 * A runner Session's git credentials end to end over the real wire: git's
 * credential request → the helper's client → the runner's Unix socket →
 * the broker → `/runner/github-token` (a fake deployment site over real
 * `fetch` semantics) → the answer git reads.
 */
import { execFile } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { RunnerGithubTokenGrant } from "@volli/shared/cloud";

import { createSessionTokenRegistry } from "../session-tokens";
import {
  askGitCredentialDaemon,
  createGitCredentialBroker,
  GIT_CREDENTIAL_EXPLAIN_ONLY_FLAG,
  runnerSessionGitEnv,
  serveGitCredentials,
} from "./git-credential-broker";
import {
  createRunnerGithubTokens,
  GITHUB_NOT_CONNECTED_TTL_MS,
  type RunnerGithub,
} from "./github-tokens";

const SESSION = "00000000-0000-4000-8000-000000000201";
const OTHER_SESSION = "00000000-0000-4000-8000-000000000202";
const REPO = "00000000-0000-4000-8000-000000000203";
const SITE = "https://deployment.convex.site.test";

let dir: string;
const closers: (() => Promise<void>)[] = [];
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "volli-git-cred-")));
});
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  rmSync(dir, { recursive: true, force: true });
});

const grant = (patch: Partial<RunnerGithubTokenGrant> = {}): RunnerGithubTokenGrant => ({
  token: "ghu_box_token",
  useUntil: Date.now() + 3_600_000,
  host: "github.com",
  login: "dana",
  identity: { name: "Dana Doe", email: "501+dana@users.noreply.github.com" },
  ...patch,
});

/** A fake deployment site answering `/runner/github-token`. */
function site(answer: (body: unknown, auth: string | null) => Response) {
  const calls: { url: string; body: unknown; auth: string | null }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ url: String(url), body, auth });
    return answer(body, auth);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function world(options: { answer?: (body: unknown) => Response; allowHttp?: boolean } = {}) {
  const sessions = createSessionTokenRegistry();
  const sessionToken = sessions.mint({ sessionId: SESSION, attachmentId: "attachment-1" });
  const fake = site((body) => options.answer?.(body) ?? json(200, grant()));
  const tokens = createRunnerGithubTokens({
    siteUrl: `${SITE}/`,
    runnerToken: async () => "runner-jwt",
    fetch: fake.fetch,
  });
  const broker = createGitCredentialBroker({
    verifySession: (token) => sessions.verify(token),
    repositoryOf: async (sessionId) => (sessionId === SESSION ? REPO : null),
    tokens,
    ...(options.allowHttp === undefined ? {} : { allowHttp: options.allowHttp }),
  });
  const socketPath = join(dir, "git-credential.sock");
  const served = await serveGitCredentials({ socketPath, broker });
  closers.push(() => served.close());
  const reply = (
    request: string,
    env: Record<string, string | undefined> = {
      VOLLI_SESSION: SESSION,
      VOLLI_SESSION_TOKEN: sessionToken,
    },
    action = "get",
    explainOnly = false,
  ) => askGitCredentialDaemon({ socketPath, action, request, env, explainOnly });
  const ask = async (...args: Parameters<typeof reply>) => (await reply(...args)).answer;
  return { ask, reply, fake, tokens, socketPath, sessionToken, sessions };
}

const GITHUB = "protocol=https\nhost=github.com\npath=acme/app.git\n\n";

describe("a runner Session's git credentials", () => {
  it("answer the owner's token for the token's host, over a socket only this account opens", async () => {
    const { ask, fake, tokens, socketPath } = await world();
    expect(tokens.github()).toEqual({ state: "unknown" });
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(await ask(GITHUB)).toBe(
      `username=x-access-token\npassword=ghu_box_token\npassword_expiry_utc=${Math.floor(grant().useUntil / 1000)}\n`,
    );
    expect(fake.calls).toEqual([
      {
        url: `${SITE}/runner/github-token`,
        body: { sessionId: SESSION, projectRepoId: REPO },
        auth: "Bearer runner-jwt",
      },
    ]);
    expect(tokens.github()).toEqual({
      state: "connected",
      host: "github.com",
      identity: grant().identity,
    });
    // Cached until its useUntil: the second git command asks nobody.
    expect(await ask("protocol=https\nhost=GitHub.com\nusername=x-access-token\n")).toContain(
      "password=ghu_box_token",
    );
    expect(fake.calls).toHaveLength(1);
  });

  it("answers nothing to another host, plain http, store/erase, or another user", async () => {
    const { ask, fake } = await world();
    expect(await ask("protocol=https\nhost=gitlab.com\n")).toBe("");
    expect(await ask("protocol=http\nhost=github.com\n")).toBe("");
    expect(await ask("protocol=https\nhost=github.com\nusername=alice\n")).toBe("");
    expect(await ask("protocol=https\n")).toBe("");
    expect(await ask(GITHUB, undefined, "store")).toBe("");
    expect(await ask(GITHUB, undefined, "erase")).toBe("");
    expect(fake.calls).toHaveLength(1);
    // Once a grant has named GitHub's host, another host costs no backend call.
    expect(await ask(GITHUB)).toContain("password=");
    expect(await ask("protocol=https\nhost=bitbucket.org\n")).toBe("");
    expect(fake.calls).toHaveLength(1);
    const lenient = await world({ allowHttp: true });
    expect(await lenient.ask("protocol=http\nhost=github.com\n")).toContain("password=");
  });

  it("answers nothing without the Session's own token", async () => {
    const { ask, fake, sessionToken, sessions } = await world();
    expect(await ask(GITHUB, { VOLLI_SESSION: SESSION })).toBe("");
    expect(
      await ask(GITHUB, { VOLLI_SESSION: OTHER_SESSION, VOLLI_SESSION_TOKEN: sessionToken }),
    ).toBe("");
    expect(await ask(GITHUB, { VOLLI_SESSION: SESSION, VOLLI_SESSION_TOKEN: "forged" })).toBe("");
    sessions.revoke("attachment-1");
    expect(await ask(GITHUB, { VOLLI_SESSION: SESSION, VOLLI_SESSION_TOKEN: sessionToken })).toBe(
      "",
    );
    const other = sessions.mint({ sessionId: OTHER_SESSION, attachmentId: "attachment-2" });
    // A Session with no repository on this runner gets nothing either.
    expect(await ask(GITHUB, { VOLLI_SESSION: OTHER_SESSION, VOLLI_SESSION_TOKEN: other })).toBe(
      "",
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("falls through when GitHub isn't connected, and remembers that for a minute", async () => {
    let now = 1_000;
    const fake = site(() =>
      json(409, { error: { code: "github_not_connected", message: "no", resetAt: null } }),
    );
    const tokens = createRunnerGithubTokens({
      siteUrl: SITE,
      runnerToken: async () => "jwt",
      fetch: fake.fetch,
      now: () => now,
    });
    const request = {
      claim: { kind: "session" as const, sessionId: SESSION as never },
      projectRepoId: REPO as never,
    };
    expect(await tokens.get(request)).toMatchObject({
      ok: false,
      error: { code: "github_not_connected" },
    });
    expect(tokens.github()).toEqual({ state: "disconnected" });
    await tokens.get(request);
    expect(fake.calls).toHaveLength(1);
    now += GITHUB_NOT_CONNECTED_TTL_MS;
    await tokens.get(request);
    expect(fake.calls).toHaveLength(2);
    tokens.forget(SESSION);
    await tokens.get(request);
    expect(fake.calls).toHaveLength(3);
  });

  it("a stale grant, another refusal, an outage or no runner token are never cached as a token", async () => {
    let now = 0;
    const replies = [
      json(200, grant({ useUntil: 10 })),
      json(503, { error: { code: "github_unavailable", message: "down" } }),
      new Response("not json", { status: 502 }),
      json(200, { token: "" }),
    ];
    const fake = site(() => replies.shift() ?? json(200, grant()));
    const tokens = createRunnerGithubTokens({
      siteUrl: SITE,
      runnerToken: async () => "jwt",
      fetch: fake.fetch,
      now: () => now,
    });
    const request = {
      claim: { kind: "job" as const, jobId: SESSION as never },
      projectRepoId: REPO as never,
    };
    expect((await tokens.get(request)).ok).toBe(true);
    now = 10;
    expect(await tokens.get(request)).toMatchObject({ error: { code: "github_unavailable" } });
    expect(await tokens.get(request)).toMatchObject({ error: { code: "github_unavailable" } });
    expect(await tokens.get(request)).toMatchObject({
      error: { message: "Volli Cloud answered with an unusable token." },
    });
    expect(fake.calls[0]!.body).toEqual({ jobId: SESSION, projectRepoId: REPO });
    const unreachable = createRunnerGithubTokens({
      siteUrl: SITE,
      runnerToken: async () => "jwt",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof globalThis.fetch,
    });
    expect(await unreachable.get(request)).toMatchObject({
      error: { message: "Volli Cloud is unreachable." },
    });
    const unlinked = createRunnerGithubTokens({ siteUrl: SITE, runnerToken: async () => null });
    expect(await unlinked.get(request)).toMatchObject({ error: { code: "unauthenticated" } });
  });

  it("a connection that needs a reconnect reads as disconnected", async () => {
    let now = 0;
    const replies = [
      json(200, grant({ useUntil: 10 })),
      json(409, { error: { code: "github_needs_reconnect", message: "again" } }),
    ];
    const fake = site(() => replies.shift()!);
    const tokens = createRunnerGithubTokens({
      siteUrl: SITE,
      runnerToken: async () => "jwt",
      fetch: fake.fetch,
      now: () => now,
    });
    const request = {
      claim: { kind: "session" as const, sessionId: SESSION as never },
      projectRepoId: REPO as never,
    };
    await tokens.get(request);
    expect(tokens.github().state).toBe("connected");
    now = 10;
    await tokens.get(request);
    expect(tokens.github()).toEqual({ state: "disconnected" });
  });

  it("a refusal the person can fix comes back as one stderr line, never a token", async () => {
    const NOW = 5_000_000;
    const refused = async (error: Record<string, unknown>) => {
      const { reply } = await world({ answer: () => json(409, { error }) });
      return reply(GITHUB);
    };
    expect(await refused({ code: "github_not_connected", message: "m" })).toEqual({
      answer: "",
      stderr: "volli: GitHub isn't connected. Connect it in Volli → Settings → Account.\n",
    });
    expect(await refused({ code: "github_needs_reconnect", message: "m" })).toEqual({
      answer: "",
      stderr: "volli: GitHub needs reconnecting. Reconnect it in Volli → Settings → Account.\n",
    });
    expect(await refused({ code: "github_not_installed", message: "m", account: "acme" })).toEqual({
      answer: "",
      stderr: "volli: Volli can't reach this repository. Install Volli on acme on GitHub.\n",
    });
    expect((await refused({ code: "github_rate_limited", message: "m" })).stderr).toBe(
      "volli: GitHub is rate limiting Volli. Try again in a few minutes.\n",
    );
    // Not the person's to fix: git says what it says, Volli adds nothing.
    expect(await refused({ code: "github_unavailable", message: "m" })).toEqual({
      answer: "",
      stderr: "",
    });
    // The broker's clock words a rate limit's wait.
    const tokens = {
      github: () => ({ state: "unknown" }) as const,
      get: async () => ({
        ok: false as const,
        error: {
          code: "github_rate_limited" as const,
          message: "m",
          resetAt: NOW + 120_000,
          account: null,
        },
      }),
    };
    const broker = createGitCredentialBroker({
      verifySession: () => SESSION,
      repositoryOf: async () => REPO,
      tokens,
      now: () => NOW,
    });
    expect(
      await broker.answer({ v: 1, action: "get", request: GITHUB, session: SESSION, token: "t" }),
    ).toEqual({
      answer: "",
      stderr: "volli: GitHub is rate limiting Volli. Try again in 2 minutes.\n",
    });
  });

  it("explain-only never answers a token, but still says why there is none", async () => {
    const { reply, sessionToken } = await world();
    const env = { VOLLI_SESSION: SESSION, VOLLI_SESSION_TOKEN: sessionToken };
    expect(await reply(GITHUB, env, "get", true)).toEqual({
      answer: "",
      stderr: "volli: GitHub is connected now. Run the command again.\n",
    });
    const refusing = await world({
      answer: () => json(409, { error: { code: "github_not_connected", message: "m" } }),
    });
    const refused = await refusing.reply(
      GITHUB,
      { VOLLI_SESSION: SESSION, VOLLI_SESSION_TOKEN: refusing.sessionToken },
      "get",
      true,
    );
    expect(refused.answer).toBe("");
    expect(refused.stderr).toContain("Connect it in Volli");
  });

  it("the helper prints at most one plain line of what the runner sends for stderr", async () => {
    const at = (name: string, line: string) => {
      const socketPath = join(dir, name);
      const open = new Set<Socket>();
      const server = createServer((socket) => {
        open.add(socket);
        socket.on("error", () => {});
        socket.end(line);
      });
      closers.push(
        () =>
          new Promise((resolve) => {
            for (const socket of open) socket.destroy();
            server.close(() => resolve());
          }),
      );
      return new Promise<string>((resolve) => server.listen(socketPath, () => resolve(socketPath)));
    };
    const ask = async (line: string) =>
      askGitCredentialDaemon({
        socketPath: await at(`s${closers.length}.sock`, line),
        action: "get",
        request: GITHUB,
        env: {},
      });
    // An older runner sends no stderr.
    expect(await ask(`${JSON.stringify({ v: 1, answer: "a" })}\n`)).toEqual({
      answer: "a",
      stderr: "",
    });
    expect(
      await ask(`${JSON.stringify({ v: 1, answer: "", stderr: "one\u001b[2J\rline\nsecond" })}\n`),
    ).toEqual({ answer: "", stderr: "one[2Jline\n" });
    expect(
      await ask(`${JSON.stringify({ v: 1, answer: "", stderr: "a\u202eb\u2028c" })}\n`),
    ).toEqual({ answer: "", stderr: "ab\n" });
    expect(await ask(`${JSON.stringify({ v: 1, answer: "", stderr: "\nx" })}\n`)).toEqual({
      answer: "",
      stderr: "",
    });
    expect(await ask(`${JSON.stringify({ v: 2, answer: "a" })}\n`)).toEqual({
      answer: "",
      stderr: "",
    });
    expect(await ask("not json\n")).toEqual({ answer: "", stderr: "" });
  });

  it("Volli not installed on the repository's account is remembered for a minute and keeps the connection", async () => {
    let now = 0;
    const fake = site(() =>
      json(409, { error: { code: "github_not_installed", message: "m", account: "acme" } }),
    );
    const tokens = createRunnerGithubTokens({
      siteUrl: SITE,
      runnerToken: async () => "jwt",
      fetch: fake.fetch,
      now: () => now,
    });
    const request = {
      claim: { kind: "session" as const, sessionId: SESSION as never },
      projectRepoId: REPO as never,
    };
    expect(await tokens.get(request)).toMatchObject({
      ok: false,
      error: { code: "github_not_installed", account: "acme" },
    });
    expect(tokens.github()).toEqual({ state: "unknown" });
    await tokens.get(request);
    expect(fake.calls).toHaveLength(1);
    now += GITHUB_NOT_CONNECTED_TTL_MS;
    await tokens.get(request);
    expect(fake.calls).toHaveLength(2);
  });

  it("concurrent askers share one request", async () => {
    const { ask, fake } = await world();
    await Promise.all([ask(GITHUB), ask(GITHUB), ask(GITHUB)]);
    expect(fake.calls).toHaveLength(1);
  });

  it("a down runner or a malformed exchange answers nothing", async () => {
    expect(
      await askGitCredentialDaemon({
        socketPath: join(dir, "absent.sock"),
        action: "get",
        request: GITHUB,
        env: {},
      }),
    ).toEqual({ answer: "", stderr: "" });
    const broken = await serveGitCredentials({
      socketPath: join(dir, "broken.sock"),
      broker: {
        answer: async () => {
          throw new Error("boom");
        },
      },
      onError: () => {},
    });
    closers.push(() => broken.close());
    expect(
      await askGitCredentialDaemon({
        socketPath: join(dir, "broken.sock"),
        action: "get",
        request: GITHUB,
        env: {},
      }),
    ).toEqual({ answer: "", stderr: "" });
    writeFileSync(join(dir, "not-a-socket"), "x");
    await expect(
      serveGitCredentials({ socketPath: join(dir, "not-a-socket"), broker: broken as never }),
    ).rejects.toThrow(/not a socket/u);
  });

  it(
    "is what git itself reads, and a box `store` helper never sees the token",
    { timeout: 30_000 },
    async () => {
      const { socketPath, sessionToken, tokens } = await world();
      // A stand-in for `volli-runner git-credential`: git runs it; it relays its
      // argv, stdin and environment to this test, which answers through the
      // real client (`askGitCredentialDaemon`), and prints what comes back.
      const relayPath = join(dir, "relay.sock");
      const relay = createServer((socket) => {
        let raw = "";
        socket.on("data", (chunk) => {
          raw += chunk.toString("utf8");
          if (!raw.endsWith("\n")) return;
          const call = JSON.parse(raw) as {
            argv: string[];
            input: string;
            env: Record<string, string>;
          };
          void askGitCredentialDaemon({
            socketPath,
            action: call.argv.at(-1)!,
            request: call.input,
            env: call.env,
            explainOnly: call.argv.includes(GIT_CREDENTIAL_EXPLAIN_ONLY_FLAG),
          }).then((reply) => socket.end(reply.answer));
        });
      });
      await new Promise<void>((resolve) => relay.listen(relayPath, resolve));
      closers.push(() => new Promise((resolve) => relay.close(() => resolve())));
      const helper = join(dir, "helper.mjs");
      writeFileSync(
        helper,
        `import { createConnection } from "node:net";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const socket = createConnection(${JSON.stringify(relayPath)});
socket.write(JSON.stringify({ argv: process.argv.slice(2), input, env: { VOLLI_SESSION: process.env.VOLLI_SESSION, VOLLI_SESSION_TOKEN: process.env.VOLLI_SESSION_TOKEN } }) + "\\n");
socket.pipe(process.stdout);
`,
      );
      // The box's own configuration: a plaintext `store` helper that already
      // holds a personal token for GitHub.
      const stored = join(dir, "git-credentials");
      writeFileSync(stored, "https://box-user:box_pat@github.com\n");
      const globalConfig = join(dir, "gitconfig");
      writeFileSync(globalConfig, `[credential]\n\thelper = store --file ${stored}\n`);
      const git = (args: string[], input: string, github: RunnerGithub) =>
        new Promise<string>((resolve, reject) => {
          const env = runnerSessionGitEnv(
            { VOLLI_SESSION: SESSION, VOLLI_SESSION_TOKEN: sessionToken, GIT_CONFIG_NOSYSTEM: "1" },
            { helperCommand: `!node ${helper}`, github },
          );
          const child = execFile(
            "git",
            args,
            {
              // Outside any repository, so no repository's own helpers join the chain.
              cwd: dir,
              env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: globalConfig, ...env },
            },
            (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
          );
          child.stdin!.end(input);
        });

      const fill = (github: RunnerGithub) =>
        git(["credential", "fill"], "protocol=https\nhost=github.com\n\n", github);
      // Known disconnected: the box's own chain answers GitHub, and no Volli helper is asked.
      expect(await fill({ state: "disconnected" })).toContain("password=box_pat");
      // Before any answer, and once the runner serves the owner's token, only
      // Volli's helper is asked for GitHub, and git's approve never reaches the store.
      expect(tokens.github()).toEqual({ state: "unknown" });
      const first = await fill(tokens.github());
      expect(first).toContain("password=ghu_box_token");
      await git(["credential", "approve"], first, tokens.github());
      const github = tokens.github();
      expect(github.state).toBe("connected");
      const filled = await fill(github);
      expect(filled).toContain("username=x-access-token");
      expect(filled).toContain("password=ghu_box_token");
      await git(["credential", "approve"], filled, github);
      expect(readFileSync(stored, "utf8")).toBe("https://box-user:box_pat@github.com\n");
      // Other hosts keep the box's chain.
      writeFileSync(stored, "https://me:other_pat@gitlab.example.com\n");
      expect(
        await git(["credential", "fill"], "protocol=https\nhost=gitlab.example.com\n\n", github),
      ).toContain("password=other_pat");
      // Known disconnected with nothing in the box's chain for GitHub: Volli's
      // helper is asked last, explain-only, and hands out no token even though
      // the runner holds one, so git fails rather than leak it to the store.
      await expect(fill({ state: "disconnected" })).rejects.toThrow();
      expect(readFileSync(stored, "utf8")).toBe("https://me:other_pat@gitlab.example.com\n");
    },
  );
});

describe("runnerSessionGitEnv", () => {
  it("resets GitHub's helper chain to Volli's alone while the token is served", () => {
    const github: RunnerGithub = {
      state: "connected",
      host: "github.com",
      identity: grant().identity,
    };
    const env = runnerSessionGitEnv(
      { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c" },
      { helperCommand: "!volli-runner git-credential", github },
    );
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: "5",
      GIT_CONFIG_KEY_0: "a.b",
      GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_KEY_2: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_2: "!volli-runner git-credential",
      GIT_CONFIG_KEY_3: "credential.http://github.com.helper",
      GIT_CONFIG_VALUE_3: "",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Dana Doe",
      GIT_COMMITTER_EMAIL: "501+dana@users.noreply.github.com",
    });
    expect(
      runnerSessionGitEnv({ GIT_AUTHOR_NAME: "Box Owner" }, { helperCommand: "!h", github })
        .GIT_AUTHOR_NAME,
    ).toBe("Box Owner");
  });

  it("before any answer, resets github.com's chain, with no identity yet", () => {
    const env = runnerSessionGitEnv({}, { helperCommand: "!h", github: { state: "unknown" } });
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_VALUE_1: "!h",
    });
    expect(env).not.toHaveProperty("GIT_AUTHOR_NAME");
  });

  it("known disconnected, leaves the box's chain whole and appends Volli's helper, explain-only", () => {
    const env = runnerSessionGitEnv({}, { helperCommand: "!h", github: { state: "disconnected" } });
    expect(env).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_0: "!h --explain-only",
      GIT_CONFIG_KEY_1: "credential.http://github.com.helper",
      GIT_CONFIG_VALUE_1: "!h --explain-only",
      GIT_TERMINAL_PROMPT: "0",
    });
  });
});
