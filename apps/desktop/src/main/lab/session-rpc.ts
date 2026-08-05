import { existsSync, readFileSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import { nodeHTTPRequestHandler } from "@trpc/server/adapters/node-http";
import { createOpenCodeNativeAdapter, type OpenCodeNativeAdapter } from "@volli/opencode-adapter";
import type { RuntimeCatalog } from "@volli/session-engine";
import { createSessionRouter, RpcDiagnosticLog } from "@volli/session-rpc";
import { createTicket } from "@volli/shared";

import {
  LAB_SESSION_PROJECT_ID,
  LAB_SESSION_RPC_PATH,
  LAB_SESSION_TICKET_ID,
} from "../../lab-session-rpc-path";
import { openVolliDb } from "../db";
import { insertProject } from "../db/projects-repo";
import { insertTicket } from "../db/tickets-repo";
import { createDesktopSessionRuntime } from "../session-runtime";
import { createRuntimeCatalog } from "../runtime-catalog";
import { createLabScenarioAdapter } from "./scenario-adapter";

export { LAB_SESSION_RPC_PATH } from "../../lab-session-rpc-path";

const requireFromHere = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

/**
 * Builds the disposable repository every native Lab Session is allowed to
 * touch. The browser never supplies this path: the Lab owns the parent and the
 * server derives the workspace beneath it, so an agent cannot be pointed at a
 * developer checkout through a renderer payload.
 */
export async function createLabTaskWorkspace(parentDirectory: string): Promise<string> {
  const workspace = join(parentDirectory, "workspace");
  await mkdir(join(workspace, "src"), { recursive: true, mode: 0o700 });
  await mkdir(join(workspace, "test"), { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(
      join(workspace, "TASK.md"),
      [
        "# Lab task",
        "",
        "Implement the greeting so `greeting(name)` returns `Hello, <name>!`.",
        "Run `npm test` to prove the result. Keep the public function name unchanged.",
        "",
      ].join("\n"),
      { mode: 0o600 },
    ),
    writeFile(
      join(workspace, "package.json"),
      `${JSON.stringify({ name: "volli-agent-lab", private: true, type: "module", scripts: { test: "node --test test/*.test.ts" } }, null, 2)}\n`,
      { mode: 0o600 },
    ),
    // The approval gate is the one interaction the Lab could not reach. Left to
    // the developer's own OpenCode config it never fired, so the card with Allow
    // / Deny / Steer on it — the whole trust boundary of a chat-first Session —
    // was only ever exercised against fixtures. Asking on `bash` puts a real
    // permission in a real transcript on the way to running the task's own
    // tests. Scoped to the disposable workspace, so it changes nothing else, and
    // `edit` stays silent: a prompt per file would drown the thing being tested.
    writeFile(
      join(workspace, "opencode.json"),
      `${JSON.stringify({ $schema: "https://opencode.ai/config.json", permission: { bash: "ask" } }, null, 2)}\n`,
      { mode: 0o600 },
    ),
    writeFile(
      join(workspace, "src/greeting.ts"),
      [
        "export function greeting(_name: string): string {",
        '  return "Hello, world!";',
        "}",
        "",
      ].join("\n"),
      { mode: 0o600 },
    ),
    writeFile(
      join(workspace, "test/greeting.test.ts"),
      [
        'import assert from "node:assert/strict";',
        'import test from "node:test";',
        'import { greeting } from "../src/greeting.ts";',
        "",
        'test("greets a developer by name", () => {',
        '  assert.equal(greeting("Ada"), "Hello, Ada!");',
        "});",
        "",
      ].join("\n"),
      { mode: 0o600 },
    ),
  ]);
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: workspace });
  await execFileAsync("git", ["add", "TASK.md", "package.json", "opencode.json", "src", "test"], {
    cwd: workspace,
  });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Volli Lab",
      "-c",
      "user.email=lab@volli.local",
      "commit",
      "-m",
      "Seed disposable agent task",
    ],
    { cwd: workspace },
  );
  return workspace;
}

