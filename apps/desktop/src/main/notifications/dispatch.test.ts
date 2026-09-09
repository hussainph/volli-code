/**
 * The one delivery path (VC-295). No real `Notification` is ever constructed
 * here — the Electron seam is a port, which is the same reason it is a port in
 * production: a test that posted an OS alert would be a test nobody runs twice.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
  type NotificationTarget,
} from "@volli/shared";

import { createNotificationDispatcher, type NativeAlert } from "./dispatch";

const SESSION_TARGET: NotificationTarget = {
  kind: "session",
  projectId: "p1",
  ticketId: "t1",
  sessionId: "s1",
  interactionId: "i1",
  attentionId: null,
};

function preferences(
  overrides: Partial<NotificationPreferences["events"]> = {},
  enabled = true,
): NotificationPreferences {
  return { enabled, events: { ...DEFAULT_NOTIFICATION_PREFERENCES.events, ...overrides } };
}

/** A fake native alert whose listeners the test can fire by hand. */
class FakeAlert implements NativeAlert {
  shown = 0;
  closed = 0;
  readonly listeners = new Map<string, () => void>();
  private failure: ((message: string) => void) | null = null;

  constructor(readonly options: { title: string; body: string }) {}

  onClick(listener: () => void): void {
    this.listeners.set("click", listener);
  }
  onClose(listener: () => void): void {
    this.listeners.set("close", listener);
  }
  onShow(listener: () => void): void {
    this.listeners.set("show", listener);
  }
  onFailed(listener: (message: string) => void): void {
    this.failure = listener;
  }
  show(): void {
    this.shown += 1;
  }
  close(): void {
    this.closed += 1;
  }
  fire(event: "click" | "close" | "show"): void {
    this.listeners.get(event)?.();
  }
  fail(message: string): void {
    this.failure?.(message);
  }
}

function harness(
  options: {
    preferences?: NotificationPreferences;
    supported?: boolean;
    focusedTargets?: readonly (NotificationTarget | null)[];
  } = {},
) {
  const alerts: FakeAlert[] = [];
  const activated: (NotificationTarget | null)[] = [];
  const failures: { producer: string; message: string }[] = [];
  const shown: string[] = [];
  const errors: unknown[] = [];
  const dispatcher = createNotificationDispatcher({
    preferences: () => options.preferences ?? DEFAULT_NOTIFICATION_PREFERENCES,
    supported: () => options.supported ?? true,
    focusedTargets: () => options.focusedTargets ?? [],
    create: (input) => {
      const alert = new FakeAlert(input);
      alerts.push(alert);
      return alert;
    },
    activate: (target) => activated.push(target),
    onDeliveryFailure: (failure) => failures.push(failure),
    onDeliveryShown: ({ producer }) => shown.push(producer),
    onError: (error) => errors.push(error),
  });
  return { dispatcher, alerts, activated, failures, shown, errors };
}

