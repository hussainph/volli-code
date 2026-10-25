import { describe, expect, test } from "vite-plus/test";

import {
  defaultSinceLabel,
  pendingCommandLabel,
  RUNNER_PLACES_MAX_SESSIONS,
  runnerPlaceAvailability,
  sessionPlaceState,
  type RunnerPlace,
} from "./place";

const NOW = new Date(2026, 9, 24, 15, 30).getTime();
const AT = new Date(2026, 9, 24, 14, 2).getTime();

const mac = (patch: Partial<RunnerPlace> = {}): RunnerPlace => ({
  id: "runner-a",
  name: "hp-mac",
  kind: "mac",
  status: "online",
  statusChangedAt: AT,
  statusReason: null,
  owned: true,
  ...patch,
});

const place = (
  runner: RunnerPlace,
  options: { turnActive?: boolean; viewerRunnerId?: string | null } = {},
) =>
  sessionPlaceState({
    session: { turnActive: options.turnActive ?? false },
    runner,
    viewerRunnerId: options.viewerRunnerId ?? null,
    now: NOW,
  });

describe("sessionPlaceState", () => {
  test("a serving runner runs the Session", () => {
    for (const status of ["online", "draining", "degraded"]) {
      expect(place(mac({ status }))).toEqual({
        kind: "online",
        label: "Running on hp-mac",
        since: null,
        reason: null,
        runnerName: "hp-mac",
      });
    }
  });

  test("this machine's own runner is here, whatever the backend last heard", () => {
    expect(place(mac({ status: "offline" }), { viewerRunnerId: "runner-a" })).toMatchObject({
      kind: "here",
      label: "Running on this Mac",
    });
    expect(place(mac(), { viewerRunnerId: "runner-b" }).kind).toBe("online");
  });

  test("an asleep or offline runner is waited for since it went", () => {
    expect(place(mac({ status: "asleep" }))).toEqual({
      kind: "waiting",
      label: "Waiting for hp-mac — asleep since 14:02",
      since: AT,
      reason: "asleep",
      runnerName: "hp-mac",
    });
    expect(place(mac({ status: "offline" }))).toMatchObject({
      label: "Waiting for hp-mac — offline since 14:02",
      since: AT,
      reason: "offline",
    });
  });

  test("closed, updating and needing an update have no since", () => {
    expect(place(mac({ status: "stopped" }))).toMatchObject({
      label: "Waiting for hp-mac — Volli is closed",
      reason: "closed",
      since: null,
    });
    expect(place(mac({ status: "stopped", kind: "linux", name: "box" })).label).toBe(
      "Waiting for box — stopped",
    );
    expect(place(mac({ status: "updating" }))).toMatchObject({
      label: "Waiting for hp-mac — updating",
      reason: "updating",
    });
    expect(place(mac({ status: "upgrade_required" }))).toMatchObject({
      label: "Waiting for hp-mac — needs an update",
      reason: "needs_update",
    });
  });

  test("a live turn on a waiting runner is paused", () => {
    const paused = (patch: Partial<RunnerPlace>) => place(mac(patch), { turnActive: true }).label;
    expect(paused({ status: "asleep" })).toBe("Paused — hp-mac is asleep");
    expect(paused({ status: "offline" })).toBe("Paused — hp-mac is offline");
    expect(paused({ status: "stopped" })).toBe("Paused — Volli is closed on hp-mac");
    expect(paused({ status: "stopped", kind: "linux" })).toBe("Paused — hp-mac was stopped");
    expect(paused({ status: "updating" })).toBe("Paused — hp-mac is updating");
    expect(paused({ status: "upgrade_required" })).toBe("Paused — hp-mac needs an update");
    expect(paused({ status: "hibernating" })).toBe("Paused — hp-mac is hibernating");
    // A serving runner is not paused by its turn.
    expect(paused({ status: "online" })).toBe("Running on hp-mac");
  });

  test("an unknown status waits in the backend's own word", () => {
    expect(place(mac({ status: "hibernating" }))).toMatchObject({
      kind: "waiting",
      label: "Waiting for hp-mac — hibernating",
      reason: "unknown",
      since: null,
    });
  });

  test("a revoked runner was removed, from the owner's account or a teammate's view", () => {
    expect(place(mac({ status: "revoked", statusReason: "removed" }))).toEqual({
      kind: "removed",
      label: "hp-mac was removed from your account",
      since: AT,
      reason: "removed",
      runnerName: "hp-mac",
    });
    expect(place(mac({ status: "revoked", statusReason: null, owned: false })).label).toBe(
      "hp-mac was removed",
    );
    // Removal wins over "here": a removed runner runs nothing.
    expect(
      place(mac({ status: "revoked", statusReason: "credential_reuse" }), {
        viewerRunnerId: "runner-a",
      }),
    ).toMatchObject({
      kind: "removed",
      reason: "cut_off",
      label: "hp-mac was cut off: it was used from two places",
    });
  });

  test("since reads through the surface's formatter", () => {
    const state = sessionPlaceState({
      session: { turnActive: false },
      runner: mac({ status: "asleep" }),
      viewerRunnerId: null,
      now: NOW,
      formatSince: (at, now) => `${now - at}ms ago`,
    });
    expect(state.label).toBe(`Waiting for hp-mac — asleep since ${NOW - AT}ms ago`);
  });
});

