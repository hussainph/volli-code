/**
 * Manual host-boundary gate. It deliberately uses the real process-global SRT
 * manager, so it must be run alone on a macOS host rather than in CI.
 *
 *   VOLLI_SRT_INTEGRATION=1 vp test run packages/agent-runtime/src/pi/scoped-execution-env.srt.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ScopedExecutionEnv } from "./scoped-execution-env";

const enabled = process.env.VOLLI_SRT_INTEGRATION === "1";
const credentialName = "VOLLI_SRT_INTEGRATION_CREDENTIAL";
const hookName = "BASH_ENV";

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
        const environment = await env.exec(`test -z \"\${${credentialName}-}\"`);
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
  },
);
