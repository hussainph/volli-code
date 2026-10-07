/** VC-713: a real Session pushes its Ticket branch through VC-702's helper. */
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { piOwnedModelAccess } from "@volli/agent-runtime";
import { isLiveHost } from "@volli/host-core";
import {
  fileGitCredentialStore,
  GIT_CREDENTIALS_FILE,
  shellWord,
} from "@volli/host-core/session-runtime";
import { resetRetentionWatcherForTest } from "@volli/host-core/testing";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { scriptedProvider } from "../../../packages/agent-runtime/test-fixtures/scripted-provider";
import { startHostd, type RunningHostd } from "./hostd";

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, "../../..");
const cliBundle = join(repo, "packages/cli/dist/volli.cjs");
const TOKEN = "ghp_SESSIONPUSHPROOF0123456789abcdef";

/** Same prerequisites as git-credential.test.ts's HTTPS push proof. */
function pushProofTools(): { backend: string } | null {
  if (spawnSync("openssl", ["version"]).status !== 0) return null;
  const execPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  if (execPath.status !== 0) return null;
  const backend = join(execPath.stdout.trim(), "git-http-backend");
  return existsSync(backend) ? { backend } : null;
}
const tools = pushProofTools();

/** No machine git configuration, credential helpers, prompts or identity. */
function isolated(root: string): Record<string, string> {
  const home = join(root, "home");
  mkdirSync(home);
  const global = join(root, "gitconfig");
  writeFileSync(global, "");
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    VOLLI_WORKTREE_HOME_DIR: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: global,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Volli Box",
    GIT_AUTHOR_EMAIL: "box@example.invalid",
    GIT_COMMITTER_NAME: "Volli Box",
    GIT_COMMITTER_EMAIL: "box@example.invalid",
    VOLLI_EXPERIMENTAL: "cloud",
  };
}

/** git-http-backend over loopback HTTPS, with a throwaway cert and Basic auth. */
async function httpsRemote(root: string, env: NodeJS.ProcessEnv, backend: string) {
  const serverRoot = join(root, "server");
  mkdirSync(serverRoot);
  const bare = join(serverRoot, "repo.git");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", bare], { env });
  const key = join(root, "key.pem");
  const cert = join(root, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
    ],
    { env, stdio: "pipe" },
  );
  const expected = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
  let authenticated = 0;
  const server: Server = createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (request, response) => {
      if (request.headers.authorization !== expected) {
        response.writeHead(401, { "WWW-Authenticate": 'Basic realm="session-proof"' }).end();
        return;
      }
      authenticated++;
      const url = new URL(request.url ?? "/", "https://127.0.0.1");
      const cgi = spawn(backend, [], {
        env: {
          ...env,
          GIT_PROJECT_ROOT: serverRoot,
          GIT_HTTP_EXPORT_ALL: "1",
          REMOTE_USER: "x-access-token",
          REMOTE_ADDR: "127.0.0.1",
          REQUEST_METHOD: request.method ?? "GET",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          ...(request.headers["content-length"] === undefined
            ? {}
            : { CONTENT_LENGTH: request.headers["content-length"] }),
          HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
          GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
        },
      });
      request.pipe(cgi.stdin);
      const chunks: Buffer[] = [];
      cgi.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      cgi.on("close", () => {
        const output = Buffer.concat(chunks);
        const split = output.indexOf("\r\n\r\n");
        const head = output.subarray(0, split).toString("latin1").split("\r\n");
        let status = 200;
        const headers: Record<string, string> = {};
        for (const line of head) {
          const colon = line.indexOf(":");
          const name = line.slice(0, colon).trim();
          const value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
          else headers[name] = value;
        }
        response.writeHead(status, headers).end(output.subarray(split + 4));
      });
    },
  );
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  return {
    url: `https://127.0.0.1:${port}/repo.git`,
    host: `127.0.0.1:${port}`,
    bare,
    authenticated: () => authenticated,
    close: () => new Promise<void>((closed) => server.close(() => closed())),
  };
}

