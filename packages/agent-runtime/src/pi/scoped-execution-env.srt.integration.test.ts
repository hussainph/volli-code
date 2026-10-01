/**
 * Manual host-boundary gate. It deliberately uses the real process-global SRT
 * manager, so it must be run alone on a macOS host rather than in CI.
 *
 *   VOLLI_SRT_INTEGRATION=1 vp test run packages/agent-runtime/src/pi/scoped-execution-env.srt.integration.test.ts
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
  BACKGROUND_CONTEXT,
  executeShellWithCapture,
  type ShellCaptureResult,
} from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { resolveCapabilityPolicy } from "../authority/capability";
import { ScopedExecutionEnv, type ScopedExecutionEnvOptions } from "./scoped-execution-env";

const enabled = process.env.VOLLI_SRT_INTEGRATION === "1";

/**
 * The one unix socket every environment in this process names. SRT reads
 * sockets only from its process-global configuration, which the first
 * environment to prepare installs — so every environment here must ask for the
 * same set, exactly as every Session in the app does.
 */
const SOCKET = join(realpathSync(tmpdir()), `volli-srt-it-${process.pid}.sock`);

/** A unique, recognizable file body: if a wall failed open, this is what would print. */
function canary(name: string): string {
  return `canary-${name}-${randomUUID()}`;
}

/** Whether a write the matrix asked for actually landed. */
function wrote(path: string): boolean {
  try {
    return readFileSync(path, "utf8") === "written";
  } catch {
    return false;
  }
}

/** Put a path back the way the host found it, between one layer's write and the next. */
function restore(path: string, before: string | null): void {
  if (before === null) rmSync(path, { force: true });
  else writeFileSync(path, before);
}

/** The options every environment in this file shares. */
function scoped(extra: Partial<ScopedExecutionEnvOptions> = {}): ScopedExecutionEnvOptions {
  return { sandbox: SandboxManager, unixSockets: [SOCKET], ...extra };
}
const credentialName = "VOLLI_SRT_INTEGRATION_CREDENTIAL";
const hookName = "BASH_ENV";

/** Host-side git, deliberately outside the sandbox this test is about. */
const git = (cwd: string, ...args: string[]) => promisify(execFile)("git", args, { cwd });

/**
 * One contained command, and everything it printed.
 *
 * Pi 0.85's `Shell.exec` returns an exit code and truncation metadata and no
 * text at all, so what this gate needs — "did the secret appear anywhere in the
 * output" — comes from `executeShellWithCapture`, the collector Pi ships for
 * callers that want one bounded string. Stdout and stderr arrive merged, which
 * suits the question exactly: a denial that printed the secret on either stream
 * is the same failure.
 */
async function ran(
  env: ScopedExecutionEnv,
  command: string,
  options?: { timeout?: number },
): Promise<ShellCaptureResult> {
  const result = await executeShellWithCapture(
    env,
    command,
    { ...options, returnExecutionErrors: true },
    BACKGROUND_CONTEXT,
  );
  if (!result.ok) throw result.error;
  return result.value;
}

function expectDenied(result: ShellCaptureResult, secret: string): void {
  expect(result.executionError).toBeUndefined();
  expect(result.exitCode).not.toBe(0);
  expect(result.output).not.toContain(secret);
}

