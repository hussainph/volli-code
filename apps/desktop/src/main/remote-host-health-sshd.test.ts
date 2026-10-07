// @vitest-environment node
/**
 * VC-719: a real VC-703 localhost sshd, production ssh -L + systemSsh, and
 * actual hostd composition/status. TCP acceptance is NOT host health.
 * macOS/unprivileged only. Nothing reads the person's SSH keys or agent.
 * The support process avoids macOS's short absolute Unix-socket limit; it
 * runs startHostd directly, not install/start units or Electron's entrypoint.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createHostLink } from "@volli/host-protocol/client-link";
import {
  createRemoteHosts,
  createSshTunnel,
  exitsWithin,
  freeLoopbackPort,
  shellQuote,
  systemSsh,
  type RegistryFile,
  type RemoteHosts,
  type RemoteHostsWakeCause,
  type SpawnProcess,
  type SshTunnel,
} from "@volli/host-install";
import { expect, it, vi } from "vite-plus/test";

import { scratchSshEnv, startSshdFixture } from "../../e2e/volli-drive/lib/sshd-fixture.mjs";

const exec = promisify(execFile);
const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const hostdPackage = join(repository, "apps/hostd");
const supportSource = fileURLToPath(
  new URL("./remote-host-health-sshd.test-support.ts", import.meta.url),
);
const version = "0.2.1";

async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
  ms = 5_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`${label} did not settle within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it.skipIf(process.platform !== "darwin" || userInfo().uid === 0)(
  "a no-project host behind live SSH is unreachable when hostd stops; Retry and wake recover within 5 s",
  async () => {
    const scratch = join(repository, ".scratch");
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(join(scratch, "vc719-host-health-"));
    const sshHome = join(root, "ssh-home");
    const dataDir = join(root, "data");
    const bundleDir = join(root, "bundle");
    let fixture: Awaited<ReturnType<typeof startSshdFixture>> | undefined;
    let engine: RemoteHosts | undefined;
    let hostd: ChildProcess | undefined;
    const children = new Set<ChildProcess>();
    const tunnels: SshTunnel[] = [];
    let hostdLog = "";
    const own = (child: ChildProcess): ChildProcess => {
      children.add(child);
      child.once("exit", () => children.delete(child));
      child.once("error", () => children.delete(child));
      return child;
    };
    const stopHostd = async (): Promise<void> => {
      if (!hostd) return;
      const child = hostd;
      child.kill("SIGTERM");
      await exitsWithin([child], 5_000);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exitsWithin([child], 1_000);
        throw new Error(`Hostd did not stop cleanly: ${hostdLog}`);
      }
      expect(child.exitCode, hostdLog).toBe(0);
      hostd = undefined;
    };
    try {
      await mkdir(sshHome, { mode: 0o700 });
      await mkdir(dataDir, { mode: 0o700 });
      // One bounded build, with the hostd package's production bundling rules.
      // Native modules remain external, reached only through this scratch link.
      await exec(
        "pnpm",
        [
          "exec",
          "vp",
          "pack",
          supportSource,
          "--out-dir",
          bundleDir,
          "--concurrency",
          process.env.VOLLI_CONCURRENCY_HINT ?? "1",
        ],
        {
          cwd: hostdPackage,
          timeout: 30_000,
          killSignal: "SIGKILL",
          maxBuffer: 256 * 1024,
        },
      );
      await symlink(join(hostdPackage, "node_modules"), join(bundleDir, "node_modules"), "dir");
      const support = join(bundleDir, "remote-host-health-sshd.test-support.cjs");
      const remotePort = await freeLoopbackPort();
      // Allowlist, rather than inheriting provider tokens, SSH agents or Git helpers.
      const env: NodeJS.ProcessEnv = {
        PATH: scratchSshEnv().PATH,
        HOME: sshHome,
        ZDOTDIR: sshHome,
        XDG_CONFIG_HOME: join(sshHome, ".config"),
        XDG_DATA_HOME: join(sshHome, ".local/share"),
        TMPDIR: root,
        VOLLI_EXPERIMENTAL: "cloud",
        VOLLI_WORKTREE_HOME_DIR: sshHome,
        VOLLI_SECRET_KEY_FILE: join(dataDir, "secret.key"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      };
      const startHost = async (): Promise<{ hostId: string; version: string }> => {
        hostdLog = "";
        hostd = own(
          spawn(process.execPath, [support, "serve", dataDir, version, String(remotePort)], {
            cwd: root,
            env,
            stdio: ["ignore", "pipe", "pipe"],
          }),
        );
        for (const stream of [hostd.stdout!, hostd.stderr!]) {
          stream.setEncoding("utf8").on("data", (chunk: string) => {
            hostdLog = (hostdLog + chunk).slice(-64 * 1024);
          });
        }
        let status: {
          state?: string;
          pid?: number;
          hostId?: string;
          version?: string;
          hostProtocol?: { port: number };
        } = {};
        // Only startup reads are polled; engine health remains trigger-driven.
        // Match the child pid so a previous launch's status cannot satisfy boot.
        await until(
          async () => {
            if (hostd!.exitCode !== null || hostd!.signalCode !== null) {
              throw new Error(`Hostd exited before serving: ${hostdLog}`);
            }
            try {
              status = JSON.parse(await readFile(join(dataDir, "hostd-status.json"), "utf8"));
            } catch {
              return false;
            }
            return (
              status.state === "serving" &&
              status.pid === hostd!.pid &&
              status.hostProtocol?.port === remotePort &&
              hostdLog.includes('"projects":0')
            );
          },
          "hostd boot",
          10_000,
        );
        expect(status.hostId).toMatch(/^[0-9a-f-]{36}$/u);
        return { hostId: status.hostId!, version: status.version! };
      };
      const identity = await startHost();
      await stopHostd();
      fixture = await startSshdFixture({ dir: sshHome });
      const target = `${fixture.user}@127.0.0.1:${fixture.port}`;
      const prefix = [
        "-F",
        "/dev/null",
        "-i",
        fixture.identityFile,
        ...[
          "IdentitiesOnly=yes",
          "IdentityAgent=none",
          "UseKeychain=no",
          "AddKeysToAgent=no",
          `UserKnownHostsFile=${fixture.knownHostsFile}`,
          "GlobalKnownHostsFile=/dev/null",
          "ControlMaster=no",
          "ControlPath=none",
        ].flatMap((option) => ["-o", option]),
      ];
      const isolatedSpawn: SpawnProcess = (_command, args) =>
        own(
          spawn("/usr/bin/ssh", [...prefix, ...args], {
            cwd: root,
            env,
            stdio: ["pipe", "pipe", "pipe"],
          }),
        );
      // The engine still discovers the normal user-installed binary in HOME.
      // This wrapper accepts ONLY its status invocation and executes the real
      // managedStatus/checkStatus against scratch data, never launchctl.
      const binaryDir = join(sshHome, ".local/share/volli-hostd/current/bin");
      await mkdir(binaryDir, { recursive: true });
      const statusArgs = [
        process.execPath,
        support,
        "status",
        dataDir,
        version,
        String(remotePort),
      ];
      const exportedEnv = Object.entries(env)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([key, value]) => shellQuote(`${key}=${value}`));
      await writeFile(
        join(binaryDir, "volli-hostd"),
        [
          "#!/bin/sh",
          '[ "$#" = 3 ] && [ "$1" = status ] && [ "$2" = --json ] && [ "$3" = --user ] || exit 64',
          `cd ${shellQuote(root)} || exit 64`,
          `exec /usr/bin/env -i ${exportedEnv.join(" ")} ${statusArgs.map(shellQuote).join(" ")}`,
          "",
        ].join("\n"),
        { mode: 0o700, flag: "wx" },
      );
      let registry: RegistryFile = {
        v: 1,
        hosts: [
          {
            id: identity.hostId,
            name: "Scratch host",
            target,
            os: "macos",
            mode: "user",
            version: identity.version,
            deviceId: randomUUID(),
            addedAt: new Date().toISOString(),
            listen: { host: "127.0.0.1", port: remotePort },
            workspaceIds: [],
            system: "macOS",
            arch: process.arch,
            hostKeys: [],
          },
        ],
      };
      const logger = { debug() {}, info() {}, warn() {}, error() {} };
      const link = vi.fn(createHostLink);
      let wake: ((cause: RemoteHostsWakeCause) => void) | undefined;
      const statusResults: { code: number; stdout: string }[] = [];
      engine = createRemoteHosts({
        store: {
          load: () => registry,
          save: (file) => {
            registry = file;
          },
        },
        deviceKeys: { get: async () => null, put: async () => {}, remove: async () => {} },
        ssh: (sshTarget) => {
          const transport = systemSsh({
            target: sshTarget,
            logger,
            spawn: isolatedSpawn,
            controlDir: join(root, "control"),
          });
          return {
            ...transport,
            async exec(script, options) {
              const result = await transport.exec(script, options);
              if (options?.label === "host-status") statusResults.push(result);
              return result;
            },
          };
        },
        hostKeys: () => {
          throw new Error("No key acceptance in a restored-host health test");
        },
        artifact: async () => {
          throw new Error("No install in a restored-host health test");
        },
        supportedTargets: ["darwin-arm64", "darwin-x64"],
        appVersion: version,
        deviceName: "Scratch client",
        tunnel: (options) => {
          const tunnel = createSshTunnel({ ...options, spawn: isolatedSpawn });
          tunnels.push(tunnel);
          return tunnel;
        },
        link,
        wake: (listener) => {
          wake = listener;
          return () => {
            wake = undefined;
          };
        },
        now: Date.now,
        newId: randomUUID,
        logger,
        enabled: () => true,
      });
      expect(engine.snapshot().hosts).toHaveLength(1);
      const host = () => engine!.snapshot().hosts[0]!;
      const downAt = Date.now();
      await until(() => host().reachability?.state.status === "unreachable", "hostd-down health");
      const downMs = Date.now() - downAt;
      expect(downMs).toBeLessThan(5_000);
      expect(tunnels[0]!.state.status).toBe("up");
      expect(statusResults.at(-1)).toMatchObject({ code: 3 });
      expect(JSON.parse(statusResults.at(-1)!.stdout)).toMatchObject({ verdict: "not-serving" });
      expect(host()).toMatchObject({
        lastWelcome: null,
        reachability: {
          everReady: false,
          state: { status: "unreachable", error: { reason: "hostd-not-serving" } },
        },
      });
      expect(engine.snapshot().projects).toEqual({});
      expect(link).not.toHaveBeenCalled();

      await startHost();
      const retryAt = Date.now();
      engine.retry(identity.hostId);
      await until(() => host().reachability?.state.status === "ready", "Retry recovery");
      const retryMs = Date.now() - retryAt;
      expect(retryMs).toBeLessThan(5_000);
      expect(JSON.parse(statusResults.at(-1)!.stdout)).toMatchObject({
        verdict: "serving",
        running: { state: "serving", hostId: identity.hostId, version: identity.version },
      });
      expect(host().lastWelcome).toBeNull();

      await stopHostd();
      wake!("power-resume");
      await until(
        () => host().reachability?.state.status === "unreachable",
        "wake observes hostd-down",
      );
      expect(tunnels[0]!.state.status).toBe("up");
      expect(host().reachability?.state).toMatchObject({ error: { reason: "hostd-not-serving" } });
      await startHost();
      const wakeAt = Date.now();
      wake!("network-online");
      await until(() => host().reachability?.state.status === "ready", "wake recovery");
      const wakeMs = Date.now() - wakeAt;
      expect(wakeMs).toBeLessThan(5_000);
      expect(host().lastWelcome).toBeNull();
      expect(engine.snapshot().projects).toEqual({});
      expect(link).not.toHaveBeenCalled();
      await engine.close();
      expect(wake).toBeUndefined();
      await stopHostd();
      await until(() => children.size === 0, "SSH children reaped");
      console.info(
        `VC-719 real SSH/hostd: down=${downMs} ms, Retry=${retryMs} ms, wake=${wakeMs} ms; no projects or welcomes; children reaped`,
      );
    } finally {
      try {
        await engine?.close();
      } finally {
        for (const tunnel of tunnels) {
          tunnel.close();
          await tunnel.kill?.();
        }
        for (const child of children) child.kill("SIGTERM");
        await exitsWithin(children, 2_000);
        for (const child of children) child.kill("SIGKILL");
        await exitsWithin(children, 1_000);
        try {
          await fixture?.stop();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  },
  80_000,
);
