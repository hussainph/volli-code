// @vitest-environment node
/**
 * Volli's git credential helper (VC-702): the command line git runs it with,
 * its answers, and a real `git push` that it authenticates.
 *
 * The push proof never touches a credential helper or a git configuration of
 * this machine's: git runs with no system file (`GIT_CONFIG_NOSYSTEM`), a
 * scratch global file and home, prompts off, and the case asserts, before it
 * pushes, that the only helper git will ask is Volli's, installed by the very
 * environment a Session gets (`gitCredentialHelperEnv`). The remote is a bare
 * repository served over HTTPS (a throwaway self-signed certificate) by
 * `git http-backend`, which demands Basic authentication.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer, type Server } from "node:https";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { join } from "node:path";

import {
  fileGitCredentialStore,
  GIT_CREDENTIALS_FILE,
  gitCredentialHelperEnv,
  shellWord,
} from "@volli/host-core/session-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { parseHostdArgs } from "./args";
import { readAll, runGitCredential } from "./git-credential";
import { defaultGitCredentialHelper } from "./hostd";

const TOKEN = "ghp_PUSHPROOFTOKEN0123456789abcdef";
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vc702-push-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Asks hostd's helper as git would, over the store under `dataDir`. */
async function ask(action: string, request: string, dataDir = root) {
  let out = "";
  const code = await runGitCredential(
    { kind: "git-credential", dataDir, action },
    { stdin: async () => request, out: (text) => (out += text) },
  );
  return { code, out };
}

function git(args: readonly string[], env: NodeJS.ProcessEnv, cwd = root) {
  return spawnSync("git", args, { cwd, env, encoding: "utf8" });
}

/**
 * git that talks to this process's servers: asynchronous, because a
 * synchronous child would block the very event loop that answers it.
 */