describe.skipIf(tools === null)("Session HTTPS branch push (VC-713)", () => {
  let root: string | undefined;
  let host: RunningHostd | undefined;
  let remote: Awaited<ReturnType<typeof httpsRemote>> | undefined;
  beforeAll(
    () =>
      execFileSync("pnpm", ["--filter", "@volli/hostd", "--filter", "@volli/cli", "build"], {
        cwd: repo,
        stdio: "pipe",
        timeout: 120_000,
      }),
    125_000,
  );
  afterEach(async () => {
    try {
      if (host !== undefined) await host.stop("push proof done");
      if (remote !== undefined) await remote.close();
      resetRetentionWatcherForTest();
      if (root !== undefined) rmSync(root, { recursive: true, force: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("pushes its own worktree branch using this host's stored credential, without leaking it", async () => {
    root = mkdtempSync(join(tmpdir(), "hostd-session-push-"));
    const env = isolated(root);
    // Worktree git inherits process.env. Remove ambient git overrides,
    // proxies and shell startup hooks, then isolate the host; the scripted
    // bash command reinstates the config isolation that Pi filters out.
    for (const key of Object.keys(process.env)) {
      if (
        key.startsWith("GIT_") ||
        /^(https?|all|no)_proxy$/i.test(key) ||
        key === "BASH_ENV" ||
        key === "ENV"
      )
        vi.stubEnv(key, undefined);
    }
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
    remote = await httpsRemote(root, env, tools!.backend);
    expect(git(remote.bare, "for-each-ref", "--format=%(refname)")).toBe("");
    const repository = join(root, "project");
    mkdirSync(repository);
    git(repository, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(repository, "README.md"), "# HTTPS Session proof\n");
    git(repository, "add", "README.md");
    git(repository, "commit", "--quiet", "-m", "Initial commit");
    git(repository, "remote", "add", "origin", remote.url);
    git(repository, "config", "http.sslVerify", "false");
    git(repository, "config", "user.name", "Volli Box");
    git(repository, "config", "user.email", "box@example.invalid");
    const helpers = spawnSync("git", ["config", "--get-all", "credential.helper"], {
      cwd: repository,
      env,
      encoding: "utf8",
    });
    expect(helpers.status).toBe(1);
    expect(helpers.stdout).toBe("");

    const dataDir = join(root, "data");
    mkdirSync(dataDir, { mode: 0o700 });
    // Exactly the store populated by HostSignIns.setGitCredential, not a
    // repository credential or an environment variable containing the token.
    await fileGitCredentialStore(join(dataDir, GIT_CREDENTIALS_FILE)).set(remote.host, {
      username: "x-access-token",
      password: TOKEN,
    });
    const helper = `!${[process.execPath, join(repo, "apps/hostd/dist/hostd.cjs"), "git-credential", "--data-dir", dataDir].map(shellWord).join(" ")}`;
    const script = scriptedProvider([
      {
        tool: { name: "write", args: { path: "GREETING.md", content: "Pushed by the Session\n" } },
      },
      {
        tool: {
          name: "bash",
          args: {
            command: [
              `test "$HOME" = ${shellWord(env.HOME!)}`,
              // Pi deliberately strips ambient GIT_* variables. Install only
              // the scratch-config isolation inside bash, leaving the helper
              // GIT_CONFIG_COUNT/KEY/VALUE supplied by the runtime untouched.
              `export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=${shellWord(env.GIT_CONFIG_GLOBAL!)} GIT_TERMINAL_PROMPT=0`,
              "git config --show-scope --get-all credential.helper",
              "git add GREETING.md",
              "git commit --quiet -m 'Session HTTPS push'",
              "git push origin HEAD",
              "printf 'SESSION_PUSH_SUCCEEDED\\n'",
            ].join(" && "),
          },
        },
      },
      { text: "Pushed the Ticket branch over HTTPS." },
    ]);
    const socketPath = join(dataDir, "volli.sock");
    const operator = "push-proof-operator";
    const operatorsFile = join(root, "operators");
    writeFileSync(
      operatorsFile,
      `ops ${process.getuid!()} sha256:${createHash("sha256").update(operator).digest("hex")} now\n`,
      { mode: 0o600 },
    );
    host = await startHostd({
      dataDir,
      socketPath,
      operatorsFile,
      operatorsOwnerUid: process.getuid!(),
      version: "test",
      env,
      gitCredentialHelper: helper,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      runtime: {
        binDir: join(repo, "packages/cli/dist"),
        venue: { id: socketPath, kind: "remote" },
        gitCredentialHelper: helper,
        modelAccess: {
          ...piOwnedModelAccess({ agentDir: join(root, "pi") }),
          models: script.models,
        },
      },
    });
    if (!isLiveHost(host.host)) throw new Error(host.host.database.error);
    const core = host.host;
    const cli = async (...args: string[]) =>
      JSON.parse(
        (
          await exec(process.execPath, [cliBundle, ...args, "--json"], {
            cwd: repository,
            env: { ...env, VOLLI_SOCKET: socketPath, VOLLI_OPERATOR_TOKEN: operator },
          })
        ).stdout,
      );
    const added = await cli("project", "add", repository, "--name", "Push Proof");
    expect(added.created).toBe(true);
    const { ticket } = await cli(
      "ticket",
      "create",
      "--title",
      "Push greeting",
      "--project",
      added.project.prefix,
      "--status",
      "doing",
    );
    expect(ticket.usesWorktree).toBe(true);
    const started = await cli(
      "session",
      "start",
      ticket.id,
      "--model",
      "scripted-fixture/scripted",
      "--reasoning",
      "off",
      "--title",
      "Authenticated push",
      "-m",
      "Commit and push the greeting",
    );
    expect(started.state).toBe("ready");
    await vi.waitFor(
      async () => expect((await cli("session", "answer", started.session)).state).toBe("completed"),
      { timeout: 15_000, interval: 100 },
    );
    const results = script.requests.at(-1)!.filter((message) => message.role === "toolResult");
    expect(
      results.map((message) => [message.toolName, message.isError]),
      JSON.stringify(results),
    ).toEqual([
      ["write", false],
      ["bash", false],
    ]);
    expect(JSON.stringify(results)).toContain(`command\\t${helper}`);
    expect(JSON.stringify(results)).toContain("SESSION_PUSH_SUCCEEDED");
    const projection = await core.sessionEngine.getSession({ sessionId: started.sessionId });
    expect(projection!.lastTurnOutcome).toBe("completed");
    const { ticket: shown } = await cli("ticket", "show", ticket.id);
    expect(shown.worktreePath.startsWith(join(env.HOME!, ".volli", "worktrees"))).toBe(true);
    expect(shown.worktreePath).not.toBe(repository);
    expect(git(shown.worktreePath, "branch", "--show-current")).toBe(shown.branch);
    const head = git(shown.worktreePath, "rev-parse", "HEAD");
    expect(head).not.toBe(git(repository, "rev-parse", "HEAD"));
    expect(git(remote.bare, "rev-parse", `refs/heads/${shown.branch}`)).toBe(head);
    expect(git(remote.bare, "show", `${head}:GREETING.md`)).toBe("Pushed by the Session");
    expect(git(remote.bare, "log", "-1", "--format=%s", head)).toBe("Session HTTPS push");
    expect(remote.authenticated()).toBeGreaterThan(0);

    expect(JSON.stringify(script.requests)).not.toContain(TOKEN);
    const transcript = await cli("session", "peek", started.session, "--lines", "100");
    expect(transcript.transcript.length).toBeGreaterThan(0);
    expect(JSON.stringify(transcript)).not.toContain(TOKEN);
    const events = await core.sessionEngine.listEvents({ sessionId: started.sessionId });
    expect(events.filter(({ payload }) => payload.kind === "turn.completed")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    expect(readFileSync(join(repository, ".git", "config"), "utf8")).not.toContain(TOKEN);
    expect(readFileSync(env.GIT_CONFIG_GLOBAL!, "utf8")).toBe("");
  }, 40_000);
});
