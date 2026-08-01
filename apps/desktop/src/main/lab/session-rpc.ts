import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { nodeHTTPRequestHandler } from "@trpc/server/adapters/node-http";
import { createOpenCodeNativeAdapter, type OpenCodeNativeAdapter } from "@volli/opencode-adapter";
import { createSessionRouter, RpcDiagnosticLog } from "@volli/session-rpc";

import { openVolliDb } from "../db";
import { insertProject } from "../db/projects-repo";
import { createDesktopSessionRuntime } from "../session-runtime";

export const LAB_SESSION_RPC_PATH = "/__lab/session-rpc";
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
}

/**
 * A dev-only same-origin transport for the UI Lab. It has no Electron IPC and
 * owns a disposable DB/artifact directory for exactly one Vite server.
 */
export class LabSessionRpcServer {
  readonly #repoRoot: string;
  readonly #createAdapter: () => OpenCodeNativeAdapter;
  readonly #now: () => number;
  #resources: Promise<LabResources> | null = null;
  #close: Promise<void> | null = null;
  #closed = false;

  constructor(options: LabSessionRpcServerOptions) {
    this.#repoRoot = resolve(options.repoRoot);
    this.#createAdapter = options.createAdapter ?? (() => createOpenCodeNativeAdapter());
    this.#now = options.now ?? Date.now;
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
    this.#close ??= this.#closeResources();
    return this.#close;
  }

  async #closeResources(): Promise<void> {
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

  async #ensureResources(): Promise<LabResources> {
    if (!this.#resources) this.#resources = this.#createResources();
    return this.#resources;
  }

  async #createResources(): Promise<LabResources> {
    const directory = await mkdtemp(join(tmpdir(), "volli-lab-session-rpc-"));
    let db: ReturnType<typeof openVolliDb> | null = null;
    try {
      db = openVolliDb(join(directory, "volli.db"), {
        nativeBinding: nodeAbiBindingPath() ?? undefined,
      });
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
      const transcriptDirectory = join(directory, "artifacts");
      await mkdir(transcriptDirectory, { recursive: true, mode: 0o700 });
      return {
        directory,
        db,
        adapter,
        runtime: createDesktopSessionRuntime({
          db,
          transcriptDirectory,
          adapters: [adapter],
          now: this.#now,
        }),
        router: createSessionRouter(),
        diagnostics: new RpcDiagnosticLog(),
      };
    } catch (error) {
      db?.close();
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
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
