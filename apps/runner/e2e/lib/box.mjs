/**
 * The "fresh box" of the BYO lane (VC-1043): a privileged Docker container
 * booting stock Ubuntu 24.04 with systemd as PID 1 (`../box/Dockerfile`),
 * on the host's network so it reaches the loopback backend, fake GitHub and
 * release server at the same URLs the driver uses. Only the CI lane runs it:
 * it needs Docker, and `--privileged` is acceptable on a disposable runner.
 *
 * Commands run through `docker exec` as root unless `user` is given, with
 * secrets passed by environment rather than argv where the caller can.
 */

import { execFile, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const BOX_CONTEXT = join(dirname(fileURLToPath(import.meta.url)), "..", "box");
export const BOX_IMAGE = "volli-byo-box:e2e";

/** `docker run` arguments for a systemd box (pure, so the flags are tested). */
export function boxRunArgs({ name, image = BOX_IMAGE, hostname = "byo-box-1" }) {
  return [
    "run",
    "--detach",
    "--name",
    name,
    "--hostname",
    hostname,
    // systemd as PID 1 needs a writable cgroup tree (cgroup v2, its own
    // namespace) and tmpfs where it keeps runtime state.
    "--privileged",
    "--cgroupns=private",
    "--tmpfs",
    "/run",
    "--tmpfs",
    "/run/lock",
    "--tmpfs",
    "/tmp:exec",
    "--network",
    "host",
    image,
  ];
}

/** States `is-system-running` reports when the boot itself went wrong. */
const BOOT_FAILED = new Set(["maintenance", "stopping"]);

/** Whether systemd's own state counts as booted: `degraded` is a box with one failed unit, still up. */
export function systemBooted(state) {
  return state === "running" || state === "degraded";
}

async function docker(args, options = {}) {
  return exec("docker", args, { maxBuffer: 64 * 1024 * 1024, ...options });
}

export async function buildBoxImage({ image = BOX_IMAGE, context = BOX_CONTEXT } = {}) {
  await docker(["build", "--tag", image, context], { timeout: 15 * 60_000 });
  return image;
}

/**
 * Run `script` in the box with `sh -c`. Answers `{ code, stdout, stderr }`
 * and never throws on a non-zero exit (callers assert on it). `env` reaches
 * the command through `docker exec -e NAME` with the value in docker's own
 * environment, so a secret never lands in the host's argv.
 */
export function boxRun(name, script, { user, env = {}, input, timeoutMs = 120_000 } = {}) {
  const args = ["exec", "-i"];
  if (user) args.push("--user", user);
  for (const key of Object.keys(env)) args.push("-e", key);
  args.push(name, "sh", "-c", script);
  return new Promise((done, fail) => {
    const child = spawn("docker", args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      done({ code: code ?? (signal ? 128 : 1), signal, stdout, stderr });
    });
    child.stdin.end(input ?? "");
  });
}

/** Boot a fresh box and wait for systemd to finish starting. */
export async function startBox({ name, image = BOX_IMAGE, hostname, bootTimeoutMs = 90_000 }) {
  await docker(["rm", "--force", name]).catch(() => {});
  await docker(boxRunArgs({ name, image, hostname }));
  const box = {
    name,
    run: (script, options) => boxRun(name, script, options),
    async copyIn(source, target) {
      await docker(["cp", source, `${name}:${target}`]);
    },
    /** The last lines of a unit's journal (or the whole boot), for evidence. */
    async journal(unit, lines = 80) {
      const scope = unit ? `-u ${unit}` : "-b";
      return (await boxRun(name, `journalctl --no-pager -n ${lines} ${scope} 2>&1 || true`)).stdout;
    },
    async stop() {
      await docker(["rm", "--force", name]).catch(() => {});
    },
  };
  // PID 1 needs a moment before systemctl can reach it at all; until then
  // `is-system-running` fails at once (no bus), so poll before `--wait`.
  const deadline = Date.now() + bootTimeoutMs;
  let state = "";
  let detail = "";
  while (Date.now() < deadline) {
    const answer = await boxRun(name, "systemctl is-system-running --wait", {
      timeoutMs: Math.max(1_000, deadline - Date.now()),
    }).catch((error) => ({ stdout: "", stderr: String(error) }));
    state = answer.stdout.trim();
    detail = answer.stderr.trim();
    if (systemBooted(state) || BOOT_FAILED.has(state)) break;
    await new Promise((done) => setTimeout(done, 500));
  }
  if (!systemBooted(state)) {
    const failed = (await boxRun(name, "systemctl --failed --no-pager 2>&1 || true")).stdout;
    const logs = await docker(["logs", "--tail", "60", name])
      .then(({ stdout, stderr }) => `${stdout}${stderr}`)
      .catch((error) => String(error));
    await box.stop();
    throw new Error(
      `the box did not boot: systemd is '${state}' (${detail})\n${failed}\n--- container log ---\n${logs}`,
    );
  }
  box.systemState = state;
  return box;
}
