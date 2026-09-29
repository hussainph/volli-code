/**
 * A per-server bound on MCP calls, shared by every Session that reaches the
 * server (VC-454).
 *
 * The desktop host opens one protocol client per Session attachment, so
 * nothing below this module sees two Sessions calling the same server at
 * once. This wrapper does: one {@link McpServerBudget} per process, keyed by
 * the server's identity, and every attachment's {@link RuntimeMcpPort} bound
 * through it. A call over budget waits in a first-in, first-out queue rather
 * than failing, and a queued call can still be withdrawn by its own signal.
 *
 * It depends on nothing but the port contract in `@volli/shared`, so a host
 * that is not the Electron app — a future server — can put the same bound in
 * front of whatever answers its MCP calls.
 *
 * What it will not do is retry. A call is handed to the port exactly once;
 * whatever the port answers, including a failure, is the answer. Retrying an
 * MCP call is only safe for an exact tool someone has audited as idempotent,
 * and then only under an operation id derived from the Session and the tool
 * call, neither of which this layer invents.
 *
 * The limits are host-authored. Nothing a server advertises — its
 * description, its annotations, a rate-limit header — sets or raises them.
 *
 * Both bounds hold at the SERVER, not merely here, whatever the network does
 * to a request on its way. In-flight: a server finishes a call before its
 * answer arrives, so it never has more running than this budget does. Starts:
 * each start is counted until `windowMs` after its call SETTLES rather than
 * after it began. A server has certainly received a call by the time it has
 * answered it, so however late a request reached it, no window of `windowMs`
 * the server measures its arrivals in can hold more than `maxStarts` of them.
 * Counting from the start instead would admit call N+1 exactly `windowMs`
 * after call 1 left, and a server that received call 1 a millisecond late
 * would see both inside one window. The price is throughput: one call's
 * latency on top of every window.
 */
import type { RuntimeMcpCall, RuntimeMcpCallResult, RuntimeMcpPort } from "@volli/shared";

/** How much of one MCP server every Session together may use. */
export interface McpServerLimits {
  /** Calls to the server in flight at once. */
  maxConcurrent: number;
  /**
   * Calls allowed to start in any rolling `windowMs`. `Infinity` bounds
   * concurrency alone.
   */
  maxStarts: number;
  windowMs: number;
}

/**
 * What a server gets when the host has said nothing about it.
 *
 * Ordinary Sessions dispatch one tool at a time, so these bind only when
 * several Sessions reach the same server at once, or when one opted-in Session
 * fans a batch out; either way the excess waits rather than failing. A server
 * with a tighter published limit needs its own host-authored entry.
 */
export const DEFAULT_MCP_SERVER_LIMITS: McpServerLimits = Object.freeze({
  maxConcurrent: 8,
  maxStarts: 32,
  windowMs: 1_000,
});

/** One server's load as the budget sees it. */
export interface McpServerLoad {
  /** Calls holding a slot now. */
  active: number;
  /** Calls waiting for one. */
  queued: number;
  /** The most calls that ever held a slot at once. */
  peakActive: number;
  /** Calls admitted over the budget's life. */
  admitted: number;
}

/** A port bound through the budget, with the attachment's own lifetime. */
export interface BoundMcpPort extends RuntimeMcpPort {
  /**
   * Withdraw every call this binding has queued or in flight, and refuse new
   * ones. Other bindings' calls to the same servers are untouched.
   */
  close(reason?: unknown): void;
}

export interface McpServerBudgetOptions {
  /** Host-authored limits for one server; absent means the defaults. */
  limitsFor?: (serverId: string) => McpServerLimits | undefined;
  /** Monotonic milliseconds. */
  now?: () => number;
}

interface Waiter {
  admit: (slot: StartSlot | undefined) => void;
}

/** One counted start; `Infinity` until its call settles. */
interface StartSlot {
  expiresAt: number;
}

interface Lane {
  readonly limits: McpServerLimits;
  active: number;
  peakActive: number;
  admitted: number;
  /** Starts still counted against the window, in admission order. */
  slots: StartSlot[];
  readonly queue: Waiter[];
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** `limits`, frozen, or a thrown error naming the field a host got wrong. */
export function validateMcpServerLimits(limits: McpServerLimits): McpServerLimits {
  const { maxConcurrent, maxStarts, windowMs } = limits;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error("MCP server maxConcurrent must be a positive integer.");
  }
  if (maxStarts !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxStarts) || maxStarts < 1)) {
    throw new Error("MCP server maxStarts must be a positive integer or Infinity.");
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error("MCP server windowMs must be a positive number.");
  }
  return Object.freeze({ maxConcurrent, maxStarts, windowMs });
}

