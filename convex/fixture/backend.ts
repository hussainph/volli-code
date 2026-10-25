/**
 * The pinned Convex local backend, as a disposable test fixture.
 *
 * One backend release and one `convex` npm version are pinned together in
 * `backend.json`; nothing here lets the CLI pick a binary. `ensureBackendBinary`
 * downloads the release zip for this platform once, verifies its sha256, and
 * keeps the unpacked binary in a cache OUTSIDE the repository (~174 MB).
 * `startBackend` runs one backend on free loopback ports with a fresh data dir
 * and a random instance secret, and `stop()` kills it and removes that dir.
 *
 * Runs under plain Node (type stripping), under Vitest's globalSetup and from
 * `with-backend.ts`. No Electron.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, createWriteStream, existsSync, openSync, readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type AddressInfo } from "node:net";
import { constants, homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { createRunnerIssuerKeys, type TestIssuer } from "./jwt.ts";

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type BackendPin = {
  release: string;
  convexNpm: string;
  downloadBase: string;
  assets: Record<string, { file: string; sha256: string }>;
};

export function readPin(): BackendPin {
  return JSON.parse(readFileSync(join(PACKAGE_DIR, "fixture/backend.json"), "utf8")) as BackendPin;
}

/** Where unpacked binaries live: never inside the repository. */
export function backendCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env["VOLLI_CONVEX_BACKEND_CACHE"]) return resolve(env["VOLLI_CONVEX_BACKEND_CACHE"]);
  const base = env["XDG_CACHE_HOME"] ? resolve(env["XDG_CACHE_HOME"]) : join(homedir(), ".cache");
  return join(base, "volli", "convex-local-backend");
}

/**
 * The installed `convex` npm package must be the version pinned beside the
 * backend release: the CLI's push and codegen speak to that backend.
 */
export function assertConvexNpmPinned(pin: BackendPin = readPin()): void {
  const require = createRequire(join(PACKAGE_DIR, "package.json"));
  const installed = (require("convex/package.json") as { version: string }).version;
  if (installed !== pin.convexNpm) {
    throw new Error(
      `convex npm ${installed} is installed but fixture/backend.json pins ${pin.convexNpm} ` +
        `beside backend ${pin.release}; bump them together`,
    );
  }
}

/** `code` of a child's exit, or 128 + the signal number, as a shell reports it. */
export function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  return signal ? 128 + (constants.signals[signal] ?? 0) : 1;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function markerMatches(marker: string, sha256: string): Promise<boolean> {
  try {
    return (await readFile(marker, "utf8")).trim() === sha256;
  } catch {
    return false;
  }
}

/** Remove download staging dirs a killed process left behind (an hour is far past any download). */
async function sweepStaleDownloads(root: string): Promise<void> {
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (!name.startsWith(".download-") && !name.startsWith(".replaced-")) continue;
    const path = join(root, name);
    const info = await stat(path).catch(() => undefined);
    if (info && Date.now() - info.mtimeMs > 3_600_000) {
      await rm(path, { recursive: true, force: true });
    }
  }
}

/**
 * The verified binary for this platform, downloading and unpacking it into the
 * cache on first use. A `.verified` marker records the zip digest it came from,
 * so a cache entry from another pin is never reused. Concurrent first runs are
 * safe: an install that already matches is never replaced.
 */
