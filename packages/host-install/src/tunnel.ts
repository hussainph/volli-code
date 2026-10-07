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
 * - **It owns its ssh processes, all of them.** `start()` is single-flight;
 *   every await in a setup checks it was not superseded or closed (a closed
 *   tunnel spawns nothing more); every child is tracked until it exits, and
 *   reaped with SIGTERM, then SIGKILL if it lingers (`killAfterMs`).
 *   `ForkAfterAuthentication=no` (OpenSSH 8.7+) keeps the person's config
 *   from daemonizing ssh out of that ownership.
 */
import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { createConnection, createServer } from "node:net";

import type { ListenAddress } from "./contract";
import type { InstallLogger } from "./logger";
import {
  classifySshFailure,
  exitsWithin,
  KILL_WAIT_MS,
  type SpawnProcess,
  type SshFailure,
} from "./ssh";
import { targetArgs, type SshTarget } from "./target";

export type TunnelState =
  | { readonly status: "starting" }
  | { readonly status: "up"; readonly url: string; readonly localPort: number }
  | {
      readonly status: "down";
      readonly error: string;
      readonly retryInMs: number;
      readonly sshFailure?: SshFailure;
    }
  | { readonly status: "closed" };

export interface TunnelTiming {
  readonly readyTimeoutMs: number;
  readonly pollMs: number;
  readonly backoffMinMs: number;
  readonly backoffMaxMs: number;
  /** How long an ssh process has to exit after SIGTERM before SIGKILL. */
  readonly killAfterMs: number;
}

export const DEFAULT_TUNNEL_TIMING: TunnelTiming = {
  readyTimeoutMs: 20_000,
  pollMs: 100,
  backoffMinMs: 1_000,
  backoffMaxMs: 30_000,
  killAfterMs: 2_000,
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
  /**
   * Opens the tunnel; resolves with the URL once it carries, or rejects with
   * why not. Callers while it opens share the one attempt; once up, the URL.
   * Rejects once `close()` is called, before or during it.
   */
  start(): Promise<string>;
  readonly state: TunnelState;
  onState(listener: (state: TunnelState) => void): () => void;
  /** After sleep or a network change: reconnect now, not after backoff or a dead-peer timeout. */
  wake(): void;
  /** Stops it for good: cancels a pending open and reaps every ssh process it started. */
  close(): void;
  /**
   * Past a deadline: closes it, SIGKILLs every ssh process it still owns at
   * once, and resolves once they have exited (or a short wait has run out).
   * Optional: a tunnel with no processes need not have it.
   */
  kill?(): Promise<void>;
}

/** Why a superseded or closed setup stopped: not a failure of the tunnel. */
class Cancelled extends Error {}

class TunnelFailure extends Error {
  constructor(
    message: string,
    readonly sshFailure: SshFailure | null,
  ) {
    super(message);
  }
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

/**
 * The ssh arguments for one tunnel process. A `-o` here wins over the
 * person's config (ssh takes each option's first value, the command line's
 * first).
 *
 * Not `ClearAllForwardings=yes`: ssh_config(5) has it clear forwardings
 * "specified in the configuration files or on the command line", and
 * readconf.c's `clear_forwardings` empties the one list our `-L` is in too,
 * so it would drop this tunnel's own forward. Config-file forwards cannot be
 * removed alone; `GatewayPorts=no` keeps any to loopback, `Tunnel=no` drops a
 * configured tun device, and `ExitOnForwardFailure=yes` fails loudly when one
 * cannot bind rather than run half-forwarded.
 */
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
      // Stay this process's child: never backgrounded by a config's ForkAfterAuthentication.
      "ForkAfterAuthentication=no",
      "ForwardAgent=no",
      "ForwardX11=no",
      "GatewayPorts=no",
      "Tunnel=no",
      "PermitLocalCommand=no",
      "RemoteCommand=none",
      "RequestTTY=no",
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
  let closed = false;
  let localPort: number | null = null;
  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by every attempt and by close: an older setup that sees it changed stops. */
  let generation = 0;
  /** The one attempt in flight, shared by every caller. */
  let attempting: Promise<string> | null = null;
  let opening: Promise<string> | null = null;
  /** Every ssh process this tunnel started and has not yet seen exit, and its SIGKILL timer. */
  const owned = new Map<ChildProcess, ReturnType<typeof setTimeout> | undefined>();

  const set = (next: TunnelState): void => {
    state = next;
    for (const listener of listeners) listener(next);
  };

  const own = (child: ChildProcess): void => {
    owned.set(child, undefined);
    const gone = (): void => {
      clearTimeout(owned.get(child));
      owned.delete(child);
    };
    child.once("exit", gone);
    child.once("close", gone);
    // One that never spawned, or that a signal can no longer reach, has nothing to reap.
    child.once("error", gone);
  };

  /** SIGTERM now; SIGKILL if it has not exited `killAfterMs` later. */
  const reap = (child: ChildProcess): void => {
    if (!owned.has(child) || owned.get(child) !== undefined) return;
    child.kill("SIGTERM");
    // Cleared when it exits.
    const timer = setTimeout(() => {
      logger.warn("tunnel process ignored SIGTERM; killing it", { pid: child.pid });
      child.kill("SIGKILL");
    }, timing.killAfterMs);
    timer.unref();
    owned.set(child, timer);
  };

