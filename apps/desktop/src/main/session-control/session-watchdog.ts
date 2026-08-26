/**
 * The session watchdog's host half (VC-86): a periodic scan over the executors
 * THIS process holds open, acting on the pure wedge verdict in
 * `@volli/shared`'s `sessionWedge`.
 *
 * ── WHY A SCAN AND NOT A SUBSCRIPTION ─────────────────────────────────────
 * `activity-watch.ts` decorates the engine and sees every durable write; a
 * wedge is the ABSENCE of writes, which no write-side observer can notice.
 * The complement of a push channel is a clock, so this is one: every interval
 * it asks the runtime which native bindings are open — the exact "an executor
 * lives here" list, not a guess from projections — and reads each Session's
 * durable projection for the verdict.
 *
 * ── WHAT A TRIP DOES ──────────────────────────────────────────────────────
 * Observe first (the enforcement-posture precedent): one durable `blocked`
 * signal on the Session naming the watchdog and the silence window, and one
 * notification for the person. Self-termination exists behind the optional
 * `stopSession` port and ships UNWIRED — a watchdog that kills by default
 * would turn its own false positive into the wedge it exists to catch.
 *
 * One trip per wedge EPISODE: the episode is keyed by the `lastActivityAt`
 * the silence is measured from, so a Session that recovers and wedges again
 * self-reports again, while a scan that comes around during the same silence
 * does not repeat itself. The durable command id carries the same key, so
 * even a restarted host re-tripping the same episode lands on the same
 * command rather than minting a second.
 *
 * Failures are swallowed with a diagnostic, never propagated — this is an
 * observer beside the runtime, and a scan that throws must not be able to
 * take the host down with it.
 */

import { DEFAULT_SESSION_WATCHDOG_SILENCE_MS, sessionWedge, shortSessionId } from "@volli/shared";
import type { SessionProjection } from "@volli/shared";
import type { SessionEngine } from "@volli/session-engine";

/** How often the scan runs. Coarse on purpose: the verdict is minutes-grained. */
const DEFAULT_SCAN_INTERVAL_MS = 60_000;

export interface SessionWatchdogPorts {
  /** The executors this process holds open — the runtime's own binding list. */
  listBindings(): readonly { sessionId: string }[];
  /** One Session's durable projection; the verdict reads only durable facts. */
  projection(sessionId: string): Promise<SessionProjection>;
  /** The durable door the blocked signal goes through. */
  submit: SessionEngine["submit"];
  /** The person's channel. Absent means no notification is raised. */
  notify?: (input: { title: string; body: string }) => void;
  /**
   * Self-termination, deliberately optional and shipped unwired: when
   * present, a trip stops the Session after recording its signal. The port
   * carries the acts; the policy that enables it is the caller's.
   */
  stopSession?: (input: { sessionId: string; silentForMs: number }) => Promise<void>;
  thresholdMs?: number;
  intervalMs?: number;
  now?: () => number;
  /** Diagnostics seam. Defaults to `console.error`. */
  onError?: (error: unknown) => void;
}

export interface SessionWatchdog {
  start(): void;
  stop(): void;
  /** One scan now, awaited. The interval calls this; tests drive it directly. */
  scan(): Promise<void>;
}

export function createSessionWatchdog(ports: SessionWatchdogPorts): SessionWatchdog {
  const thresholdMs = ports.thresholdMs ?? DEFAULT_SESSION_WATCHDOG_SILENCE_MS;
  const intervalMs = ports.intervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
  const now = ports.now ?? (() => Date.now());
  const onError =
    ports.onError ?? ((error: unknown) => console.error("[volli] session watchdog:", error));
  /** The episode each Session last tripped on: the lastActivityAt it was silent from. */
  const tripped = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null;

  async function inspect(sessionId: string): Promise<void> {
    const projection = await ports.projection(sessionId);
    const verdict = sessionWedge(projection, now(), thresholdMs);
    if (!verdict.wedged) {
      // Recovery ends the episode; the next wedge is a new lastActivityAt and
      // reports itself afresh.
      if (verdict.reason === "active" || verdict.reason === "no-turn") {
        tripped.delete(sessionId);
      }
      return;
    }
    const episode = projection.lastActivityAt;
    if (tripped.get(sessionId) === episode) return;
    tripped.set(sessionId, episode);
    const minutes = Math.round(verdict.silentForMs / 60_000);
    await ports.submit({
      // Deterministic across restarts: the same episode re-tripped lands on
      // the same durable command instead of minting a second.
      commandId: `watchdog:${sessionId}:${episode}`,
      sessionId,
      intent: {
        kind: "session.signal",
        signal: "blocked",
        reason: `Watchdog: no activity for ${minutes}m inside an open turn.`,
      },
      provenance: {
        source: { kind: "system", id: "session-watchdog", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });
    ports.notify?.({
      title: "Session may be wedged",
      body: `${projection.session.title ?? `Session ${shortSessionId(sessionId)}`} has an open turn with no activity for ${minutes}m.`,
    });
    if (ports.stopSession !== undefined) {
      await ports.stopSession({ sessionId, silentForMs: verdict.silentForMs });
    }
  }

  async function scan(): Promise<void> {
    for (const binding of ports.listBindings()) {
      try {
        await inspect(binding.sessionId);
      } catch (error) {
        onError(error);
      }
    }
  }

  return {
    start() {
      if (timer !== null) return;
      timer = setInterval(() => void scan().catch(onError), intervalMs);
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    scan,
  };
}