export async function ensureBackendBinary(
  options: { log?: (line: string) => void } = {},
): Promise<string> {
  const pin = readPin();
  const log = options.log ?? (() => {});
  const key = `${process.platform}-${process.arch}`;
  const asset = pin.assets[key];
  if (!asset) {
    throw new Error(
      `no pinned Convex backend for ${key}; fixture/backend.json lists ${Object.keys(pin.assets).join(", ")}`,
    );
  }
  const root = backendCacheRoot();
  const dir = join(root, pin.release, key);
  const binary = join(dir, "convex-local-backend");
  const marker = join(dir, ".verified");
  if (existsSync(binary) && (await markerMatches(marker, asset.sha256))) return binary;

  await mkdir(root, { recursive: true });
  await sweepStaleDownloads(root);
  const staging = await mkdtemp(join(root, `.download-${key}-`));
  try {
    const url = `${pin.downloadBase}/${pin.release}/${asset.file}`;
    log(`downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`download failed: ${response.status} ${response.statusText} for ${url}`);
    }
    const zip = join(staging, asset.file);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(zip));
    const digest = await sha256File(zip);
    if (digest !== asset.sha256) {
      throw new Error(`sha256 mismatch for ${asset.file}: expected ${asset.sha256}, got ${digest}`);
    }
    const unpacked = join(staging, "unpacked");
    const unzip = spawnSync("unzip", ["-q", "-o", zip, "-d", unpacked], { encoding: "utf8" });
    if (unzip.status !== 0) {
      throw new Error(`unzip failed (${unzip.status}): ${unzip.stderr || unzip.error?.message}`);
    }
    const unpackedBinary = join(unpacked, "convex-local-backend");
    if (!existsSync(unpackedBinary)) throw new Error(`${asset.file} holds no convex-local-backend`);
    await chmod(unpackedBinary, 0o755);
    await writeFile(join(unpacked, ".verified"), `${asset.sha256}\n`);

    // Another process may have installed the same pin while this one downloaded.
    if (existsSync(binary) && (await markerMatches(marker, asset.sha256))) return binary;
    await mkdir(dirname(dir), { recursive: true });
    if (existsSync(dir)) {
      // An unverified or partial install: move it aside, never delete in place.
      await rename(dir, join(root, `.replaced-${key}-${randomBytes(4).toString("hex")}`));
    }
    try {
      await rename(unpacked, dir);
    } catch (error) {
      if (!(await markerMatches(marker, asset.sha256))) throw error;
    }
    log(`cached ${binary}`);
    return binary;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** `count` distinct free loopback ports, held open together so none repeats. */
export async function freePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise<ReturnType<typeof createServer>>((resolvePort, reject) => {
          const server = createServer();
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => resolvePort(server));
        }),
    ),
  );
  const ports = servers.map((server) => (server.address() as AddressInfo).port);
  await Promise.all(
    servers.map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
  return ports;
}

export type RunningBackend = {
  /** Client URL (`ConvexClient`, `ConvexHttpClient`, `CONVEX_SELF_HOSTED_URL`). */
  url: string;
  /** HTTP actions URL. */
  siteUrl: string;
  adminKey: string;
  pid: number;
  /** Environment for the `convex` CLI against this backend and nothing else. */
  cliEnv(): NodeJS.ProcessEnv;
  stop(): Promise<void>;
};

const INSTANCE_NAME = "volli-test";

/** Nothing listens on the discard port; the CLI's control-plane calls fail there. */
const DEAD_CONTROL_PLANE = "http://127.0.0.1:9";

/**
 * Environment for the `convex` CLI that can only reach `url`.
 *
 * The CLI reads `.env.local` and `.env` from its working directory and lets a
 * deploy key outrank `CONVEX_SELF_HOSTED_URL`. dotenv never overwrites a
 * variable that is already present, so the cloud pointers are set to EMPTY
 * (an unset one would be refilled from those files), and the control plane is
 * pointed at a dead loopback port. `runConvexCli` also passes `--url` and
 * `--admin-key` where the command accepts them.
 */
export function cliEnvFor(
  url: string,
  adminKey: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    CONVEX_DEPLOYMENT: "",
    CONVEX_DEPLOY_KEY: "",
    CONVEX_DEPLOYMENT_TOKEN: "",
    CONVEX_URL: "",
    CONVEX_PROVISION_HOST: DEAD_CONTROL_PLANE,
    CONVEX_SELF_HOSTED_URL: url,
    CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
  };
}

const DATA_DIR_PREFIX = "volli-convex-";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Clean up after runs that died without `stop()` (SIGKILL, or a signal handler
 * that exits without teardown): each data dir records its owner and backend
 * pids, so a dir whose owner is gone has its backend killed and is removed.
 */
async function sweepOrphans(): Promise<void> {
  for (const name of await readdir(tmpdir()).catch(() => [] as string[])) {
    if (!name.startsWith(DATA_DIR_PREFIX)) continue;
    const dir = join(tmpdir(), name);
    let owner: { ownerPid: number; backendPid: number } | undefined;
    try {
      owner = JSON.parse(await readFile(join(dir, "owner.json"), "utf8")) as typeof owner;
    } catch {
      // Still starting (the owner is written once the backend answers), or
      // abandoned before that: only the latter is old.
      const info = await stat(dir).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > 3_600_000) {
        await rm(dir, { recursive: true, force: true });
      }
      continue;
    }
    if (!owner || isAlive(owner.ownerPid)) continue;
    const command = spawnSync("ps", ["-p", String(owner.backendPid), "-o", "args="], {
      encoding: "utf8",
    }).stdout;
    // `args`, not `comm`: Linux truncates `comm` to 15 characters.
    if (command.includes("convex-local-backend") && command.includes(dir)) {
      process.kill(owner.backendPid, "SIGKILL");
    }
    await rm(dir, { recursive: true, force: true });
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Wait for `/version`; false if the child exited first (a lost port race), throws on timeout. */
async function waitForVersion(
  url: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasExited(child)) return false;
    try {
      const response = await fetch(`${url}/version`, { signal: AbortSignal.timeout(1_000) });
      // Re-check: if another process won the port, it answered, not ours.
      if (response.ok) return !hasExited(child);
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`backend did not answer ${url}/version within ${timeoutMs} ms`);
}

function stopChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (hasExited(child) || child.pid === undefined) return Promise.resolve();
  return new Promise((done) => {
    const kill = setTimeout(() => child.kill("SIGKILL"), graceMs);
    child.once("exit", () => {
      clearTimeout(kill);
      done();
    });
    child.kill("SIGTERM");
  });
}

/**
 * Start one backend on free loopback ports with an empty data dir. The beacon
 * is off and nothing listens beyond 127.0.0.1. A process-exit hook kills it on
 * a normal exit of the caller; a caller killed outright leaves it for the next
 * run's orphan sweep.
 */
export async function startBackend(
  options: { log?: (line: string) => void } = {},
): Promise<RunningBackend> {
  const binary = await ensureBackendBinary(options);
  await sweepOrphans();
  const instanceSecret = randomBytes(32).toString("hex");
  const keygen = spawnSync(
    binary,
    ["keygen", "admin-key", "--instance-name", INSTANCE_NAME, "--instance-secret", instanceSecret],
    { encoding: "utf8" },
  );
  if (keygen.status !== 0) {
    throw new Error(
      `keygen admin-key failed (${keygen.status}): ${keygen.stderr || keygen.error?.message}`,
    );
  }
  const adminKey = keygen.stdout.trim();

  const dataDir = await mkdtemp(join(tmpdir(), DATA_DIR_PREFIX));
  const logPath = join(dataDir, "backend.log");
  const logTail = () => (existsSync(logPath) ? readFileSync(logPath, "utf8").slice(-4_000) : "");
  // A just-freed port can be taken before the backend binds it; retry with new ones.
  for (let attempt = 1; ; attempt += 1) {
    const [port, sitePort] = await freePorts(2);
    const url = `http://127.0.0.1:${port}`;
    const siteUrl = `http://127.0.0.1:${sitePort}`;
    // One descriptor for both streams, so neither can close the log on the other.
    const logFd = openSync(logPath, "a");
    let child: ChildProcess;
    try {
      child = spawn(
        binary,
        [
          "--instance-name",
          INSTANCE_NAME,
          "--instance-secret",
          instanceSecret,
          "--interface",
          "127.0.0.1",
          "--port",
          String(port),
          "--site-proxy-port",
          String(sitePort),
          "--disable-beacon",
          "--local-storage",
          join(dataDir, "storage"),
          join(dataDir, "convex_local_backend.sqlite3"),
        ],
        { cwd: dataDir, stdio: ["ignore", logFd, logFd] },
      );
    } finally {
      closeSync(logFd);
    }
    const spawnFailed = new Promise<never>((_, reject) => child.once("error", reject));
    spawnFailed.catch(() => {});
    const killOnExit = () => child.kill("SIGKILL");
    process.once("exit", killOnExit);
    let ready: boolean;
    try {
      ready = await Promise.race([waitForVersion(url, child, 30_000), spawnFailed]);
    } catch (error) {
      process.off("exit", killOnExit);
      await stopChild(child, 2_000);
      await rm(dataDir, { recursive: true, force: true });
      throw new Error(`${(error as Error).message}\n--- backend.log (tail) ---\n${logTail()}`, {
        cause: error,
      });
    }
    if (!ready) {
      process.off("exit", killOnExit);
      await stopChild(child, 2_000);
      if (attempt < 3) continue;
      const tail = logTail();
      await rm(dataDir, { recursive: true, force: true });
      throw new Error(
        `backend exited during startup three times\n--- backend.log (tail) ---\n${tail}`,
      );
    }
    await writeFile(
      join(dataDir, "owner.json"),
      JSON.stringify({ ownerPid: process.pid, backendPid: child.pid }),
    );
    let stopped: Promise<void> | undefined;
    return {
      url,
      siteUrl,
      adminKey,
      pid: child.pid ?? -1,
      cliEnv: () => cliEnvFor(url, adminKey),
      stop() {
        stopped ??= (async () => {
          await stopChild(child, 5_000);
          process.off("exit", killOnExit);
          if (!process.env["VOLLI_CONVEX_KEEP_DATA"]) {
            await rm(dataDir, { recursive: true, force: true });
          }
        })();
        return stopped;
      },
    };
  }
}

/** Set deployment environment variables through the backend's admin API. */
async function setDeploymentEnv(
  backend: Pick<RunningBackend, "url" | "adminKey">,
  values: Record<string, string>,
): Promise<void> {
  const response = await fetch(`${backend.url}/api/update_environment_variables`, {
    method: "POST",
    headers: { authorization: `Convex ${backend.adminKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      changes: Object.entries(values).map(([name, value]) => ({ name, value })),
    }),
  });
  if (!response.ok) {
    throw new Error(`setting deployment env failed: ${response.status} ${await response.text()}`);
  }
}

/**
 * CLI commands that take `--url`/`--admin-key`. Passing them short-circuits
 * the CLI's own deployment selection, so no env file can redirect the command.
 */
const TARGETED_COMMANDS = new Set(["codegen", "data", "deploy", "env", "export", "import", "run"]);

/** `args` with `--url`/`--admin-key` for `backend` added where the command takes them. */
export function convexCliArgs(
  backend: Pick<RunningBackend, "url" | "adminKey">,
  args: string[],
): string[] {
  const [subcommand, ...rest] = args;
  return subcommand !== undefined && TARGETED_COMMANDS.has(subcommand)
    ? [subcommand, "--url", backend.url, "--admin-key", backend.adminKey, ...rest]
    : args;
}

/**
 * The `convex` CLI from this package's pinned dependency, aimed at `backend`.
 * Killed after `timeoutMs` (default 5 min): some commands retry a socket forever.
 */
export function runConvexCli(
  backend: Pick<RunningBackend, "url" | "adminKey" | "cliEnv">,
  args: string[],
  options: { stdio?: "inherit" | "pipe"; timeoutMs?: number } = {},
): Promise<{ code: number; output: string }> {
  const require = createRequire(join(PACKAGE_DIR, "package.json"));
  const cli = join(dirname(require.resolve("convex/package.json")), "bin/main.js");
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, ...convexCliArgs(backend, args)], {
      cwd: PACKAGE_DIR,
      env: backend.cliEnv(),
      stdio: options.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    const kill = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 300_000);
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.once("error", (error) => {
      clearTimeout(kill);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(kill);
      done({ code: exitStatus(code, signal), output });
    });
  });
}

/** Push `functions/` to `backend`, leaving the committed `_generated/` untouched. */
async function deployFunctions(
  backend: Pick<RunningBackend, "url" | "adminKey" | "cliEnv">,
): Promise<void> {
  const result = await runConvexCli(backend, [
    "deploy",
    "--yes",
    "--typecheck",
    "disable",
    "--codegen",
    "disable",
  ]);
  if (result.code !== 0)
    throw new Error(`convex deploy failed (${result.code}):\n${result.output}`);
}

/**
 * Trust `issuer` on `backend`, give it a fresh runner-token signing key (so
 * `/runner/token` works and its tokens are trusted), push `functions/`, and
 * return the environment `fixture/testing.ts` reads. The JWKS variables are
 * set before the push because the auth config is evaluated at push time.
 * The backend also gets a fresh secrets root key for the run
 * (`functions/lib/sealing.ts`), made here and never written anywhere else.
 */
export async function deployForTests(
  backend: Pick<RunningBackend, "url" | "siteUrl" | "adminKey" | "cliEnv">,
  issuer: TestIssuer,
): Promise<Record<string, string>> {
  const runnerIssuer = createRunnerIssuerKeys();
  await setDeploymentEnv(backend, {
    VOLLI_TEST_JWKS: issuer.jwksDataUri,
    VOLLI_RUNNER_JWKS: runnerIssuer.jwksDataUri,
    VOLLI_RUNNER_SIGNING_KEY: runnerIssuer.signingKey,
    VOLLI_SECRETS_ROOT_KEYS: `test:${randomBytes(32).toString("base64")}`,
  });
  await deployFunctions(backend);
  return {
    VOLLI_CONVEX_URL: backend.url,
    VOLLI_CONVEX_SITE_URL: backend.siteUrl,
    VOLLI_CONVEX_TEST_PRIVATE_KEY: issuer.privateKeyPem,
    // For tests that drive internal functions the way an operator tool does.
    VOLLI_CONVEX_ADMIN_KEY: backend.adminKey,
  };
}