describe.skipIf(!enabled)(
  "ScopedExecutionEnv SRT host integration (VOLLI_SRT_INTEGRATION=1)",
  () => {
    let parent = "";
    let scratchMarkers: string[] = [];
    let originalCredential: string | undefined;
    let originalHook: string | undefined;

    afterEach(async () => {
      if (originalCredential === undefined) delete process.env[credentialName];
      else process.env[credentialName] = originalCredential;
      if (originalHook === undefined) delete process.env[hookName];
      else process.env[hookName] = originalHook;
      await Promise.all(scratchMarkers.map(async (marker) => rm(marker, { force: true })));
      scratchMarkers = [];
      if (parent) await rm(parent, { recursive: true, force: true });
    });

    it("contains a real shell in its Ticket worktree", async () => {
      // This must fail rather than skip when the explicit gate is enabled. The
      // production path itself then proves SRT availability and configuration.
      expect(process.platform).toBe("darwin");
      expect(SandboxManager.isSupportedPlatform()).toBe(true);

      parent = await realpath(await mkdtemp(join(homedir(), ".volli-srt-integration-")));
      const worktree = join(parent, "worktree");
      // Host-private, as Volli's `userData` is: on the secrets denylist.
      const privateRoot = join(parent, "private");
      const outside = join(privateRoot, "outside-secret.txt");
      const hook = join(worktree, "ambient-hook.sh");
      const hookMarker = join(worktree, "ambient-hook-ran.txt");
      const secret = `outside-secret-${randomUUID()}`;
      const credential = `ambient-credential-${randomUUID()}`;
      scratchMarkers = [
        join("/tmp/claude", `volli-srt-denied-${randomUUID()}`),
        join("/private/tmp/claude", `volli-srt-denied-${randomUUID()}`),
      ];
      await mkdir(worktree);
      await mkdir(privateRoot);
      await writeFile(outside, secret);
      await writeFile(hook, "printf hook-ran > ambient-hook-ran.txt\n");
      await symlink("../private/outside-secret.txt", join(worktree, "outside-link"));
      originalCredential = process.env[credentialName];
      originalHook = process.env[hookName];
      process.env[credentialName] = credential;
      process.env[hookName] = hook;

      const env = await ScopedExecutionEnv.create(
        worktree,
        scoped({
          policy: resolveCapabilityPolicy({
            workspacePath: worktree,
            privateRoots: [privateRoot],
            sandboxCarveOuts: true,
          }),
        }),
      );
      try {
        await expect(env.prepareProcessExecution()).resolves.toEqual({
          ok: true,
          value: undefined,
        });

        await expect(ran(env, "pwd")).resolves.toMatchObject({
          output: `${env.cwd}\n`,
          exitCode: 0,
        });
        await expect(
          ran(env, "printf inside > created-by-contained-shell.txt"),
        ).resolves.toMatchObject({ exitCode: 0 });
        await expect(
          readFile(join(worktree, "created-by-contained-shell.txt"), "utf8"),
        ).resolves.toBe("inside");

        // The ambient process is intentionally poisoned. The wrapped child must
        // receive neither credentials nor a non-interactive-shell hook.
        const environment = await ran(env, `test -z "\${${credentialName}-}"`);
        expect(environment).toMatchObject({ exitCode: 0 });
        expect(environment.output).not.toContain(credential);
        expect(existsSync(hookMarker)).toBe(false);

        expectDenied(await ran(env, "/bin/cat ../private/outside-secret.txt"), secret);
        expectDenied(await ran(env, "printf overwrite > ../private/outside-secret.txt"), secret);
        expect(await readFile(outside, "utf8")).toBe(secret);

        expectDenied(await ran(env, "/bin/cat outside-link"), secret);
        expectDenied(await ran(env, "printf overwrite > outside-link"), secret);
        expect(await readFile(outside, "utf8")).toBe(secret);

        // Reads are machine-wide off the denylist (VC-45), writes are not.
        await writeFile(join(parent, "sibling.txt"), "sibling");
        await expect(ran(env, "/bin/cat ../sibling.txt")).resolves.toMatchObject({
          output: "sibling",
          exitCode: 0,
        });
        const traversal = await ran(env, "printf traversal > ../sibling.txt");
        expect(traversal.exitCode).not.toBe(0);
        expect(await readFile(join(parent, "sibling.txt"), "utf8")).toBe("sibling");

        // SRT's default Claude compatibility locations remain denied so an
        // agent cannot escape through its own scratch directories.
        for (const marker of scratchMarkers) {
          const scratchWrite = await ran(env, `printf denied > ${JSON.stringify(marker)}`);
          expect(scratchWrite.exitCode === 0).toBe(false);
          expect(existsSync(marker)).toBe(false);
        }

        let received = false;
        const server = createServer((socket) => {
          received = true;
          socket.destroy();
        });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => resolve());
        });
        try {
          const address = server.address();
          expect(address).not.toBeNull();
          expect(typeof address).toBe("object");
          const port = typeof address === "object" && address ? address.port : 0;
          const network = await ran(env, `printf probe > /dev/tcp/127.0.0.1/${port}`, {
            timeout: 2,
          });
          expect(network.exitCode === 0).toBe(false);
          expect(received).toBe(false);
        } finally {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      } finally {
        await env.cleanup(BACKGROUND_CONTEXT);
      }
    });

    /**
     * A Board Session, because only a Main checkout has this hole. In a Ticket
     * worktree `.git` is a file pointing into the main repository, so the real
     * hooks and config live outside the workspace and `allowWrite` already
     * refuses them; here `.git/` is a real directory inside the writable root.
     *
     * The rule pack cannot close it: `path.git-internals` reads file-tool
     * writes, shell redirects, and `git config`, and a plain `cp` names its
     * destination as an ordinary operand. So the kernel does, and the commit
     * case below is what keeps the fix from being "deny all of `.git`".
     */
    it("refuses a copy into a Main checkout's .git hooks and config, and still lets git commit", async () => {
      expect(process.platform).toBe("darwin");
      expect(SandboxManager.isSupportedPlatform()).toBe(true);

      parent = await realpath(await mkdtemp(join(homedir(), ".volli-srt-integration-")));
      const checkout = join(parent, "main-checkout");
      await mkdir(checkout);
      // Built on the host, as a Main checkout always is: the repository and its
      // committer identity pre-date the Session. Doing it through `env.exec`
      // would fail on this very denial, since `git config` writes `.git/config`.
      await git(checkout, "init", "--quiet");
      await git(checkout, "config", "user.email", "session@volli.test");
      await git(checkout, "config", "user.name", "Volli Session");

      const env = await ScopedExecutionEnv.create(checkout, scoped());
      try {
        await expect(env.prepareProcessExecution()).resolves.toEqual({
          ok: true,
          value: undefined,
        });
        await writeFile(join(checkout, "evil.sh"), "#!/bin/sh\necho pwned\n");
        // A submodule's hooks execute exactly like the superproject's, and live
        // under a path the two literal entries above do not cover.
        await mkdir(join(checkout, ".git", "modules", "sub", "hooks"), { recursive: true });
        for (const destination of [
          ".git/hooks/pre-commit",
          ".git/config",
          ".git/modules/sub/hooks/pre-commit",
          ".git/modules/sub/config",
          ".gitmodules",
          ".volli/state.json",
        ]) {
          const copied = await ran(env, `cp evil.sh ${destination}`);
          expect(copied.exitCode === 0, destination).toBe(false);
          // `.git/config` already exists, so the proof is that it was not
          // overwritten; the hooks must not have been created at all.
          const landed = join(checkout, destination);
          const contents = existsSync(landed) ? await readFile(landed, "utf8") : "";
          expect(contents, destination).not.toContain("pwned");
        }

        // The denial is four patterns, not the repository: committing writes the
        // index, refs, and objects, and a Session that cannot do that is broken.
        await expect(
          ran(env, "git add evil.sh && git commit --quiet -m contained"),
        ).resolves.toMatchObject({ exitCode: 0 });
      } finally {
        await env.cleanup(BACKGROUND_CONTEXT);
      }
    });

    it("keeps two Session workspaces apart in one process", async () => {
      // The process-global SRT configuration carries no workspace paths at all;
      // each root travels per command. That was invisible while every Session
      // was a Ticket worktree under the same parent, but a Board Session is
      // rooted at the Main checkout, so two live roots of different kinds is
      // now an ordinary state and nothing else proves it holds. The preflight
      // is cached per manager, so whichever env prepares first is the one that
      // installed the shared boundary — and it must still not decide which root
      // a later command gets.
      expect(process.platform).toBe("darwin");
      expect(SandboxManager.isSupportedPlatform()).toBe(true);

      parent = await realpath(await mkdtemp(join(homedir(), ".volli-srt-integration-")));
      const secretA = `root-a-secret-${randomUUID()}`;
      const secretB = `root-b-secret-${randomUUID()}`;
      await mkdir(join(parent, "root-a"));
      await mkdir(join(parent, "root-b"));

      const envA = await ScopedExecutionEnv.create(join(parent, "root-a"), scoped());
      const envB = await ScopedExecutionEnv.create(join(parent, "root-b"), scoped());
      const fileInA = join(envA.cwd, "secret.txt");
      const fileInB = join(envB.cwd, "secret.txt");
      await writeFile(fileInA, secretA);
      await writeFile(fileInB, secretB);

      try {
        // A prepares the shared boundary; B never does before it runs.
        await expect(envA.prepareProcessExecution()).resolves.toEqual({
          ok: true,
          value: undefined,
        });

        // Reads are machine-wide off the denylist (VC-45), so B may read A's
        // tree — a sibling repository is exactly the read the plan opened —
        // and may not write it.
        expectDenied(await ran(envB, `printf overwrite > ${JSON.stringify(fileInA)}`), secretA);
        await expect(ran(envB, "pwd")).resolves.toMatchObject({
          output: `${envB.cwd}\n`,
          exitCode: 0,
        });
        expect(await readFile(fileInA, "utf8")).toBe(secretA);

        // The same in the other direction, including for the env that installed
        // the boundary: preparing it buys no write into a root it does not own.
        expectDenied(await ran(envA, `printf overwrite > ${JSON.stringify(fileInB)}`), secretB);
        await expect(ran(envA, "pwd")).resolves.toMatchObject({
          output: `${envA.cwd}\n`,
          exitCode: 0,
        });
        expect(await readFile(fileInB, "utf8")).toBe(secretB);

        // Each still owns its own root, so the denial above is containment and
        // not a boundary that simply refuses everything.
        await expect(ran(envA, "/bin/cat secret.txt")).resolves.toMatchObject({
          output: secretA,
          exitCode: 0,
        });
        await expect(ran(envB, "/bin/cat secret.txt")).resolves.toMatchObject({
          output: secretB,
          exitCode: 0,
        });
      } finally {
        await envA.cleanup(BACKGROUND_CONTEXT);
        await envB.cleanup(BACKGROUND_CONTEXT);
      }
    });
    /**
     * The acceptance for VC-45 slices 1 and 2, at the kernel: one path, one
     * answer, whichever tool asks. Every row is asked of the shell under
     * Seatbelt AND of the file tools under the guard, and the two must agree
     * with each other and with the policy's own verdict.
     *
     * The layout is Volli's own in miniature: a `userData` holding the database,
     * `mcp-credentials.json`, and two Sessions' saved tool output, of which this
     * Session may read only its own. A fake home stands in for the real one, so
     * no row ever names a real credential — if the walls failed open, what
     * would print is a canary.
     */
    it("gives the shell and the file tools the same verdict for every path (VC-45)", async () => {
      expect(process.platform).toBe("darwin");
      parent = await realpath(await mkdtemp(join(homedir(), ".volli-srt-integration-")));
      const home = join(parent, "home");
      const userData = join(parent, "userData");
      const sessions = join(userData, "pi-sessions", "--ws--");
      const own = join(sessions, "own.tool-output");
      const other = join(sessions, "other.tool-output");
      const worktree = join(parent, "worktree");
      const sibling = join(parent, "sibling");
      const declared = join(parent, "declared");
      const scratchDir = join(parent, "scratch");
      for (const directory of [
        join(home, ".ssh"),
        own,
        other,
        join(worktree, ".git", "hooks"),
        sibling,
        declared,
        scratchDir,
      ]) {
        await mkdir(directory, { recursive: true });
      }
      const files = {
        key: [join(home, ".ssh", "id_ed25519"), canary("key")],
        rc: [join(home, ".zshrc"), canary("rc")],
        db: [join(userData, "volli.db"), canary("db")],
        credentials: [join(userData, "mcp-credentials.json"), canary("credentials")],
        otherOutput: [join(other, "tc-1.txt"), canary("other")],
        ownOutput: [join(own, "tc-1.txt"), canary("own")],
        siblingFile: [join(sibling, "README.md"), canary("sibling")],
        workspaceFile: [join(worktree, "README.md"), canary("workspace")],
      } as const;
      for (const [path, content] of Object.values(files)) await writeFile(path, content);

      const policy = resolveCapabilityPolicy({
        workspacePath: worktree,
        home,
        writableRoots: [declared],
        runtimeRoots: [scratchDir],
        privateRoots: [userData],
        grants: [own],
        sandboxCarveOuts: true,
      });
      const env = await ScopedExecutionEnv.create(
        worktree,
        scoped({ policy, homeDir: home, scratchDirectory: scratchDir, gitIdentity: null }),
      );
      try {
        const reads: [keyof typeof files, "allow" | "deny"][] = [
          ["key", "deny"],
          ["rc", "deny"],
          ["db", "deny"],
          ["credentials", "deny"],
          ["otherOutput", "deny"],
          ["ownOutput", "allow"],
          ["siblingFile", "allow"],
          ["workspaceFile", "allow"],
        ];
        for (const [name, expected] of reads) {
          const [path, content] = files[name];
          const shell = await ran(env, `/bin/cat ${JSON.stringify(path)}`);
          const shellVerdict = shell.exitCode === 0 ? "allow" : "deny";
          const tool = await env.readTextFile(path);
          const toolVerdict = tool.ok ? "allow" : "deny";
          expect({ name, shell: shellVerdict, tool: toolVerdict }).toEqual({
            name,
            shell: expected,
            tool: expected,
          });
          if (expected === "deny") expect(shell.output, name).not.toContain(content);
          else expect(shell.output, name).toBe(content);
        }

        const writes: [string, "allow" | "deny"][] = [
          [join(worktree, "new.txt"), "allow"],
          [join(declared, "new.txt"), "allow"],
          [join(scratchDir, "new.txt"), "allow"],
          [join(worktree, ".volli", "state.json"), "deny"],
          [join(worktree, ".git", "hooks", "pre-commit"), "deny"],
          [join(worktree, ".gitmodules"), "deny"],
          [join(worktree, ".vscode", "tasks.json"), "deny"],
          [join(sibling, "new.txt"), "deny"],
          [join(userData, "new.txt"), "deny"],
          [join(own, "new.txt"), "deny"],
          [join(home, ".zshrc"), "deny"],
        ];
        // Each layer writes the exact path in turn, and the host puts the
        // file back between them, so neither verdict leans on the other's.
        for (const [path, expected] of writes) {
          const before = existsSync(path) ? readFileSync(path, "utf8") : null;
          await ran(
            env,
            `/bin/mkdir -p ${JSON.stringify(join(path, ".."))} 2>/dev/null; printf written > ${JSON.stringify(path)}`,
          );
          const shellVerdict = wrote(path) ? "allow" : "deny";
          restore(path, before);
          await env.writeFile(path, "written");
          const toolVerdict = wrote(path) ? "allow" : "deny";
          restore(path, before);
          expect({ path, shell: shellVerdict, tool: toolVerdict }).toEqual({
            path,
            shell: expected,
            tool: expected,
          });
        }
        // The rc file the denied writes aimed at is untouched.
        expect(await readFile(files.rc[0], "utf8")).toBe(files.rc[1]);
      } finally {
        await env.cleanup(BACKGROUND_CONTEXT);
      }
    });

    /**
     * A Ticket worktree commits into the main repository's `.git`, which is
     * outside the workspace — the old boundary's quiet breakage. It is a
     * writable root now, with its hooks and config carved out like every root's.
     */
    it("lets a Ticket worktree commit, and keeps its main repository's hooks out of reach", async () => {
      expect(process.platform).toBe("darwin");
      parent = await realpath(await mkdtemp(join(homedir(), ".volli-srt-integration-")));
      const main = join(parent, "main");
      await mkdir(main);
      await git(main, "init", "--quiet");
      await git(
        main,
        "-c",
        "user.name=h",
        "-c",
        "user.email=h@h",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "init",
      );
      const worktree = join(parent, "wt");
      await git(main, "worktree", "add", "--quiet", worktree);

      const env = await ScopedExecutionEnv.create(
        worktree,
        scoped({
          policy: resolveCapabilityPolicy({ workspacePath: worktree, sandboxCarveOuts: true }),
          gitIdentity: { name: "Volli Session", email: "session@volli.test" },
        }),
      );
      try {
        await writeFile(join(worktree, "a.txt"), "a");
        await expect(
          ran(env, "git add a.txt && git commit --quiet -m contained && git log -1 --format=%an"),
        ).resolves.toMatchObject({ output: "Volli Session\n", exitCode: 0 });
        const hook = await ran(
          env,
          `printf pwned > ${JSON.stringify(join(main, ".git", "hooks", "post-checkout"))}`,
        );
        expect(hook.exitCode).not.toBe(0);
        expect(existsSync(join(main, ".git", "hooks", "post-checkout"))).toBe(false);
        // The main checkout's own files are not a root.
        const tree = await ran(env, `printf x > ${JSON.stringify(join(main, "x.txt"))}`);
        expect(tree.exitCode).not.toBe(0);
      } finally {
        await env.cleanup(BACKGROUND_CONTEXT);
      }
    });

    it("reaches the volli socket inside a denied directory", async () => {
      expect(process.platform).toBe("darwin");
      parent = await realpath(await mkdtemp(join(homedir(), ".volli-srt-integration-")));
      const worktree = join(parent, "wt");
      await mkdir(worktree);
      let received = "";
      const server = createServer((socket) => {
        socket.on("data", (data) => {
          received += String(data);
          socket.end();
        });
      });
      await rm(SOCKET, { force: true });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(SOCKET, () => resolve());
      });
      const env = await ScopedExecutionEnv.create(
        worktree,
        scoped({
          policy: resolveCapabilityPolicy({
            workspacePath: worktree,
            privateRoots: [tmpdir()],
            sandboxCarveOuts: true,
          }),
          gitIdentity: null,
        }),
      );
      try {
        await ran(env, `printf hello | /usr/bin/nc -U ${JSON.stringify(SOCKET)}`, { timeout: 5 });
        expect(received).toBe("hello");
      } finally {
        await env.cleanup(BACKGROUND_CONTEXT);
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(SOCKET, { force: true });
      }
    });
  },
);
