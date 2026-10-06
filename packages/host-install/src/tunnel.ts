/**
 * The tunnel (VC-700 flow step 7): `ssh -N -L` from a loopback port on this
 * Mac to the host protocol's loopback listener on the box, the owner's
 * default transport for a host added over SSH (VC-615 decision 3). The
 * client link (VC-670) connects to the local end: `ws://127.0.0.1:<port>`.
 *
 * - **Its own ssh process**, not the ControlMaster: a sleeping Mac kills a
 *   multiplexed master, and the tunnel must come back on its own.
 * - **The local port stays put** across reconnects, so the link's URL does
 *   not change; only if another program took it is a new one chosen (and
 *   `onState` says so).
 * - **Reconnect** after the ssh process exits, with backoff (1 s doubling to
 *   30 s). `wake()` after sleep or a network change restarts it at once, since
 *   a tunnel that slept may look alive for up to `ServerAlive*` (45 s).
 * - **The remote end is asked each time** (`resolveRemote`), so a host that
 *   moved its port is followed.
 * - Agents run on the host, so a tunnel that is down costs the view, not the
 *   work: the link shows Reconnecting meanwhile.
 */
import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { createConnection, createServer } from "node:net";

import type { ListenAddress } from "./contract";
import type { InstallLogger } from "./logger";
import { classifySshFailure, type SpawnProcess } from "./ssh";
import { targetArgs, type SshTarget } from "./target";

export type TunnelState =
  | { readonly status: "starting" }
  | { readonly status: "up"; readonly url: string; readonly localPort: number }
  | { readonly status: "down"; readonly error: string; readonly retryInMs: number }
  | { readonly status: "closed" };

export interface TunnelTiming {
  readonly readyTimeoutMs: number;
  readonly pollMs: number;
  readonly backoffMinMs: number;
  readonly backoffMaxMs: number;
}

export const DEFAULT_TUNNEL_TIMING: TunnelTiming = {
  readyTimeoutMs: 20_000,
  pollMs: 100,
  backoffMinMs: 1_000,
  backoffMaxMs: 30_000,
};

export interface SshTunnelOptions {
  readonly target: SshTarget;
  readonly logger: InstallLogger;
  /** Where the host listens on the box, asked before every (re)connect. */
  readonly resolveRemote: () => Promise<ListenAddress>;
  readonly sshPath?: string;
  readonly spawn?: SpawnProcess;
  /** A free loopback port; the OS picks one by default. */
  readonly freePort?: () => Promise<number>;
  /** Whether something accepts on the local end yet. */
  readonly accepts?: (port: number) => Promise<boolean>;
  readonly timing?: Partial<TunnelTiming>;
}

export interface SshTunnel {
  /** Opens the tunnel; resolves with the URL once it carries, or rejects with why not. */
  start(): Promise<string>;
  readonly state: TunnelState;
  onState(listener: (state: TunnelState) => void): () => void;
  /** After sleep or a network change: reconnect now, not after backoff or a dead-peer timeout. */
  wake(): void;
  /** Stops it for good. */
  close(): void;
}

export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export function loopbackAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** The ssh arguments for one tunnel process. */
export function tunnelArgs(target: SshTarget, localPort: number, remote: ListenAddress): string[] {
  const remoteHost = remote.host.includes(":") ? `[${remote.host}]` : remote.host;
  return [
    "-N",
    "-T",
    ...[
      "BatchMode=yes",
      "StrictHostKeyChecking=yes",
      "ExitOnForwardFailure=yes",
      "ConnectTimeout=15",
      "ServerAliveInterval=15",
      "ServerAliveCountMax=3",
      "ForwardAgent=no",
      "ForwardX11=no",
      "ControlMaster=no",
      "ControlPath=none",
    ].flatMap((option) => ["-o", option]),
    "-L",
    `127.0.0.1:${localPort}:${remoteHost}:${remote.port}`,
    ...targetArgs(target),
  ];
}

