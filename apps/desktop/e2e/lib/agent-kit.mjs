/**
 * agent-kit — shared machinery for the `volli` CLI / agent-socket e2e probes.
 * Complements smoke-kit.mjs with the pieces those board/composer
 * smokes never needed: locating the app-generated runtime artifacts (the
 * `volli.sock` and the `<userData>/bin/volli` shim), driving the REAL built CLI
 * against a live app, and one raw NDJSON round-trip so a probe can talk to the
 * socket without going through the CLI at all.
 *
 * These are MANUALLY-RUN probes (need a display + the built app); NOT wired into
 * `vp test`. Each agent probe lives in its OWN file and imports from here.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Repo root — this file lives at apps/desktop/e2e/lib/, so up four levels. */
export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** The built CLI bundle the app copies into place (packages/cli dist). */
export const CLI_BUNDLE = resolve(REPO, "packages/cli/dist/volli.cjs");

/**
 * A scratch profile under a SHORT base dir. smoke-kit's makeScratch roots under
 * os.tmpdir() (`/var/folders/…`, ~50 chars); the app binds its socket at
 * `<userData>/volli.sock`, and a Unix socket's sun_path caps near 104 bytes, so
 * the os.tmpdir() profile overflows it and the socket silently fails to bind
 * (fail-open, logged). Rooting under `/tmp` keeps the bound path well inside the
 * limit. Honours VOLLI_SMOKE_DIR (reuse + no cleanup) like makeScratch does.
 *
 * @param {string} tag  A tiny suffix to disambiguate concurrent runs (e.g. "sock").
 */
export async function makeShortScratch(tag = "") {
  const ownsScratch = process.env.VOLLI_SMOKE_DIR === undefined;
  const scratch = process.env.VOLLI_SMOKE_DIR ?? (await fs.mkdtemp(`/tmp/vol${tag}-`));
  const userDataDir = join(scratch, "ud");
  const dbPath = join(scratch, "volli.db");
  await fs.mkdir(userDataDir, { recursive: true });
  return {
    scratch,
    userDataDir,
    dbPath,
    ownsScratch,
    cleanup: async () => {
      if (ownsScratch) await fs.rm(scratch, { recursive: true, force: true });
    },
  };
}

/** The Unix socket the app binds under its userData dir. */
export function socketPathFor(userDataDir) {
  return join(userDataDir, "volli.sock");
}

/** The launcher shim the app (re)generates on every boot. */
export function shimPathFor(userDataDir) {
  return join(userDataDir, "bin", "volli");
}

/**
 * Drive the REAL generated `volli` shim (a POSIX sh launcher that sets
 * ELECTRON_RUN_AS_NODE=1 and execs the app's own Electron against the CLI
 * bundle, avoiding a second runtime). `extraEnv` merges over
 * process.env; point VOLLI_SOCKET here to target a specific (or dead) app.
 * Never throws on a non-zero exit — returns `{ code, stdout, stderr }` so a
 * probe can assert the exit-code contract (0/1/2/3).
 *
 * @param {string} shimPath  Absolute path to `<userData>/bin/volli`.
 * @param {readonly string[]} args
 * @param {Record<string,string|undefined>} [extraEnv]
 */
export async function runVolliShim(shimPath, args, extraEnv = {}) {
  return runCapturing(shimPath, args, extraEnv);
}

/**
 * Drive the same built bundle through PLAIN node (the decision-7 alternative:
 * `node volli.cjs …`), for probes that want to prove the bundle itself runs
 * outside the Electron-as-node shim. `process.execPath` is the node running the
 * probe.
 */
export async function runVolliNode(args, extraEnv = {}) {
  return runCapturing(process.execPath, [CLI_BUNDLE, ...args], extraEnv);
}

async function runCapturing(file, args, extraEnv) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      env: { ...process.env, ...extraEnv },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    // execFile rejects on any non-zero exit; the code + captured streams live
    // on the error object. A spawn failure (ENOENT etc.) has no numeric code.
    return {
      code: typeof error?.code === "number" ? error.code : 1,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? String(error?.message ?? error),
    };
  }
}

/**
 * One raw NDJSON request against the app socket, bypassing the CLI entirely —
 * so a probe can assert the socket itself answers the v1 protocol. Resolves
 * with the parsed response object (or rejects on connect/timeout/protocol
 * failure).
 *
 * @param {string} socketPath
 * @param {object} request  A `{ v:1, cmd, args, ctx }` agent request.
 * @param {{timeoutMs?:number}} [opts]
 */
export function requestOverSocket(socketPath, request, { timeoutMs = 5000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`socket request timed out after ${timeoutMs}ms`))),
      timeoutMs,
    );
    socket.once("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        finish(() => resolvePromise(JSON.parse(buffer.slice(0, newline))));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    socket.once("error", (error) => finish(() => reject(error)));
    socket.once("end", () => {
      if (!buffer.includes("\n")) finish(() => reject(new Error("socket closed with no response")));
    });
  });
}

/** A minimal, valid `identify` agent request with no session context. */
export function identifyRequest(cwd = process.cwd()) {
  return { v: 1, cmd: "identify", args: {}, ctx: { cwd, env: {} } };
}

/**
 * Seed one project + create one ticket through the preload bridge, returning the
 * project row and the created ticket's display id. Mirrors the board/composer
 * smokes' bridge-seeding path (Playwright can't drive the native folder picker).
 *
 * @param {import("playwright-core").Page} page
 * @param {{id:string,name:string,path:string,prefix:string}} project  Already seeded via seedProjects.
 * @param {{title:string,status?:string,priority?:string}} ticket
 * @returns {Promise<{projectId:string, displayId:string, ticketNumber:number, ticketId:string}>}
 */
export async function createTicketViaBridge(page, projectName, ticket) {
  return page.evaluate(
    async ({ name, t }) => {
      const boot = await window.api.data.bootstrap();
      if (!boot.ok) throw new Error(`bootstrap: ${boot.error}`);
      const project = boot.data.projects.find((p) => p.name === name);
      if (!project) throw new Error(`project ${name} missing after seed`);
      const res = await window.api.tickets.create({
        projectId: project.id,
        status: t.status ?? "todo",
        title: t.title,
        priority: t.priority ?? "medium",
      });
      if (!res.ok) throw new Error(`ticket create: ${res.error}`);
      return {
        projectId: project.id,
        ticketId: res.ticket.id,
        ticketNumber: res.ticket.ticketNumber,
        displayId: `${project.ticketPrefix}-${res.ticket.ticketNumber}`,
      };
    },
    { name: projectName, t: ticket },
  );
}
