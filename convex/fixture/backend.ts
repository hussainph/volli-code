/**
 * The pinned Convex local backend, as a disposable test fixture.
 *
 * One backend release and one `convex` npm version are pinned together in
 * `backend.json`; nothing here lets the CLI pick a binary. `ensureBackendBinary`
 * downloads the release zip for this platform once, verifies its sha256, and
 * keeps the unpacked binary in a cache OUTSIDE the repository (it is ~190 MB).
 * `startBackend` runs one backend on free loopback ports with a fresh data dir
 * and a random instance secret, and `stop()` kills it and removes that dir.
 *
 * Runs under plain Node (type stripping), under Vitest's globalSetup and from
 * `with-backend.ts`. No Electron.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import type { TestIssuer } from "./jwt.ts";

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

/** `${process.platform}-${process.arch}`, the key `backend.json` lists assets under. */
export function platformKey(platform = process.platform, arch = process.arch): string {
  return `${platform}-${arch}`;
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

/**
 * The verified binary for this platform, downloading and unpacking it into the
 * cache on first use. A `.verified` marker records the zip digest it came from,
 * so a cache entry from another pin is never reused.
 */
export async function ensureBackendBinary(
  options: { pin?: BackendPin; log?: (line: string) => void } = {},
): Promise<string> {
  const pin = options.pin ?? readPin();
  const log = options.log ?? (() => {});
  const key = platformKey();
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
  if (existsSync(binary) && existsSync(marker)) {
    if ((await readFile(marker, "utf8")).trim() === asset.sha256) return binary;
  }

  await mkdir(root, { recursive: true });
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
    await rm(dir, { recursive: true, force: true });
    await mkdir(dirname(dir), { recursive: true });
    try {
      await rename(unpacked, dir);
    } catch (error) {
      // Another process unpacked the same pin first; its copy is just as good.
      if (!existsSync(marker)) throw error;
    }
    log(`cached ${binary}`);
    return binary;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Two distinct free loopback ports, held open together so they cannot repeat. */
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
  dataDir: string;
  pid: number;
  /** Environment for the `convex` CLI against this backend and nothing else. */
  cliEnv(): NodeJS.ProcessEnv;
  stop(): Promise<void>;
};

export const INSTANCE_NAME = "volli-test";

/**
 * Variables that would point the `convex` CLI at a cloud deployment. They are
 * removed from every CLI child, so the fixture can only ever talk to its own
 * loopback backend.
 */
const FOREIGN_DEPLOYMENT_ENV = [
  "CONVEX_DEPLOYMENT",
  "CONVEX_DEPLOY_KEY",
  "CONVEX_URL",
  "CONVEX_SELF_HOSTED_URL",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
];

export function cliEnvFor(
  url: string,
  adminKey: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of FOREIGN_DEPLOYMENT_ENV) delete env[name];
  env["CONVEX_SELF_HOSTED_URL"] = url;
  env["CONVEX_SELF_HOSTED_ADMIN_KEY"] = adminKey;
  return env;
}

async function waitForVersion(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`backend exited during startup (${child.exitCode ?? child.signalCode})`);
    }
    try {
      const response = await fetch(`${url}/version`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`backend did not answer ${url}/version within ${timeoutMs} ms`);
}

function stopChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
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
 * is off and nothing listens beyond 127.0.0.1. A process-exit hook kills it if
 * the caller dies before `stop()`.
 */
export async function startBackend(
  options: { binary?: string; startupTimeoutMs?: number; log?: (line: string) => void } = {},
): Promise<RunningBackend> {
  const binary = options.binary ?? (await ensureBackendBinary({ log: options.log }));
  const instanceSecret = randomBytes(32).toString("hex");
  const keygen = spawnSync(
    binary,
    ["keygen", "admin-key", "--instance-name", INSTANCE_NAME, "--instance-secret", instanceSecret],
    { encoding: "utf8" },
  );
  if (keygen.status !== 0) {
    throw new Error(`keygen admin-key failed (${keygen.status}): ${keygen.stderr}`);
  }
  const adminKey = keygen.stdout.trim();

  const dataDir = await mkdtemp(join(tmpdir(), "volli-convex-"));
  const logPath = join(dataDir, "backend.log");
  // A just-freed port can be taken before the backend binds it; retry with new ones.
  for (let attempt = 1; ; attempt += 1) {
    const [port, sitePort] = await freePorts(2);
    const url = `http://127.0.0.1:${port}`;
    const siteUrl = `http://127.0.0.1:${sitePort}`;
    const logFile = createWriteStream(logPath, { flags: "a" });
    const child = spawn(
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
      { cwd: dataDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout?.pipe(logFile);
    child.stderr?.pipe(logFile);
    const killOnExit = () => child.kill("SIGKILL");
    process.once("exit", killOnExit);
    try {
      await waitForVersion(url, child, options.startupTimeoutMs ?? 30_000);
    } catch (error) {
      process.off("exit", killOnExit);
      await stopChild(child, 2_000);
      if (attempt < 3) continue;
      const tail = existsSync(logPath) ? readFileSync(logPath, "utf8").slice(-4_000) : "";
      await rm(dataDir, { recursive: true, force: true });
      throw new Error(`${(error as Error).message}\n--- backend.log (tail) ---\n${tail}`, {
        cause: error,
      });
    }
    let stopped: Promise<void> | undefined;
    return {
      url,
      siteUrl,
      adminKey,
      dataDir,
      pid: child.pid ?? -1,
      cliEnv: () => cliEnvFor(url, adminKey),
      stop() {
        stopped ??= (async () => {
          process.off("exit", killOnExit);
          await stopChild(child, 5_000);
          logFile.end();
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

/** The `convex` CLI from this package's pinned dependency, aimed at `backend`. */
export function runConvexCli(
  backend: Pick<RunningBackend, "cliEnv">,
  args: string[],
  options: { stdio?: "inherit" | "pipe" } = {},
): Promise<{ code: number; output: string }> {
  const require = createRequire(join(PACKAGE_DIR, "package.json"));
  const cli = join(dirname(require.resolve("convex/package.json")), "bin/main.js");
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: PACKAGE_DIR,
      env: backend.cliEnv(),
      stdio: options.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code, signal) => done({ code: code ?? (signal ? 128 : 1), output }));
  });
}

/** Push `functions/` to `backend`, leaving the committed `_generated/` untouched. */
async function deployFunctions(backend: Pick<RunningBackend, "cliEnv">): Promise<void> {
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

/** What a test or command needs to reach a deployed fixture backend. */
export type BackendTestEnv = {
  VOLLI_CONVEX_URL: string;
  VOLLI_CONVEX_SITE_URL: string;
  VOLLI_CONVEX_TEST_PRIVATE_KEY: string;
};

/**
 * Trust `issuer` on `backend`, push `functions/`, and return the environment
 * `fixture/testing.ts` reads. The JWKS variable is set before the push because
 * the auth config is evaluated at push time.
 */
export async function deployForTests(
  backend: Pick<RunningBackend, "url" | "siteUrl" | "adminKey" | "cliEnv">,
  issuer: TestIssuer,
): Promise<BackendTestEnv> {
  await setDeploymentEnv(backend, { VOLLI_TEST_JWKS: issuer.jwksDataUri });
  await deployFunctions(backend);
  return {
    VOLLI_CONVEX_URL: backend.url,
    VOLLI_CONVEX_SITE_URL: backend.siteUrl,
    VOLLI_CONVEX_TEST_PRIVATE_KEY: issuer.privateKeyPem,
  };
}
