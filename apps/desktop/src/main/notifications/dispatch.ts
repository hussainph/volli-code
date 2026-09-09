/**
 * The one door every native alert in this app goes through (VC-295).
 *
 * ── WHY ONE DOOR ──────────────────────────────────────────────────────────
 * Before this, six places in main constructed `new Notification({title, body})`
 * and called `show()`. Exactly one of them consulted the preferences. That is
 * not a discipline problem to be solved by a comment: a call site that takes a
 * title and a body has no way to be wrong, so nothing ever failed.
 *
 * So the shape is the rule. {@link NotificationRequest} takes a
 * {@link NotificationProducer} instead of free words, this module is the only
 * thing that constructs an alert, and the preference check happens HERE. A new
 * producer cannot skip `notificationAllowed`, because a new producer cannot
 * reach `new Notification` — it can only reach {@link NotificationDispatcher}.
 *
 * ── AND WHY THE TARGET IS IN THE TYPE ─────────────────────────────────────
 * The request union is split by whether the producer knows where its alert
 * points. A Run's attention alert MUST carry a Session target; `volli notify`
 * MUST carry `null`. That is a compile error rather than a review comment,
 * which matters because the failure it prevents is invisible: an alert that
 * opens nothing looks exactly like an alert that opens the right thing until
 * somebody clicks it.
 *
 * ── THE THREE REASONS AN ALERT IS NOT POSTED ──────────────────────────────
 *  1. `muted` — this machine's preferences say no. Operational producers can
 *     never land here (see the catalog); they are faults and instructions,
 *     not tastes.
 *  2. `unsupported` — `Notification.isSupported()` is false. Settings shows
 *     this, because it is the one delivery fact Electron will actually answer.
 *  3. `focused-target` — the exact target is already in front of the person in
 *     a focused window, so the renderer owns the feedback. Narrow by
 *     construction: the ports answer with FOCUSED windows only, and identity is
 *     `notificationTargetMatches`, which never matches across kinds.
 *
 * A fourth, `failed`, is the alert we tried to post and could not — a throw out
 * of Electron. Every failure here is swallowed and reported through `onError`:
 * this sits on write paths and background passes (a durable command, a
 * retention poll, a watchdog scan), and a notification must never be able to
 * fail the work that raised it.
 *
 * ── WHY THE HANDLE IS RETAINED ────────────────────────────────────────────
 * Electron's `Notification` is a `NativeImage`-style object whose events fire
 * long after `show()` returns; dropping the reference lets it be collected
 * before the person clicks, and the click then does nothing. So each live alert
 * is held until it closes, is clicked, or fails.
 */
import {
  notificationProducerAllowed,
  notificationTargetMatches,
  type NotificationPreferences,
  type NotificationProducer,
  type NotificationTarget,
  type SessionNotificationTarget,
  type TicketNotificationTarget,
  type UpdateNotificationTarget,
} from "@volli/shared";

/**
 * The one KIND of target each producer can have.
 *
 * A total record, so a new producer must say where its alert points before it
 * compiles — and a producer cannot be given the wrong sort of target. Round 1
 * only distinguished "has a target" from "has none", which left a harness alert
 * free to carry a ticket target: a deep link that opens the board instead of the
 * terminal that is waiting, and nothing to catch it.
 *
 * `null` is not an oversight where it appears. A free-form `volli notify` and a
 * dead CLI socket have nowhere to point, and an invented destination is worse
 * than none — it spends the interruption and takes the person somewhere
 * unrelated.
 */
export interface NotificationProducerTargets {
  "run-attention": SessionNotificationTarget;
  "session-watchdog": SessionNotificationTarget;
  "harness-input-needed": SessionNotificationTarget;
  "pull-request-merged": TicketNotificationTarget;
  "worktree-reclaimed": TicketNotificationTarget;
  "worktree-record-failed": TicketNotificationTarget;
  "ticket-moved-to-doing": TicketNotificationTarget;
  "update-ready": UpdateNotificationTarget;
  "agent-notify": null;
  "cli-socket-failed": null;
}

/**
 * The producers whose alert always knows where it points — derived from the
 * table above rather than listed again, so the two cannot disagree.
 */
export type TargetedNotificationProducer = {
  [P in NotificationProducer]: NotificationProducerTargets[P] extends null ? never : P;
}[NotificationProducer];