describe("createNotificationDispatcher", () => {
  it("posts a preference-controlled alert whose category is on", () => {
    const { dispatcher, alerts } = harness();
    const outcome = dispatcher.deliver({
      producer: "run-attention",
      title: "An Automation is waiting on you",
      body: "VC-1 stopped to ask.",
      target: SESSION_TARGET,
    });
    expect(outcome).toEqual({ delivered: true });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.options).toEqual({
      title: "An Automation is waiting on you",
      body: "VC-1 stopped to ask.",
    });
    expect(alerts[0]!.shown).toBe(1);
  });

  it("refuses a muted category and never constructs the alert", () => {
    const { dispatcher, alerts } = harness({ preferences: preferences({ "needs-you": false }) });
    expect(
      dispatcher.deliver({
        producer: "session-watchdog",
        title: "Session may be wedged",
        body: "…",
        target: SESSION_TARGET,
      }),
    ).toEqual({ delivered: false, reason: "muted" });
    expect(alerts).toHaveLength(0);
  });

  it("mutes one category without touching another", () => {
    const { dispatcher, alerts } = harness({ preferences: preferences({ swept: false }) });
    expect(
      dispatcher.deliver({
        producer: "worktree-reclaimed",
        title: "Worktree removed",
        body: "…",
        target: { kind: "ticket", projectId: "p1", ticketId: "t1" },
      }).delivered,
    ).toBe(false);
    expect(
      dispatcher.deliver({
        producer: "pull-request-merged",
        title: "Pull request merged",
        body: "…",
        target: { kind: "ticket", projectId: "p1", ticketId: "t1" },
      }).delivered,
    ).toBe(true);
    expect(alerts).toHaveLength(1);
  });

  it("silences every preference-controlled producer when the master switch is off", () => {
    const { dispatcher, alerts } = harness({ preferences: preferences({}, false) });
    expect(
      dispatcher.deliver({
        producer: "update-ready",
        title: "Update ready",
        body: "…",
        target: { kind: "update" },
      }),
    ).toEqual({ delivered: false, reason: "muted" });
    expect(alerts).toHaveLength(0);
  });

  it("still posts an operational alert with every switch off", () => {
    const { dispatcher, alerts } = harness({ preferences: preferences({}, false) });
    expect(
      dispatcher.deliver({
        producer: "cli-socket-failed",
        title: "Volli CLI unavailable",
        body: "…",
        target: null,
      }),
    ).toEqual({ delivered: true });
    expect(alerts).toHaveLength(1);
  });

  it("says so rather than throwing when the platform has no native alerts", () => {
    const { dispatcher, alerts } = harness({ supported: false });
    expect(
      dispatcher.deliver({
        producer: "agent-notify",
        title: "Volli Code",
        body: "…",
        target: null,
      }),
    ).toEqual({ delivered: false, reason: "unsupported" });
    expect(alerts).toHaveLength(0);
  });

  it("suppresses an alert whose exact target is active in a focused window", () => {
    const { dispatcher, alerts } = harness({
      focusedTargets: [SESSION_TARGET],
    });
    expect(
      dispatcher.deliver({
        producer: "run-attention",
        title: "…",
        body: "…",
        target: SESSION_TARGET,
      }),
    ).toEqual({ delivered: false, reason: "focused-target" });
    expect(alerts).toHaveLength(0);
  });

  it("still delivers a different question in the Session already on screen", () => {
    // Round 2's correction: a person answering one question is not being shown
    // the failure that just stopped the same Session.
    const { dispatcher } = harness({
      focusedTargets: [{ ...SESSION_TARGET, interactionId: null, attentionId: "a1" }],
    });
    expect(
      dispatcher.deliver({
        producer: "run-attention",
        title: "…",
        body: "…",
        target: SESSION_TARGET,
      }),
    ).toEqual({ delivered: true });
  });

  it("still delivers when a focused window is showing something else", () => {
    // The narrow rule: another Session, another ticket, or a window showing
    // nothing at all is not the target being in front of the person.
    const { dispatcher } = harness({
      focusedTargets: [{ ...SESSION_TARGET, sessionId: "s2" }, null],
    });
    expect(
      dispatcher.deliver({
        producer: "run-attention",
        title: "…",
        body: "…",
        target: SESSION_TARGET,
      }),
    ).toEqual({ delivered: true });
  });

  it("delivers a target-less alert even while a window is focused on something", () => {
    const { dispatcher } = harness({ focusedTargets: [SESSION_TARGET] });
    expect(
      dispatcher.deliver({ producer: "agent-notify", title: "…", body: "…", target: null }),
    ).toEqual({ delivered: true });
  });

  it("routes a click to the alert's target", () => {
    const { dispatcher, alerts, activated } = harness();
    dispatcher.deliver({
      producer: "harness-input-needed",
      title: "…",
      body: "…",
      target: SESSION_TARGET,
    });
    alerts[0]!.fire("click");
    expect(activated).toEqual([SESSION_TARGET]);
  });

  it("brings the app forward for a click on an alert with no target", () => {
    const { dispatcher, alerts, activated } = harness();
    dispatcher.deliver({ producer: "agent-notify", title: "…", body: "…", target: null });
    alerts[0]!.fire("click");
    expect(activated).toEqual([null]);
  });

  it("holds the alert until it is clicked or closed, so the click has a listener to reach", () => {
    const { dispatcher, alerts } = harness();
    dispatcher.deliver({ producer: "agent-notify", title: "…", body: "…", target: null });
    expect(dispatcher.retained()).toBe(1);
    alerts[0]!.fire("close");
    expect(dispatcher.retained()).toBe(0);
  });

  it("releases a clicked alert too", () => {
    const { dispatcher, alerts } = harness();
    dispatcher.deliver({ producer: "agent-notify", title: "…", body: "…", target: null });
    alerts[0]!.fire("click");
    expect(dispatcher.retained()).toBe(0);
  });

  it("reports a delivery Electron says failed, and releases it", () => {
    const { dispatcher, alerts, failures } = harness();
    dispatcher.deliver({
      producer: "run-attention",
      title: "…",
      body: "…",
      target: SESSION_TARGET,
    });
    alerts[0]!.fail("Notification permission denied");
    expect(failures).toEqual([
      { producer: "run-attention", message: "Notification permission denied" },
    ]);
    expect(dispatcher.retained()).toBe(0);
  });

  it("reports a delivery the OS took, and keeps holding it for the click", () => {
    // `show` is not `close`: the alert is still on screen, and its click still
    // needs a listener to reach.
    const { dispatcher, alerts, shown } = harness();
    dispatcher.deliver({
      producer: "run-attention",
      title: "…",
      body: "…",
      target: SESSION_TARGET,
    });
    alerts[0]!.fire("show");
    expect(shown).toEqual(["run-attention"]);
    expect(dispatcher.retained()).toBe(1);
  });

  it("never lets a broken alert fail the work that raised it", () => {
    const errors: unknown[] = [];
    const dispatcher = createNotificationDispatcher({
      preferences: () => DEFAULT_NOTIFICATION_PREFERENCES,
      supported: () => true,
      focusedTargets: () => [],
      create: () => {
        throw new Error("no notification centre");
      },
      activate: () => {},
      onDeliveryFailure: () => {},
      onDeliveryShown: () => {},
      onError: (error) => errors.push(error),
    });
    expect(
      dispatcher.deliver({ producer: "agent-notify", title: "…", body: "…", target: null }),
    ).toEqual({ delivered: false, reason: "failed" });
    expect(errors).toHaveLength(1);
  });

  it("swallows a throw from the click route as well", () => {
    const errors: unknown[] = [];
    const alerts: FakeAlert[] = [];
    const dispatcher = createNotificationDispatcher({
      preferences: () => DEFAULT_NOTIFICATION_PREFERENCES,
      supported: () => true,
      focusedTargets: () => [],
      create: (input) => {
        const alert = new FakeAlert(input);
        alerts.push(alert);
        return alert;
      },
      activate: () => {
        throw new Error("window gone");
      },
      onDeliveryFailure: () => {},
      onDeliveryShown: () => {},
      onError: (error) => errors.push(error),
    });
    dispatcher.deliver({ producer: "agent-notify", title: "…", body: "…", target: null });
    alerts[0]!.fire("click");
    expect(errors).toHaveLength(1);
    expect(dispatcher.retained()).toBe(0);
  });

  it("releases the retained alert when show() itself throws", () => {
    // The alert was constructed and added to the live set before `show()` ran.
    // A throw there must not leave it held for the life of the process — a leak
    // whose only symptom is memory nobody can attribute.
    const errors: unknown[] = [];
    const dispatcher = createNotificationDispatcher({
      preferences: () => DEFAULT_NOTIFICATION_PREFERENCES,
      supported: () => true,
      focusedTargets: () => [],
      create: () => ({
        onClick: () => {},
        onClose: () => {},
        onFailed: () => {},
        onShow: () => {},
        show: () => {
          throw new Error("notification centre refused");
        },
        close: () => {},
      }),
      activate: () => {},
      onDeliveryFailure: () => {},
      onDeliveryShown: () => {},
      onError: (error) => errors.push(error),
    });
    expect(
      dispatcher.deliver({ producer: "agent-notify", title: "…", body: "…", target: null }),
    ).toEqual({ delivered: false, reason: "failed" });
    expect(errors).toHaveLength(1);
    expect(dispatcher.retained()).toBe(0);
  });

  it("binds each producer to the one kind of target it can have", () => {
    // Compile-time, not runtime: a harness alert pointing at a ticket, or a
    // merged pull request pointing at a Session, would be a deep link that
    // opens the wrong surface — and neither is representable.
    const { dispatcher } = harness();
    // @ts-expect-error a harness alert names a Session, never a ticket
    dispatcher.deliver({
      producer: "harness-input-needed",
      title: "…",
      body: "…",
      target: { kind: "ticket", projectId: "p1", ticketId: "t1" },
    });
    // @ts-expect-error a merged pull request names a ticket, never a Session
    dispatcher.deliver({
      producer: "pull-request-merged",
      title: "…",
      body: "…",
      target: SESSION_TARGET,
    });
    dispatcher.deliver({
      producer: "update-ready",
      title: "…",
      body: "…",
      // @ts-expect-error the staged update names the update surface and nothing else
      target: { kind: "ticket", projectId: "p1", ticketId: "t1" },
    });
    // @ts-expect-error a free-form `volli notify` has nowhere to point
    dispatcher.deliver({ producer: "agent-notify", title: "…", body: "…", target: SESSION_TARGET });
  });

  it("defaults its diagnostics seam to the console rather than requiring one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dispatcher = createNotificationDispatcher({
      preferences: () => DEFAULT_NOTIFICATION_PREFERENCES,
      supported: () => true,
      focusedTargets: () => [],
      create: () => {
        throw new Error("boom");
      },
      activate: () => {},
      onDeliveryFailure: () => {},
      onDeliveryShown: () => {},
    });
    dispatcher.deliver({ producer: "agent-notify", title: "…", body: "…", target: null });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
