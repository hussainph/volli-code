/**
 * The one budget every backend mutation on a runner's connection shares.
 *
 * Convex closes a WebSocket that holds more than 1,000 pending mutations and
 * the stock client then reconnects in a loop; throughput already plateaus
 * at about 32 in flight. So everything a runner sends — Session facts,
 * stream chunks, heartbeats, job calls — waits here for one of at most
 * {@link MUTATION_GATE_LIMITS.maxInFlight} slots, and for room in a byte
 * budget, before it reaches the client. A single call larger than the byte
 * budget is sent alone.
 *
 * Waiting calls are served by priority, then in arrival order:
 * `control` (heartbeats, state, job calls) before `live` (chunks and the
 * facts of a turn in progress) before `backlog` (catching up after an
 * outage). A lane never starves the lanes above it.
 */

export const MUTATION_PRIORITIES = ["control", "live", "backlog"] as const;
export type MutationPriority = (typeof MUTATION_PRIORITIES)[number];

export const MUTATION_GATE_LIMITS = { maxInFlight: 32, maxBytes: 256 * 1024 } as const;

export interface MutationGate {
  /** Runs `send` once a slot (and `bytes` of budget) is free; the slot is held until it settles. */
  run<T>(priority: MutationPriority, bytes: number, send: () => Promise<T>): Promise<T>;
  readonly inFlight: number;
  readonly inFlightBytes: number;
  readonly waiting: number;
}

interface Waiter {
  bytes: number;
  start(): void;
}

export function createMutationGate(
  limits: { maxInFlight: number; maxBytes: number } = MUTATION_GATE_LIMITS,
): MutationGate {
  const lanes: Record<MutationPriority, Waiter[]> = { control: [], live: [], backlog: [] };
  let inFlight = 0;
  let inFlightBytes = 0;

  const fits = (bytes: number) =>
    inFlight < limits.maxInFlight &&
    // One call over the whole budget still goes, alone.
    (inFlightBytes + bytes <= limits.maxBytes || inFlight === 0);

  function pump() {
    for (const priority of MUTATION_PRIORITIES) {
      const lane = lanes[priority];
      while (lane.length > 0 && fits(lane[0]!.bytes)) lane.shift()!.start();
      // A lane that cannot fit its head blocks the lanes below it. Higher
      // lanes always go first, so a caller that needs its calls in order
      // keeps them in one lane (the drain does, per Session).
      if (lane.length > 0) return;
    }
  }

  return {
    get inFlight() {
      return inFlight;
    },
    get inFlightBytes() {
      return inFlightBytes;
    },
    get waiting() {
      return MUTATION_PRIORITIES.reduce((sum, priority) => sum + lanes[priority].length, 0);
    },
    run(priority, bytes, send) {
      return new Promise((resolve, reject) => {
        lanes[priority].push({
          bytes,
          start() {
            inFlight += 1;
            inFlightBytes += bytes;
            const settle = () => {
              inFlight -= 1;
              inFlightBytes -= bytes;
              pump();
            };
            let pending: Promise<unknown>;
            try {
              pending = send();
            } catch (error) {
              pending = Promise.reject(error);
            }
            pending.then(
              (value) => {
                settle();
                resolve(value as never);
              },
              (error: unknown) => {
                settle();
                reject(error);
              },
            );
          },
        });
        pump();
      });
    },
  };
}