export class McpServerBudget {
  readonly #lanes = new Map<string, Lane>();
  readonly #limitsFor: (serverId: string) => McpServerLimits | undefined;
  readonly #now: () => number;

  constructor(options: McpServerBudgetOptions = {}) {
    this.#limitsFor = options.limitsFor ?? (() => undefined);
    this.#now = options.now ?? (() => performance.now());
  }

  /** Put `port` behind this budget for one attachment. */
  bind(port: RuntimeMcpPort): BoundMcpPort {
    const lifetime = new AbortController();
    return {
      call: async (request: RuntimeMcpCall, signal: AbortSignal): Promise<RuntimeMcpCallResult> => {
        const combined = AbortSignal.any([signal, lifetime.signal]);
        combined.throwIfAborted();
        const release = await this.#acquire(request.serverId, combined);
        try {
          return await port.call(request, combined);
        } finally {
          release();
        }
      },
      close: (reason?: unknown) => {
        lifetime.abort(reason ?? new Error("MCP attachment closed"));
      },
    };
  }

  load(serverId: string): McpServerLoad {
    const lane = this.#lanes.get(serverId);
    return {
      active: lane?.active ?? 0,
      queued: lane?.queue.length ?? 0,
      peakActive: lane?.peakActive ?? 0,
      admitted: lane?.admitted ?? 0,
    };
  }

  #lane(serverId: string): Lane {
    let lane = this.#lanes.get(serverId);
    if (lane === undefined) {
      lane = {
        limits: validateMcpServerLimits(this.#limitsFor(serverId) ?? DEFAULT_MCP_SERVER_LIMITS),
        active: 0,
        peakActive: 0,
        admitted: 0,
        slots: [],
        queue: [],
        timer: undefined,
      };
      this.#lanes.set(serverId, lane);
    }
    return lane;
  }

  /**
   * Resolves with the slot's release once the call may start. The one caller
   * releases it exactly once, from a `finally`.
   */
  #acquire(serverId: string, signal: AbortSignal): Promise<() => void> {
    const lane = this.#lane(serverId);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        admit: (slot) => {
          signal.removeEventListener("abort", withdraw);
          resolve(() => {
            lane.active -= 1;
            if (slot !== undefined) slot.expiresAt = this.#now() + lane.limits.windowMs;
            this.#pump(lane);
          });
        },
      };
      // Runs only while the waiter is queued: admission removes this listener
      // before it resolves, so the waiter is always found.
      const withdraw = (): void => {
        lane.queue.splice(lane.queue.indexOf(waiter), 1);
        this.#pump(lane);
        reject(signal.reason);
      };
      signal.addEventListener("abort", withdraw, { once: true });
      lane.queue.push(waiter);
      this.#pump(lane);
    });
  }

  /** Admit waiters in order while the lane has room, else wait for the window. */
  #pump(lane: Lane): void {
    const now = this.#now();
    const { maxConcurrent, maxStarts } = lane.limits;
    const rated = maxStarts !== Number.POSITIVE_INFINITY;
    lane.slots = lane.slots.filter((slot) => slot.expiresAt > now);
    while (lane.queue.length > 0 && lane.active < maxConcurrent && lane.slots.length < maxStarts) {
      const waiter = lane.queue.shift()!;
      lane.active += 1;
      lane.admitted += 1;
      lane.peakActive = Math.max(lane.peakActive, lane.active);
      const slot = rated ? { expiresAt: Number.POSITIVE_INFINITY } : undefined;
      if (slot !== undefined) lane.slots.push(slot);
      waiter.admit(slot);
    }
    if (lane.timer !== undefined) {
      clearTimeout(lane.timer);
      lane.timer = undefined;
    }
    // Blocked by the window with a slot that will expire on its own: nothing
    // else would wake the queue, so that slot's expiry has to. A window held
    // only by calls still running is woken by their release instead.
    const nextExpiry = lane.slots.reduce(
      (soonest, slot) => Math.min(soonest, slot.expiresAt),
      Number.POSITIVE_INFINITY,
    );
    if (lane.queue.length > 0 && lane.active < maxConcurrent && Number.isFinite(nextExpiry)) {
      lane.timer = setTimeout(() => {
        lane.timer = undefined;
        this.#pump(lane);
      }, nextExpiry - now);
    }
  }
}
