import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { nodeHTTPRequestHandler } from "@trpc/server/adapters/node-http";
import { createOpenCodeNativeAdapter, type OpenCodeNativeAdapter } from "@volli/opencode-adapter";
import { createSessionRouter, RpcDiagnosticLog } from "@volli/session-rpc";

import { LAB_SESSION_RPC_PATH } from "../../lab-session-rpc-path";
import { openVolliDb } from "../db";
import { insertProject } from "../db/projects-repo";
import { createDesktopSessionRuntime } from "../session-runtime";

export { LAB_SESSION_RPC_PATH } from "../../lab-session-rpc-path";
export const LAB_PROJECT_ID = "lab-project";

const requireFromHere = createRequire(import.meta.url);

interface LabResources {
  readonly directory: string;
  readonly db: ReturnType<typeof openVolliDb>;
  readonly adapter: OpenCodeNativeAdapter;
  readonly runtime: ReturnType<typeof createDesktopSessionRuntime>;
  readonly router: ReturnType<typeof createSessionRouter>;
  readonly diagnostics: RpcDiagnosticLog;
}

export interface LabSessionRpcServerOptions {
  /** The tracked repository directory. This is never accepted from browser input. */
  repoRoot: string;
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
  readonly #repoRoot: string;
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

  constructor(options: LabSessionRpcServerOptions) {
    this.#repoRoot = resolve(options.repoRoot);
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
      db = openVolliDb(join(directory, "volli.db"), {
        nativeBinding: nodeAbiBindingPath() ?? undefined,
      });
      this.#db = db;
      const now = this.#now();
      insertProject(db, {
        id: LAB_PROJECT_ID,
        name: "Volli Code Lab",
        path: this.#repoRoot,
        ticketPrefix: "LAB",
        baseBranch: null,
        setupCommand: null,
        colorIndex: 0,
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      });
      const adapter = this.#createAdapter();
      this.#adapter = adapter;
      const transcriptDirectory = join(directory, "artifacts");
      await mkdir(transcriptDirectory, { recursive: true, mode: 0o700 });
      const runtime = createDesktopSessionRuntime({
        db,
        transcriptDirectory,
        adapters: [adapter],
        now: this.#now,
      });
      this.#runtime = runtime;
      return {
        directory,
        db,
        adapter,
        runtime,
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
