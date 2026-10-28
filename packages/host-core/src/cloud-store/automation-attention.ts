/**
 * "An unattended Run needs you", for a cloud Automation Run's Session
 * (VC-133's rule, `automations/run-attention.ts`, over the cloud's records).
 *
 * The rule is the local one, reused rather than copied: only an EDGE into
 * `waiting` or `error`, only for a Session whose Run was unattended, and a
 * first sighting after a relaunch seeds silently. What differs is where the
 * facts and the alert live:
 *
 * - **Attendance.** A cloud Run writes no local Run row. The executor notes
 *   the Run's attendance beside the Session it started (`track`), runner-local
 *   (`volli:runner-automation-run:` in `app_state`), so a later edge, even
 *   after a relaunch, knows whether a person was at the door.
 * - **The alert.** The person who armed the Run may be anywhere, so the edge
 *   raises a Needs-you item in Volli Cloud for the Session's owner
 *   (`attention.raiseFromRunner`, under this runner's claim), and still posts
 *   this Mac's notification through the one delivery path, as locally.
 *
 * Folding is per tracked Session only, on a short coalescing timer off the
 * post-commit wake bus. Like every observer bolted onto the write path,
 * nothing here can fail the write that woke it: failures are logged.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import type { SessionEngine } from "@volli/session-engine";
import type { AutomationRunAttendance, NotificationRequest } from "@volli/shared";

import { getAppState, setAppState } from "../db/app-state-repo";
import { createRunAttentionWatch } from "../automations/run-attention";
import type { SubscribeSessionWake } from "../session-control/session-wake";
import { hostLogger } from "../log/root";

const log = hostLogger("cloud-run-attention");

/** How long a burst of Session writes is coalesced into one fold. */
export const CLOUD_RUN_ATTENTION_FOLD_MS = 250;
/** Raise retries: the Session's first accept may still be in flight, or the link down. */
export const CLOUD_RUN_ATTENTION_RETRY_MS = [5_000, 30_000, 120_000] as const;

export interface CloudRunAttentionOptions {
  db: Database.Database;
  ownerUserId: string;
  /** The owner-scoped engine. */
  engine: Pick<SessionEngine, "getSession">;
  subscribe: SubscribeSessionWake;
  /** `attention.raiseFromRunner` for this Session, under this runner's claim. */
  raise(
    sessionId: string,
    args: { notifyId: string; title: string; detail: string },
  ): Promise<unknown>;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  newId?(): string;
}

export interface CloudRunAttention {
  /** The executor started (or resumed) this Run's Session. `fresh`: minted just now. */
  track(input: { sessionId: string; attendance: AutomationRunAttendance; fresh: boolean }): void;
  /** This Mac's notification delivery, once the runtime has composed it. */
  bindLocal(notify: (request: NotificationRequest) => void): void;
  dispose(): void;
}

export function createCloudRunAttention(options: CloudRunAttentionOptions): CloudRunAttention {
  const setTimer =
    options.setTimer ??
    ((run: () => void, ms: number) => {
      const handle = setTimeout(run, ms);
      handle.unref?.();
      return handle;
    });
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const newId = options.newId ?? randomUUID;
  const key = (sessionId: string) =>
    `volli:runner-automation-run:${options.ownerUserId}:${sessionId}` as const;
  /** `null`: looked up, and no Run of this runner opened it. */
  const attendance = new Map<string, AutomationRunAttendance | null>();
  const folds = new Map<string, unknown>();
  const timers = new Set<unknown>();
  let local: ((request: NotificationRequest) => void) | null = null;
  let disposed = false;

  function attendanceOf(sessionId: string): AutomationRunAttendance | null {
    const known = attendance.get(sessionId);
    if (known !== undefined) return known;
    const stored = getAppState(options.db, key(sessionId));
    const value = stored === "attended" || stored === "unattended" ? stored : null;
    attendance.set(sessionId, value);
    return value;
  }

  function raise(sessionId: string, args: { notifyId: string; title: string; detail: string }) {
    const attempt = (index: number): void => {
      if (disposed) return;
      options.raise(sessionId, args).catch((error: unknown) => {
        const delay = CLOUD_RUN_ATTENTION_RETRY_MS[index];
        if (delay === undefined || disposed) {
          log.warn("Automation Run attention was not raised in Volli Cloud", { sessionId, error });
          return;
        }
        const timer = setTimer(() => {
          timers.delete(timer);
          attempt(index + 1);
        }, delay);
        timers.add(timer);
      });
    };
    attempt(0);
  }

  const watch = createRunAttentionWatch({
    attendanceOf,
    notify(request) {
      const target = request.target;
      if (target?.kind === "session")
        // One id per edge, kept across retries, so a retry is the same item.
        raise(target.sessionId, {
          notifyId: newId(),
          title: request.title,
          detail: request.body,
        });
      try {
        local?.(request);
      } catch (error) {
        log.warn("Automation Run notification failed", { error });
      }
    },
    onError: (error) => log.warn("Automation Run attention failed", { error }),
  });

  async function fold(sessionId: string): Promise<void> {
    folds.delete(sessionId);
    if (disposed) return;
    try {
      const projection = await options.engine.getSession({ sessionId });
      if (projection !== null) watch.observe(projection);
    } catch (error) {
      log.warn("Automation Run Session could not be folded", { sessionId, error });
    }
  }

  const unsubscribe = options.subscribe(({ event }) => {
    const sessionId = event.sessionId;
    if (disposed || folds.has(sessionId) || attendanceOf(sessionId) === null) return;
    folds.set(
      sessionId,
      setTimer(() => void fold(sessionId), CLOUD_RUN_ATTENTION_FOLD_MS),
    );
  });

  return {
    track({ sessionId, attendance: value, fresh }) {
      if (attendance.get(sessionId) !== value) {
        setAppState(options.db, key(sessionId), value, Date.now());
        attendance.set(sessionId, value);
      }
      // Only a Session minted just now has a known baseline of "needs nobody".
      if (fresh) watch.observeBirth(sessionId);
    },
    bindLocal(notify) {
      local = notify;
    },
    dispose() {
      disposed = true;
      unsubscribe();
      for (const timer of folds.values()) clearTimer(timer);
      for (const timer of timers) clearTimer(timer);
      folds.clear();
      timers.clear();
    },
  };
}