export function createSshTunnel(options: SshTunnelOptions): SshTunnel {
  const timing = { ...DEFAULT_TUNNEL_TIMING, ...options.timing };
  const spawn: SpawnProcess =
    options.spawn ??
    ((command, args) => nodeSpawn(command, [...args], { stdio: ["ignore", "ignore", "pipe"] }));
  const freePort = options.freePort ?? freeLoopbackPort;
  const accepts = options.accepts ?? loopbackAccepts;
  const { logger } = options;
  const listeners = new Set<(state: TunnelState) => void>();
  let state: TunnelState = { status: "starting" };
  let child: ChildProcess | null = null;
  let localPort: number | null = null;
  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;

  const set = (next: TunnelState): void => {
    state = next;
    for (const listener of listeners) listener(next);
  };

  /** One attempt: spawn, wait for the local end to carry, or for the process to die. */
  const attempt = async (): Promise<string> => {
    const mine = ++generation;
    set({ status: "starting" });
    const remote = await options.resolveRemote();
    localPort ??= await freePort();
    const port = localPort;
    const process = spawn(options.sshPath ?? "ssh", tunnelArgs(options.target, port, remote));
    child = process;
    let stderr = "";
    process.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    let exited: number | null = null;
    process.on("error", (error) => {
      stderr += error.message;
      exited = 127;
    });
    process.on("close", (code) => {
      exited = code ?? 255;
      if (mine !== generation || state.status === "closed") return;
      if (state.status === "up") {
        logger.warn("tunnel dropped", {
          localPort: port,
          code: exited,
          detail: stderr.trim().slice(-300),
        });
        scheduleRetry(stderr || `ssh exited ${exited}`);
      }
    });
    const deadline = Date.now() + timing.readyTimeoutMs;
    for (;;) {
      if (exited !== null) {
        if (/Address already in use|cannot listen to port/u.test(stderr)) localPort = null;
        const failure = classifySshFailure({ code: 255, stdout: "", stderr });
        throw new Error(failure?.detail || `ssh exited ${exited}`);
      }
      if (await accepts(port)) break;
      if (Date.now() >= deadline) {
        process.kill("SIGTERM");
        throw new Error(`The tunnel did not open within ${timing.readyTimeoutMs / 1000} s`);
      }
      await new Promise((resolve) => setTimeout(resolve, timing.pollMs));
    }
    failures = 0;
    const url = `ws://127.0.0.1:${port}`;
    logger.info("tunnel up", { localPort: port, remotePort: remote.port });
    set({ status: "up", url, localPort: port });
    return url;
  };

  const scheduleRetry = (error: string): void => {
    failures += 1;
    const retryInMs = Math.min(timing.backoffMaxMs, timing.backoffMinMs * 2 ** (failures - 1));
    set({ status: "down", error: error.trim().slice(-300), retryInMs });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => void reconnect(), retryInMs);
  };

  const reconnect = async (): Promise<void> => {
    child?.kill("SIGTERM");
    try {
      await attempt();
    } catch (error) {
      if ((state as TunnelState).status === "closed") return;
      logger.warn("tunnel reconnect failed", { error: (error as Error).message });
      scheduleRetry((error as Error).message);
    }
  };

  return {
    get state() {
      return state;
    },
    async start() {
      try {
        return await attempt();
      } catch (error) {
        const message = (error as Error).message;
        logger.warn("tunnel failed to open", { error: message });
        // The caller retries a first open; only a tunnel that was up reconnects by itself.
        set({ status: "down", error: message, retryInMs: 0 });
        throw error;
      }
    },
    onState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    wake() {
      if (state.status === "closed" || state.status === "starting") return;
      clearTimeout(retryTimer);
      logger.info("tunnel woken", { was: state.status });
      void reconnect();
    },
    close() {
      clearTimeout(retryTimer);
      generation += 1;
      set({ status: "closed" });
      child?.kill("SIGTERM");
      child = null;
    },
  };
}