interface LabResources {
  readonly directory: string;
  readonly db: ReturnType<typeof openVolliDb>;
  readonly adapter: OpenCodeNativeAdapter;
  readonly runtime: ReturnType<typeof createDesktopSessionRuntime>;
  readonly runtimeCatalog: ReturnType<typeof createRuntimeCatalog>;
  readonly router: ReturnType<typeof createSessionRouter>;
  readonly diagnostics: RpcDiagnosticLog;
}

export interface LabSessionRpcServerOptions {
  createAdapter?: () => OpenCodeNativeAdapter;
  now?: () => number;
  /** Injectable only so shutdown semantics can be verified without ending Node. */
  exitLifecycle?: LabProcessExitLifecycle;
}

/** The tiny process-exit surface the Lab owns. */
export interface LabProcessExitLifecycle {
  add(listener: () => void): void;
  remove(listener: () => void): void;
}

const processExitLifecycle: LabProcessExitLifecycle = {
  add: (listener) => process.once("exit", listener),
  remove: (listener) => process.off("exit", listener),
};

/**
 * A dev-only same-origin transport for the UI Lab. It has no Electron IPC and
 * owns a disposable DB/artifact directory for exactly one Vite server.
 */
export class LabSessionRpcServer {
  readonly #createAdapter: () => OpenCodeNativeAdapter;
  readonly #now: () => number;
  readonly #exitLifecycle: LabProcessExitLifecycle;
  readonly #onProcessExit = () => this.emergencyClose();
  #resources: Promise<LabResources> | null = null;
  #close: Promise<void> | null = null;
  #directory: string | null = null;
  #db: ReturnType<typeof openVolliDb> | null = null;
  #adapter: OpenCodeNativeAdapter | null = null;
  #runtime: ReturnType<typeof createDesktopSessionRuntime> | null = null;
  #emergencyClosed = false;
  #closed = false;