const of = (status: string, statusReason: string | null = null) =>
  runnerPlaceAvailability({ status, statusReason });

describe("runnerPlaceAvailability", () => {
  test("serving, waiting with its reason, or removed: one rule for Places and Settings", () => {
    for (const status of ["online", "draining", "degraded"]) {
      expect(of(status)).toEqual({ kind: "serving", reason: null });
    }
    expect(of("asleep")).toEqual({ kind: "waiting", reason: "asleep" });
    expect(of("offline")).toEqual({ kind: "waiting", reason: "offline" });
    expect(of("stopped")).toEqual({ kind: "waiting", reason: "closed" });
    expect(of("updating")).toEqual({ kind: "waiting", reason: "updating" });
    expect(of("upgrade_required")).toEqual({ kind: "waiting", reason: "needs_update" });
    expect(of("hibernating")).toEqual({ kind: "waiting", reason: "unknown" });
    expect(of("revoked", "removed")).toEqual({ kind: "removed", reason: "removed" });
    expect(of("revoked", "replaced")).toEqual({ kind: "removed", reason: "removed" });
    expect(of("revoked", "credential_reuse")).toEqual({ kind: "removed", reason: "cut_off" });
  });
});

describe("defaultSinceLabel", () => {
  test("a clock time today, a date before", () => {
    expect(defaultSinceLabel(new Date(2026, 9, 24, 9, 5).getTime(), NOW)).toBe("09:05");
    expect(defaultSinceLabel(new Date(2026, 9, 23, 23, 59).getTime(), NOW)).toBe("Oct 23");
    expect(defaultSinceLabel(new Date(2025, 9, 24, 9, 5).getTime(), NOW)).toBe("Oct 24");
    expect(defaultSinceLabel(new Date(2026, 8, 24, 9, 5).getTime(), NOW)).toBe("Sep 24");
  });
});

describe("pendingCommandLabel", () => {
  test("a queued command waits for a runner that is not running the Session", () => {
    expect(pendingCommandLabel(place(mac({ status: "asleep" })))).toBe("Sent — waiting for hp-mac");
    expect(pendingCommandLabel(place(mac({ status: "revoked" })))).toBe(
      "Not sent — hp-mac was removed from your account",
    );
  });

  test("nothing to say while the runner runs it, or with no Place", () => {
    expect(pendingCommandLabel(null)).toBeNull();
    expect(pendingCommandLabel(place(mac()))).toBeNull();
    expect(pendingCommandLabel(place(mac(), { viewerRunnerId: "runner-a" }))).toBeNull();
  });
});

test("one places read names a bounded number of Sessions", () => {
  expect(RUNNER_PLACES_MAX_SESSIONS).toBe(64);
});