  const reapAll = (): void => {
    for (const child of owned.keys()) reap(child);
  };

  /** One attempt: spawn, wait for the local end to carry, or for the process to die. */
  const attempt = async (): Promise<string> => {
    const mine = ++generation;
    // close() bumps the generation too.
    const current = (): void => {
      if (mine !== generation) throw new Cancelled("The tunnel was closed");
    };
    set({ status: "starting" });
    const remote = await options.resolveRemote();
    current();
    if (localPort === null) {
      const port = await freePort();
      current();
      localPort = port;
    }
    const port = localPort;
    const process = spawn(options.sshPath ?? "ssh", tunnelArgs(options.target, port, remote));
    own(process);
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
      exited ??= code ?? 255;
      if (mine !== generation) return;
      if (state.status === "up") {
        logger.warn("tunnel dropped", {
          localPort: port,
          code: exited,
          detail: stderr.trim().slice(-300),
        });
        scheduleRetry(
          stderr || `ssh exited ${exited}`,
          classifySshFailure({ code: exited, stdout: "", stderr }),
        );
      }
    });
    const deadline = Date.now() + timing.readyTimeoutMs;
    try {
      for (;;) {
        if (exited !== null) {
          if (/Address already in use|cannot listen to port/u.test(stderr)) localPort = null;
          const failure = classifySshFailure({ code: exited, stdout: "", stderr });
          throw new TunnelFailure(failure?.detail || `ssh exited ${exited}`, failure);
        }
        const carries = await accepts(port);
        current();
        if (carries) break;
        if (Date.now() >= deadline) {
          throw new Error(`The tunnel did not open within ${timing.readyTimeoutMs / 1000} s`);
        }
        await new Promise((resolve) => setTimeout(resolve, timing.pollMs));
        current();
      }
    } catch (error) {
      reap(process);
      throw error;
    }
    failures = 0;
    const url = `ws://127.0.0.1:${port}`;
    logger.info("tunnel up", { localPort: port, remotePort: remote.port });
    set({ status: "up", url, localPort: port });
    return url;
  };

  /** The attempt in flight, or a new one. */
  const begin = (): Promise<string> => {
    if (attempting !== null) return attempting;
    const run = attempt();
    attempting = run;
    // Registered before any caller's, so a caller retrying at once starts afresh.
    const done = (): void => {
      attempting = null;
    };
    run.then(done, done);
    return run;
  };

  const scheduleRetry = (error: string, sshFailure: SshFailure | null = null): void => {
    failures += 1;
    const retryInMs = Math.min(timing.backoffMaxMs, timing.backoffMinMs * 2 ** (failures - 1));
    set({
      status: "down",
      error: error.trim().slice(-300),
      retryInMs,
      ...(sshFailure === null ? {} : { sshFailure }),
    });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => void reconnect(), retryInMs);
  };

  /** Joins a setup already under way, its process kept; else reaps what lingers and begins one. */
  const fresh = (): Promise<string> => {
    clearTimeout(retryTimer);
    if (attempting === null) reapAll();
    return begin();
  };

  const reconnect = async (): Promise<void> => {
    try {
      await fresh();
    } catch (error) {
      if (closed) return;
      logger.warn("tunnel reconnect failed", { error: (error as Error).message });
      scheduleRetry(
        (error as Error).message,
        error instanceof TunnelFailure ? error.sshFailure : null,
      );
    }
  };

  const open = async (): Promise<string> => {
    try {
      return await fresh();
    } catch (error) {
      if (closed) throw new Cancelled("The tunnel was closed");
      const message = (error as Error).message;
      logger.warn("tunnel failed to open", { error: message });
      // The caller retries a first open; only a tunnel that was up reconnects by itself.
      set({
        status: "down",
        error: message,
        retryInMs: 0,
        ...(error instanceof TunnelFailure && error.sshFailure !== null
          ? { sshFailure: error.sshFailure }
          : {}),
      });
      throw error;
    }
  };

  const close = (): void => {
    clearTimeout(retryTimer);
    closed = true;
    generation += 1;
    set({ status: "closed" });
    reapAll();
  };

  return {
    get state() {
      return state;
    },
    start() {
      if (closed) return Promise.reject(new Cancelled("The tunnel was closed"));
      if (state.status === "up") return Promise.resolve(state.url);
      if (opening === null) {
        const run = open();
        opening = run;
        const done = (): void => {
          opening = null;
        };
        run.then(done, done);
      }
      return opening;
    },
    onState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    wake() {
      if (closed || state.status === "starting") return;
      clearTimeout(retryTimer);
      logger.info("tunnel woken", { was: state.status });
      void reconnect();
    },
    close,
    async kill() {
      if (!closed) close();
      const left = [...owned.keys()];
      if (left.length === 0) return;
      logger.warn("tunnel processes still running past the deadline; killing them", {
        processes: left.length,
      });
      for (const child of left) child.kill("SIGKILL");
      await exitsWithin(left, KILL_WAIT_MS);
    },
  };
}