/** One alert, as its producer describes it. */
export type NotificationRequest = {
  [P in NotificationProducer]: {
    producer: P;
    title: string;
    body: string;
    target: NotificationProducerTargets[P];
  };
}[NotificationProducer];

/**
 * The Electron `Notification` surface this module uses, and nothing more.
 *
 * A port rather than the class itself for two reasons: main's own tests must
 * never post an OS alert, and the five signals below are the whole of what
 * Electron reliably offers here (VC-295 rule 4 — there is no permission read
 * among them, which is why Settings does not claim one; `show` says the OS
 * took the alert, not that anyone was allowed to see it).
 */
export interface NativeAlert {
  onClick(listener: () => void): void;
  onClose(listener: () => void): void;
  /** The OS took it: Electron's `show` event, which fires after `show()` lands. */
  onShow(listener: () => void): void;
  onFailed(listener: (message: string) => void): void;
  show(): void;
  close(): void;
}

export interface NotificationDispatchPorts {
  /** This machine's answer, re-read per alert so a switch takes effect at once. */
  preferences(): NotificationPreferences;
  /** `Notification.isSupported()`. */
  supported(): boolean;
  /**
   * What FOCUSED windows are showing right now. Only focused ones: an open but
   * inactive window, or another workspace, must not suppress anything.
   */
  focusedTargets(): readonly (NotificationTarget | null)[];
  /** Mints the native alert. The only place Electron is touched. */
  create(input: { title: string; body: string }): NativeAlert;
  /** A click. `null` means bring Volli forward without routing anywhere. */
  activate(target: NotificationTarget | null): void;
  /** Electron reported the OS did not deliver it — Settings shows the latest. */
  onDeliveryFailure(input: { producer: NotificationProducer; message: string }): void;
  /**
   * Electron reported the OS took it. Not a claim that anybody SAW it — a
   * notification the OS has muted still reports `show` — only that delivery
   * got past the point an earlier one failed at, which is what lets Settings
   * retire a failure that is no longer current (round 5).
   */
  onDeliveryShown(input: { producer: NotificationProducer }): void;
  /** Diagnostics seam. Defaults to `console.warn`. */
  onError?: (error: unknown) => void;
}

/** Why an alert was not posted, or that it was. */
export type NotificationOutcome =
  | { delivered: true }
  | { delivered: false; reason: "muted" | "unsupported" | "focused-target" | "failed" };

export interface NotificationDispatcher {
  /** Posts one alert, or explains why it did not. Never throws. */
  deliver(request: NotificationRequest): NotificationOutcome;
  /** How many alerts are held awaiting a click. Diagnostics, and the retention test. */
  retained(): number;
}

export function createNotificationDispatcher(
  ports: NotificationDispatchPorts,
): NotificationDispatcher {
  const onError =
    ports.onError ?? ((error: unknown) => console.warn("[volli] notification:", error));
  const live = new Set<NativeAlert>();

  return {
    deliver(request) {
      if (!notificationProducerAllowed(ports.preferences(), request.producer)) {
        return { delivered: false, reason: "muted" };
      }
      if (!ports.supported()) return { delivered: false, reason: "unsupported" };
      if (
        ports.focusedTargets().some((active) => notificationTargetMatches(request.target, active))
      ) {
        return { delivered: false, reason: "focused-target" };
      }
      let retained: NativeAlert | null = null;
      try {
        const alert = ports.create({ title: request.title, body: request.body });
        retained = alert;
        live.add(alert);
        const release = () => live.delete(alert);
        alert.onClose(release);
        alert.onClick(() => {
          release();
          try {
            ports.activate(request.target);
          } catch (error) {
            onError(error);
          }
        });
        alert.onFailed((message) => {
          release();
          ports.onDeliveryFailure({ producer: request.producer, message });
        });
        alert.onShow(() => ports.onDeliveryShown({ producer: request.producer }));
        alert.show();
        return { delivered: true };
      } catch (error) {
        // Including a throw from `show()` itself, which happens AFTER the alert
        // joined the live set: an alert that was never posted has no click
        // coming, so holding it would be a leak with no symptom but memory.
        if (retained !== null) live.delete(retained);
        onError(error);
        return { delivered: false, reason: "failed" };
      }
    },
    retained: () => live.size,
  };
}
