import { execFile, spawn } from "node:child_process";
import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const TIMEOUT = 10_000;

// Never inherit an agent (including a keychain-backed agent). Keep this env for
// every client spawned by callers, not only for the fixture's own processes.
export function scratchSshEnv() {
  const env = { ...process.env };
  delete env.SSH_AUTH_SOCK;
  delete env.SSH_AGENT_PID;
  return env;
}

function quote(value) {
  if (/[\r\n\0]/u.test(value)) throw new Error("Invalid sshd config value");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function freePort() {
  const server = createServer();
  return new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Loopback port allocation timed out"));
    }, TIMEOUT);
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolvePort(port);
      });
    });
  });
}

/**
 * macOS-only, current-account SSH target. dir must be a fresh, caller-owned
 * 0700 directory. Caller owns removal, after stop(). This is NOT a sandbox:
 * remote commands have the current user's machine-wide authority.
 */
export async function startSshdFixture({ dir, runnerAccountHome = false }) {
  const account = userInfo();
  if (
    runnerAccountHome &&
    (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_OS !== "macOS")
  ) {
    throw new Error("Account-home fixture is disposable macOS CI only");
  }
  if (process.platform !== "darwin" || account.uid === 0) {
    throw new Error("Fixture requires unprivileged macOS");
  }
  if (
    account.shell !== "/bin/zsh" &&
    account.shell !== "/bin/sh" &&
    account.shell !== "/bin/bash"
  ) {
    throw new Error(`Unreviewed login shell: ${account.shell}`);
  }
  dir = resolve(dir);
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.uid !== account.uid || (stat.mode & 0o777) !== 0o700) {
    throw new Error("Fixture dir must be an owned, non-symlink 0700 directory");
  }
  const env = scratchSshEnv();
  const run = (file, args) =>
    exec(file, args, {
      env,
      timeout: TIMEOUT,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    });
  const identityFile = join(dir, "client_ed25519");
  const hostKey = join(dir, "host_ed25519");
  const knownHostsFile = join(dir, "known_hosts");
  const config = join(dir, "sshd_config");
  // Reserve filenames without replacing anything the caller already owned.
  for (const file of [identityFile, hostKey]) {
    await writeFile(file, "", { flag: "wx", mode: 0o600 });
    // ssh-keygen sees a reserved empty file; explicitly approve only this one.
    await writeFile(`${file}.pub`, "", { flag: "wx", mode: 0o600 });
    const generation = exec("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file], {
      env,
      timeout: TIMEOUT,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    });
    generation.child.stdin.end("y\n");
    await generation;
  }
  const port = await freePort();
  if (port <= 1024) throw new Error("Fixture requires a high loopback port");
  const user = account.username;
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(user)) throw new Error("Invalid username");
  const authorizedKeys = join(dir, "authorized_keys");
  await writeFile(authorizedKeys, await readFile(`${identityFile}.pub`), {
    flag: "wx",
    mode: 0o600,
  });
  const hostPublic = (await readFile(`${hostKey}.pub`, "utf8"))
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .join(" ");
  await writeFile(knownHostsFile, `[127.0.0.1]:${port} ${hostPublic}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    config,
    [
      "ListenAddress 127.0.0.1",
      `HostKey ${quote(hostKey)}`,
      `AuthorizedKeysFile ${quote(authorizedKeys)}`,
      `PidFile ${quote(join(dir, "sshd.pid"))}`,
      "UsePAM no",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PubkeyAuthentication yes",
      "AuthenticationMethods publickey",
      "StrictModes yes",
      `AllowUsers ${user}`,
      "PermitRootLogin no",
      "PermitUserEnvironment no",
      "PermitUserRC no",
      "HostbasedAuthentication no",
      "UseDNS no",
      "X11Forwarding no",
      "AllowAgentForwarding no",
      "AllowTcpForwarding local",
      "PermitOpen 127.0.0.1:*",
      "GatewayPorts no",
      "PermitTunnel no",
      "PermitTTY no",
      "LoginGraceTime 10",
      "MaxAuthTries 2",
      "MaxSessions 4",
      "LogLevel VERBOSE",
      "Subsystem sftp /usr/libexec/sftp-server",
      // Avoid the person's shell startup files and HOME-based writes. System
      // shell startup files still apply; this is a fixture, not OS isolation.
      `SetEnv ${quote(`HOME=${runnerAccountHome ? account.homedir : dir}`)} ${quote(`ZDOTDIR=${dir}`)} ${quote("GIT_CONFIG_NOSYSTEM=1")} ${quote(`GIT_CONFIG_GLOBAL=${join(dir, "gitconfig")}`)} ${quote("GIT_TERMINAL_PROMPT=0")}`,
      "",
    ].join("\n"),
    { flag: "wx", mode: 0o600 },
  );
  await chmod(identityFile, 0o600);
  await chmod(hostKey, 0o600);
  await run("/usr/sbin/sshd", ["-t", "-f", config, "-p", String(port)]);

  const child = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config, "-p", String(port)], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let exited = false;
  const closed = new Promise((resolveClose) => {
    child.once("close", () => {
      exited = true;
      resolveClose();
    });
  });
  let stopping;
  const stop = () =>
    (stopping ??= (async () => {
      if (exited) return;
      child.kill("SIGTERM");
      let timer;
      await Promise.race([
        closed,
        new Promise((r) => {
          timer = setTimeout(r, 2000);
        }),
      ]);
      clearTimeout(timer);
      if (!exited) {
        child.kill("SIGKILL");
        await Promise.race([
          closed,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("sshd did not stop")), 2000);
          }),
        ]).finally(() => clearTimeout(timer));
      }
    })());
  try {
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`sshd startup timed out: ${stderr}`)),
        TIMEOUT,
      );
      const finish = (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolveReady();
      };
      child.once("error", finish);
      child.once("close", (code, signal) =>
        finish(new Error(`sshd exited (${code ?? signal}): ${stderr}`)),
      );
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-64 * 1024);
        if (stderr.includes(`Server listening on 127.0.0.1 port ${port}.`)) finish();
      });
    });
    const sshArgs = [
      "-F",
      "/dev/null",
      "-i",
      identityFile,
      ...[
        "IdentitiesOnly=yes",
        "IdentityAgent=none",
        "UseKeychain=no",
        "AddKeysToAgent=no",
        `UserKnownHostsFile=${knownHostsFile}`,
        "GlobalKnownHostsFile=/dev/null",
        "StrictHostKeyChecking=yes",
        "BatchMode=yes",
        "ConnectTimeout=5",
        "ForwardAgent=no",
        "ForwardX11=no",
        "ControlMaster=no",
        "ControlPath=none",
      ].flatMap((option) => ["-o", option]),
      "-T",
      "-p",
      String(port),
      "--",
      `${user}@127.0.0.1`,
    ];
    return { host: "127.0.0.1", port, user, identityFile, knownHostsFile, sshArgs, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
