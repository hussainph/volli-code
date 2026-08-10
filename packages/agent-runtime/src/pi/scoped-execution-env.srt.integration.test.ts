/**
 * Manual host-boundary gate. It deliberately uses the real process-global SRT
 * manager, so it must be run alone on a macOS host rather than in CI.
 *
 *   VOLLI_SRT_INTEGRATION=1 vp test run packages/agent-runtime/src/pi/scoped-execution-env.srt.integration.test.ts
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ScopedExecutionEnv } from "./scoped-execution-env";

const enabled = process.env.VOLLI_SRT_INTEGRATION === "1";
const credentialName = "VOLLI_SRT_INTEGRATION_CREDENTIAL";
const hookName = "BASH_ENV";

/** Host-side git, deliberately outside the sandbox this test is about. */
const git = (cwd: string, ...args: string[]) => promisify(execFile)("git", args, { cwd });

function outputOf(result: Awaited<ReturnType<ScopedExecutionEnv["exec"]>>): string {
  return result.ok ? `${result.value.stdout}\n${result.value.stderr}` : result.error.message;
}

function expectDenied(
  result: Awaited<ReturnType<ScopedExecutionEnv["exec"]>>,
  secret: string,
): void {
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.exitCode).not.toBe(0);
  expect(outputOf(result)).not.toContain(secret);
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

      parent = await mkdtemp(join(homedir(), ".volli-srt-integration-"));
      const worktree = join(parent, "worktree");
      const outside = join(parent, "outside-secret.txt");
      const hook = join(worktree, "ambient-hook.sh");
      const hookMarker = join(worktree, "ambient-hook-ran.txt");
      const secret = `outside-secret-${randomUUID()}`;
      const credential = `ambient-credential-${randomUUID()}`;
      scratchMarkers = [
        join("/tmp/claude", `volli-srt-denied-${randomUUID()}`),
        join("/private/tmp/claude", `volli-srt-denied-${randomUUID()}`),
      ];
      await mkdir(worktree);
      await writeFile(outside, secret);
      await writeFile(hook, "printf hook-ran > ambient-hook-ran.txt\n");
      await symlink("../outside-secret.txt", join(worktree, "outside-link"));
      originalCredential = process.env[credentialName];
      originalHook = process.env[hookName];
      process.env[credentialName] = credential;
      process.env[hookName] = hook;

      const env = await ScopedExecutionEnv.create(worktree, { sandbox: SandboxManager });
      try {
        await expect(env.prepareProcessExecution()).resolves.toEqual({
          ok: true,
          value: undefined,
        });

        const pwd = await env.exec("pwd");
        expect(pwd).toEqual({
          ok: true,
          value: expect.objectContaining({ stdout: `${env.cwd}\n`, exitCode: 0 }),
        });
        await expect(
          env.exec("printf inside > created-by-contained-shell.txt"),
        ).resolves.toMatchObject({
          ok: true,
          value: { exitCode: 0 },
        });
        await expect(
          readFile(join(worktree, "created-by-contained-shell.txt"), "utf8"),
        ).resolves.toBe("inside");

        // The ambient process is intentionally poisoned. The wrapped child must
        // receive neither credentials nor a non-interactive-shell hook.
        const environment = await env.exec(`test -z "\${${credentialName}-}"`);
        expect(environment).toMatchObject({ ok: true, value: { exitCode: 0 } });
        expect(outputOf(environment)).not.toContain(credential);
        expect(existsSync(hookMarker)).toBe(false);

        expectDenied(await env.exec("/bin/cat ../outside-secret.txt"), secret);
        expectDenied(await env.exec("printf overwrite > ../outside-secret.txt"), secret);
        expect(await readFile(outside, "utf8")).toBe(secret);

        expectDenied(await env.exec("/bin/cat outside-link"), secret);
        expectDenied(await env.exec("printf overwrite > outside-link"), secret);
        expect(await readFile(outside, "utf8")).toBe(secret);

        // `..` is an independent shell capability check, not merely the
        // TypeScript file-API guard that rejects parent-relative paths.
        expectDenied(await env.exec("/bin/cat ../outside-secret.txt"), secret);
        expectDenied(await env.exec("printf traversal > ../outside-secret.txt"), secret);
        expect(await readFile(outside, "utf8")).toBe(secret);

        // SRT's default Claude compatibility locations remain denied so an
        // agent cannot escape through its own scratch directories.
        for (const marker of scratchMarkers) {
          const scratchWrite = await env.exec(`printf denied > ${JSON.stringify(marker)}`);
          expect(scratchWrite.ok && scratchWrite.value.exitCode === 0).toBe(false);
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
          const network = await env.exec(`printf probe > /dev/tcp/127.0.0.1/${port}`, {
            timeout: 2,
          });
          expect(network.ok && network.value.exitCode === 0).toBe(false);
          expect(received).toBe(false);
        } finally {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      } finally {
        await env.cleanup();
      }
    });

    /**
     * A project Session, because only a Main checkout has this hole. In a Ticket
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

      parent = await mkdtemp(join(homedir(), ".volli-srt-integration-"));
      const checkout = join(parent, "main-checkout");
      await mkdir(checkout);
      // Built on the host, as a Main checkout always is: the repository and its
      // committer identity pre-date the Session. Doing it through `env.exec`
      // would fail on this very denial, since `git config` writes `.git/config`.
      await git(checkout, "init", "--quiet");
      await git(checkout, "config", "user.email", "session@volli.test");
      await git(checkout, "config", "user.name", "Volli Session");

      const env = await ScopedExecutionEnv.create(checkout, { sandbox: SandboxManager });
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
        ]) {
          const copied = await env.exec(`cp evil.sh ${destination}`);
          expect(copied.ok && copied.value.exitCode === 0, destination).toBe(false);
          // `.git/config` already exists, so the proof is that it was not
          // overwritten; the hooks must not have been created at all.
          const landed = join(checkout, destination);
          const contents = existsSync(landed) ? await readFile(landed, "utf8") : "";
          expect(contents, destination).not.toContain("pwned");
        }

        // The denial is four patterns, not the repository: committing writes the
        // index, refs, and objects, and a Session that cannot do that is broken.
        await expect(
          env.exec("git add evil.sh && git commit --quiet -m contained"),
        ).resolves.toMatchObject({ ok: true, value: { exitCode: 0 } });
      } finally {
        await env.cleanup();
      }
    });

    it("keeps two Session workspaces apart in one process", async () => {
      // The process-global SRT configuration carries no workspace paths at all;
      // each root travels per command. That was invisible while every Session
      // was a Ticket worktree under the same parent, but a project Session is
      // rooted at the Main checkout, so two live roots of different kinds is
      // now an ordinary state and nothing else proves it holds. The preflight
      // is cached per manager, so whichever env prepares first is the one that
      // installed the shared boundary — and it must still not decide which root
      // a later command gets.
      expect(process.platform).toBe("darwin");
      expect(SandboxManager.isSupportedPlatform()).toBe(true);

      parent = await mkdtemp(join(homedir(), ".volli-srt-integration-"));
      const secretA = `root-a-secret-${randomUUID()}`;
      const secretB = `root-b-secret-${randomUUID()}`;
      await mkdir(join(parent, "root-a"));
      await mkdir(join(parent, "root-b"));

      const envA = await ScopedExecutionEnv.create(join(parent, "root-a"), {
        sandbox: SandboxManager,
      });
      const envB = await ScopedExecutionEnv.create(join(parent, "root-b"), {
        sandbox: SandboxManager,
      });
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

        expectDenied(await envB.exec(`/bin/cat ${JSON.stringify(fileInA)}`), secretA);
        await expect(envB.exec("pwd")).resolves.toEqual({
          ok: true,
          value: expect.objectContaining({ stdout: `${envB.cwd}\n`, exitCode: 0 }),
        });
        expect(await readFile(fileInA, "utf8")).toBe(secretA);

        // The same in the other direction, including for the env that installed
        // the boundary: preparing it buys no reach into a root it does not own.
        expectDenied(await envA.exec(`/bin/cat ${JSON.stringify(fileInB)}`), secretB);
        await expect(envA.exec("pwd")).resolves.toEqual({
          ok: true,
          value: expect.objectContaining({ stdout: `${envA.cwd}\n`, exitCode: 0 }),
        });
        expect(await readFile(fileInB, "utf8")).toBe(secretB);

        // Each still owns its own root, so the denial above is containment and
        // not a boundary that simply refuses everything.
        await expect(envA.exec("/bin/cat secret.txt")).resolves.toMatchObject({
          ok: true,
          value: { stdout: secretA, exitCode: 0 },
        });
        await expect(envB.exec("/bin/cat secret.txt")).resolves.toMatchObject({
          ok: true,
          value: { stdout: secretB, exitCode: 0 },
        });
      } finally {
        await envA.cleanup();
        await envB.cleanup();
      }
    });
  },
);