  constructor(options: LabSessionRpcServerOptions = {}) {
    this.#createAdapter = options.createAdapter ?? (() => createOpenCodeNativeAdapter());
    this.#now = options.now ?? Date.now;
    this.#exitLifecycle = options.exitLifecycle ?? processExitLifecycle;
    this.#exitLifecycle.add(this.#onProcessExit);
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const securityError = labRequestSecurityError(req);
    if (securityError) {
      sendText(res, 403, securityError);
      return;
    }
    if (this.#closed) {
      sendText(res, 503, "Lab Session RPC server is closed");
      return;
    }

    const path = rpcPath(req);
    if (!path) {
      sendText(res, 404, "Unknown Lab Session RPC procedure");
      return;
    }

    try {
      const resources = await this.#ensureResources();
      await nodeHTTPRequestHandler({
        router: resources.router,
        req,
        res,
        path,
        createContext: () => ({
          runtime: resources.runtime,
          resolveRuntimeCatalog: (projectId) =>
            labRuntimeCatalogFor(resources.runtimeCatalog, projectId),
          diagnostics: resources.diagnostics,
          transport: "lab-http" as const,
        }),
      });
    } catch (error) {
      if (!res.headersSent) {
        sendText(
          res,
          500,
          error instanceof Error ? error.message : "Lab Session RPC initialization failed",
        );
      }
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#close ??= this.#closeResources().finally(() => this.#removeExitListener());
    return this.#close;
  }

  /**
   * Process-exit handlers cannot await. Start teardown of the provider child,
   * close the SQLite handle, and synchronously remove only this Lab's owned
   * temporary directory. Normal shutdown remains the complete async path.
   */
  emergencyClose(): void {
    if (this.#emergencyClosed) return;
    this.#emergencyClosed = true;
    this.#closed = true;
    this.#removeExitListener();

    if (this.#runtime) {
      void this.#runtime.close().catch(() => undefined);
    }
    if (this.#adapter) {
      try {
        void this.#adapter.close().catch(() => undefined);
      } catch {
        // A process is already exiting; retain the directory cleanup guarantee.
      }
    }
    try {
      this.#db?.close();
    } catch {
      // SQLite may already be closed by the normal path.
    }
    if (this.#directory && isOwnedLabDirectory(this.#directory)) {
      try {
        rmSync(this.#directory, { recursive: true, force: true });
      } catch {
        // Best effort only: process exit will release any remaining OS handles.
      }
    }
  }

  async #closeResources(): Promise<void> {
    if (this.#emergencyClosed) return;
    const pending = this.#resources;
    if (!pending) return;
    let resources: LabResources | null = null;
    try {
      resources = await pending;
    } catch {
      return;
    }
    try {
      await resources.runtime.close();
    } finally {
      try {
        await resources.adapter.close();
      } finally {
        resources.db.close();
        await rm(resources.directory, { recursive: true, force: true });
      }
    }
  }

  #removeExitListener(): void {
    this.#exitLifecycle.remove(this.#onProcessExit);
  }

  async #ensureResources(): Promise<LabResources> {
    if (!this.#resources) {
      const pending = this.#createResources();
      this.#resources = pending;
      void pending.catch(() => {
        if (this.#resources === pending) this.#resources = null;
      });
    }
    return this.#resources;
  }

  async #createResources(): Promise<LabResources> {
    const directory = await mkdtemp(join(tmpdir(), "volli-lab-session-rpc-"));
    this.#directory = directory;
    let db: ReturnType<typeof openVolliDb> | null = null;
    try {
      const workspace = await createLabTaskWorkspace(directory);
      db = openVolliDb(join(directory, "volli.db"), {
        nativeBinding: nodeAbiBindingPath() ?? undefined,
      });
      this.#db = db;
      const now = this.#now();
      insertProject(db, {
        id: LAB_SESSION_PROJECT_ID,
        name: "Volli Code Lab",
        path: workspace,
        ticketPrefix: "LAB",
        baseBranch: null,
        setupCommand: null,
        colorIndex: 0,
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      });
      insertTicket(
        db,
        createTicket({
          id: LAB_SESSION_TICKET_ID,
          projectId: LAB_SESSION_PROJECT_ID,
          ticketNumber: 14,
          title: "Teach the lab greeting to use a developer's name",
          body: "Update greeting(name) so the failing test passes, then run the test suite.",
          status: "doing",
          order: 0,
          now,
          usesWorktree: true,
          worktreePath: workspace,
          branch: "main",
          baseBranch: "main",
        }),
      );
      const adapter = this.#createAdapter();
      this.#adapter = adapter;
      const transcriptDirectory = join(directory, "artifacts");
      await mkdir(transcriptDirectory, { recursive: true, mode: 0o700 });
      // The scripted harness sits beside the real one rather than replacing it:
      // a scenario is picked per Session, so both must be attachable from the
      // same running lab. It spawns nothing and reads nothing.
      const runtime = createDesktopSessionRuntime({
        db,
        transcriptDirectory,
        adapters: [adapter, createLabScenarioAdapter({ now: this.#now })],
        now: this.#now,
      });
      this.#runtime = runtime;
      const runtimeCatalog = createRuntimeCatalog({
        db,
        directory: workspace,
        adapters: [
          {
            id: adapter.manifest.id,
            profileId: "native",
            discover: (context, signal) => adapter.probe(context, signal),
          },
        ],
        now: this.#now,
      });
      return {
        directory,
        db,
        adapter,
        runtime,
        runtimeCatalog,
        router: createSessionRouter(),
        diagnostics: new RpcDiagnosticLog(),
      };
    } catch (error) {
      db?.close();
      await rm(directory, { recursive: true, force: true });
      this.#directory = null;
      this.#db = null;
      this.#adapter = null;
      this.#runtime = null;
      throw error;
    }
  }
}

/**
 * The one-catalog form of `runtime-catalog-hub.ts`, which is what
 * `resolveRuntimeCatalog` becomes in the app. The hub keeps a catalog per
 * project directory and answers an unknown `projectId` by throwing rather than
 * by falling back — its docstring names the failure that rule prevents, a
 * request probing the wrong checkout and persisting its models there. The Lab
 * seeds exactly one project, so the *cache* half of the hub has nothing to do
 * here; the *refusal* half still does. A `projectId` on a `runtimeCatalog.*`
 * request is a claim about which checkout gets probed and whose runtime
 * preferences a `save` writes, and answering `ghost-project` with this catalog
 * is that claim quietly being false — an inspect result and a success receipt
 * for a project that does not exist.
 *
 * Being dev-only bounds the damage but not the reason to fix it. The Lab is
 * where the Session UI is built, so it is the surface those components are
 * written and believed against: a Lab that accepts a project id the app would
 * answer `NOT_FOUND` teaches the surface above it a contract that is not real,
 * and the code learns the difference only once it is running over Electron IPC
 * with no lab around it.
 *
 * So `undefined` resolves — a Session with no project yet, and what
 * `runtimeCatalog.resolve` always sends — the Lab's own project id resolves,
 * and anything else throws. `requireRuntimeCatalog` in `@volli/session-rpc`
 * already maps a throw from here to `NOT_FOUND`, exactly as it does the hub's,
 * so the Lab needs no error machinery of its own to refuse the same way.
 */
function labRuntimeCatalogFor(catalog: RuntimeCatalog, projectId?: string): RuntimeCatalog {
  if (projectId !== undefined && projectId !== LAB_SESSION_PROJECT_ID) {
    throw new Error(`Unknown project ${projectId}`);
  }
  return catalog;
}

function isOwnedLabDirectory(directory: string): boolean {
  const temporaryDirectory = resolve(tmpdir());
  return (
    dirname(directory) === temporaryDirectory &&
    directory.startsWith(join(temporaryDirectory, "volli-lab-session-rpc-"))
  );
}

/** Returns a safe rejection reason, or null for same-origin loopback traffic. */
export function labRequestSecurityError(req: IncomingMessage): string | null {
  const host = req.headers.host;
  if (!host || !isLoopbackHost(host)) return "Lab Session RPC accepts only loopback hosts";

  const remoteAddress = req.socket.remoteAddress;
  if (remoteAddress && !isLoopbackAddress(remoteAddress)) {
    return "Lab Session RPC rejects non-loopback clients";
  }

  const origin = req.headers.origin;
  if (origin && !isSameHttpOrigin(origin, host)) {
    return "Lab Session RPC rejects foreign origins";
  }
  return null;
}

function rpcPath(req: IncomingMessage): string | null {
  const requestUrl = req.url ?? "/";
  let pathname: string;
  try {
    pathname = new URL(requestUrl, "http://localhost").pathname;
  } catch {
    return null;
  }
  const mountedPath =
    pathname === LAB_SESSION_RPC_PATH
      ? "/"
      : pathname.startsWith(`${LAB_SESSION_RPC_PATH}/`)
        ? pathname.slice(LAB_SESSION_RPC_PATH.length)
        : pathname;
  const path = mountedPath.replace(/^\/+/, "");
  return path.length > 0 && !path.split("/").includes("..") ? path : null;
}

function isLoopbackHost(host: string): boolean {
  try {
    return isLoopbackAddress(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function isSameHttpOrigin(origin: string, host: string): boolean {
  try {
    const parsedOrigin = new URL(origin);
    const parsedHost = new URL(`http://${host}`);
    return parsedOrigin.protocol === "http:" && parsedOrigin.host === parsedHost.host;
  } catch {
    return false;
  }
}

function isLoopbackAddress(value: string): boolean {
  const address = value.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    address === "localhost" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    /^127(?:\.\d{1,3}){3}$/.test(address)
  );
}

function nodeAbiBindingPath(): string | null {
  if (process.versions.electron) return null;
  const packageJsonPath = requireFromHere.resolve("better-sqlite3/package.json");
  const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };
  const binding = join(
    dirname(packageJsonPath),
    "prebuilds",
    `better_sqlite3-v${version}-node-v${process.versions.modules}.node`,
  );
  if (!existsSync(binding)) {
    throw new Error(
      `Node-ABI better-sqlite3 binding missing at ${binding} — ` +
        "run `pnpm -C apps/desktop run cache:node-sqlite`.",
    );
  }
  return binding;
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
}