function gitTalking(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

describe("volli-hostd git-credential", () => {
  it("takes the action git appends after its options", () => {
    expect(parseHostdArgs(["git-credential", "--data-dir", "data", "get"], "/srv")).toEqual({
      kind: "git-credential",
      dataDir: "/srv/data",
      action: "get",
    });
    expect(() => parseHostdArgs(["git-credential", "get"], "/srv")).toThrow("--data-dir");
    expect(() => parseHostdArgs(["git-credential", "--data-dir", "d"], "/srv")).toThrow(
      "one action",
    );
    expect(() =>
      parseHostdArgs(["git-credential", "--data-dir", "d", "--bogus", "get"], "/srv"),
    ).toThrow("bogus");
  });

  it("reads git's whole request off stdin, however it arrives", async () => {
    expect(
      await readAll(Readable.from(["protocol=https\n", Buffer.from("host=github.com\n")])),
    ).toBe("protocol=https\nhost=github.com\n");
  });

  it("is installed as this very program, every word quoted for git's shell", () => {
    const helper = defaultGitCredentialHelper("/var/lib/volli hostd");
    expect(helper.startsWith(`!${shellWord(process.execPath)} `)).toBe(true);
    expect(helper.endsWith(` 'git-credential' '--data-dir' '/var/lib/volli hostd'`)).toBe(true);
  });

  it("answers `get` from the push-credential store and says nothing otherwise", async () => {
    await fileGitCredentialStore(join(root, GIT_CREDENTIALS_FILE)).set("github.com", {
      username: "x-access-token",
      password: TOKEN,
    });
    expect(await ask("get", "protocol=https\nhost=github.com\n\n")).toEqual({
      code: 0,
      out: `username=x-access-token\npassword=${TOKEN}\n`,
    });
    expect(await ask("store", `protocol=https\nhost=github.com\npassword=${TOKEN}\n`)).toEqual({
      code: 0,
      out: "",
    });
    expect(await ask("get", "protocol=http\nhost=github.com\n")).toEqual({ code: 0, out: "" });
    // An unreadable store is a helper with nothing to say, never an error.
    writeFileSync(join(root, GIT_CREDENTIALS_FILE), "not json");
    expect(await ask("get", "protocol=https\nhost=github.com\n")).toEqual({ code: 0, out: "" });
  });
});

/** Whether this machine can run the proof: openssl for a certificate, git's HTTP backend. */
function pushProofTools(): { backend: string } | null {
  if (spawnSync("openssl", ["version"]).status !== 0) return null;
  const execPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  if (execPath.status !== 0) return null;
  const backend = join(execPath.stdout.trim(), "git-http-backend");
  return existsSync(backend) ? { backend } : null;
}

const tools = pushProofTools();

describe.skipIf(tools === null)("a Session's git push on a host", () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  /** A bare repository over HTTPS, behind Basic authentication, served by git itself. */
  async function httpsRemote(): Promise<{ url: string; bare: string; host: string }> {
    const serverRoot = join(root, "server");
    mkdirSync(serverRoot);
    const bare = join(serverRoot, "repo.git");
    git(["init", "--bare", "--initial-branch=main", bare], serverEnv());
    const key = join(root, "key.pem");
    const cert = join(root, "cert.pem");
    const made = spawnSync("openssl", [
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
    ]);
    expect(made.status).toBe(0);
    const expected = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
    const server: Server = createHttpsServer(
      { key: readFileSync(key), cert: readFileSync(cert) },
      (request, response) => {
        if (request.headers.authorization !== expected) {
          response.writeHead(401, { "WWW-Authenticate": 'Basic realm="proof"' }).end();
          return;
        }
        const url = new URL(request.url ?? "/", "https://127.0.0.1");
        const cgi = spawn(tools!.backend, [], {
          env: {
            ...serverEnv(),
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
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));
    const { port } = server.address() as AddressInfo;
    return { url: `https://127.0.0.1:${port}/repo.git`, bare, host: `127.0.0.1:${port}` };
  }

  /**
   * The helper git runs, as the host installs it, with one indirection: a
   * script that hands git's request to this test process, which answers
   * with hostd's own `git-credential` command over the host's real store.
   */
  async function helperOverStore(dataDir: string): Promise<{ command: string; asked: string[] }> {
    const asked: string[] = [];
    const socketPath = join(root, "helper.sock");
    // Half-open: the script ends its side to say the request is whole, and
    // still reads the answer.
    const server: NetServer = createNetServer({ allowHalfOpen: true }, (socket) => {
      let body = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => (body += chunk));
      socket.on("end", () => {
        const { action, input } = JSON.parse(body) as { action: string; input: string };
        asked.push(action);
        let out = "";
        void runGitCredential(
          { kind: "git-credential", dataDir, action },
          { stdin: async () => input, out: (text) => (out += text) },
        ).then(() => socket.end(out));
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));
    const forward = join(root, "forward.mjs");
    writeFileSync(
      forward,
      `import { connect } from "node:net";
const [socketPath, action] = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const socket = connect(socketPath);
socket.end(JSON.stringify({ action, input }));
let out = "";
socket.setEncoding("utf8");
for await (const chunk of socket) out += chunk;
process.stdout.write(out);
`,
    );
    return {
      command: `!${[process.execPath, forward, socketPath].map(shellWord).join(" ")}`,
      asked,
    };
  }

  /** git with nothing of this machine's: no system file, a scratch global file and home. */
  function isolated(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(root, "gitconfig"), "");
    return {
      PATH: process.env["PATH"],
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Volli",
      GIT_AUTHOR_EMAIL: "volli@example.invalid",
      GIT_COMMITTER_NAME: "Volli",
      GIT_COMMITTER_EMAIL: "volli@example.invalid",
      ...extra,
    };
  }

  function serverEnv(): NodeJS.ProcessEnv {
    return isolated();
  }

  it(
    "pushes over HTTPS with the credential a person sent, and is refused without it",
    { timeout: 60_000 },
    async () => {
      const dataDir = join(root, "data");
      const remote = await httpsRemote();
      const helper = await helperOverStore(dataDir);
      // Exactly the environment a Session's command gets, plus a trust waiver
      // for the throwaway certificate.
      const session = isolated(gitCredentialHelperEnv(helper.command));
      const work = join(root, "work");
      expect(git(["init", "--initial-branch=main", work], session).status).toBe(0);
      writeFileSync(join(work, "README.md"), "pushed by a Session\n");
      expect(git(["add", "README.md"], session, work).status).toBe(0);
      expect(git(["commit", "-m", "Session work"], session, work).status).toBe(0);
      const head = git(["rev-parse", "HEAD"], session, work).stdout.trim();

      // The only helper git will ask is Volli's, from the command scope.
      const helpers = git(
        ["config", "--show-scope", "--get-all", "credential.helper"],
        session,
        work,
      );
      expect(helpers.stdout.trim().split("\n")).toEqual([`command\t${helper.command}`]);

      const push = () =>
        gitTalking(
          ["-c", "http.sslVerify=false", "push", remote.url, "HEAD:refs/heads/volli-push"],
          session,
          work,
        );
      // Nothing stored for this host: the helper has nothing, and the push is refused.
      const refused = await push();
      expect(refused.status).not.toBe(0);
      expect(helper.asked).toContain("get");
      expect(git(["--git-dir", remote.bare, "show-ref"], serverEnv()).stdout).toBe("");

      await fileGitCredentialStore(join(dataDir, GIT_CREDENTIALS_FILE)).set(remote.host, {
        username: "x-access-token",
        password: TOKEN,
      });
      const pushed = await push();
      expect(pushed.stderr).not.toContain(TOKEN);
      expect(pushed.status).toBe(0);
      expect(
        git(
          ["--git-dir", remote.bare, "rev-parse", "refs/heads/volli-push"],
          serverEnv(),
        ).stdout.trim(),
      ).toBe(head);
      // The token is in no file of the repository's and no remote URL.
      expect(readFileSync(join(work, ".git", "config"), "utf8")).not.toContain(TOKEN);
      expect(readFileSync(join(root, "gitconfig"), "utf8")).toBe("");
    },
  );
});
