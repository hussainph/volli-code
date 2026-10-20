import { describe, expect, it } from "vite-plus/test";

import {
  THIS_MAC_HOST,
  type HostLinkView,
  type HostRecord,
} from "@renderer/stores/host-connection";
import { remoteHost } from "@renderer/stores/host-sources";

import {
  countSessions,
  formatSince,
  hostBadge,
  hostDetail,
  hostDotState,
  hostMeta,
  hostPulsing,
  hostSurface,
  hostTransitionToast,
  retryCountdown,
} from "./host-surface-model";

const NOW = new Date(2026, 9, 7, 16, 30).getTime();
const SINCE = new Date(2026, 9, 7, 16, 12).getTime();

function host(link: HostLinkView, overrides: Partial<HostRecord> = {}): HostRecord {
  return remoteHost("h", "hetzner-1", { link, ...overrides });
}

const OFFLINE: HostLinkView = { status: "offline", since: SINCE, retryAt: NOW + 7_200 };

describe("the Island's words", () => {
  it("names a missing project with Forget, and other refusals by code", () => {
    const missing: HostLinkView = {
      status: "incompatible",
      reason: "refused",
      refusalCode: "workspace-unknown",
      workspaceId: "project-1",
    };
    expect(hostSurface(host(missing), NOW)).toMatchObject({
      line: "This project isn’t on hetzner-1 any more",
      action: { kind: "forget-project", label: "Forget", workspaceId: "project-1" },
    });
    expect(hostDetail(host(missing))).toMatchObject({
      text: "This project isn’t on hetzner-1 any more",
      action: { kind: "forget-project", workspaceId: "project-1" },
    });
    expect(
      hostSurface(
        host({ status: "incompatible", reason: "refused", refusalCode: "workspace-unknown" }),
        NOW,
      ),
    ).not.toHaveProperty("action");
    const refusal: HostLinkView = {
      status: "incompatible",
      reason: "refused",
      refusalCode: "credential-revoked",
    };
    expect(hostSurface(host(refusal), NOW)?.line).toContain("credential-revoked");
    expect(hostDetail(host(refusal))).toMatchObject({
      text: "Connection refused (credential-revoked)",
    });
    expect(
      hostDetail(
        host({ status: "offline", since: 0, retryAt: null, detail: "Host is not serving" }),
      ),
    ).toMatchObject({ kind: "offline", text: "Can’t reach hetzner-1 · Host is not serving" });
  });

  it("says nothing for a host that serves, or only has an update on offer", () => {
    expect(hostSurface(host({ status: "open" }), NOW)).toBeNull();
    expect(
      hostSurface(host({ status: "version-skewed", availableVersion: "0.3.0" }), NOW),
    ).toBeNull();
    expect(
      hostSurface(
        host({ status: "open" }, { expiredSignIns: [{ providerId: "anthropic", name: "Claude" }] }),
        NOW,
      ),
    ).toBeNull();
  });

  it("graces connecting and reconnecting, quietly and with no action", () => {
    expect(hostSurface(host({ status: "reconnecting" }), NOW)).toEqual({
      tone: "quiet",
      icon: "reconnect",
      line: "Reconnecting to hetzner-1",
      graced: true,
    });
    expect(hostSurface(host({ status: "connecting" }), NOW)?.line).toBe("Connecting to hetzner-1");
  });

  it("counts offline down to the next attempt, with Retry now", () => {
    expect(hostSurface(host(OFFLINE), NOW)).toEqual({
      tone: "quiet",
      icon: "offline",
      line: "Can’t reach hetzner-1 · Read-only",
      meta: "Retrying in 8s",
      action: { kind: "retry", label: "Retry now" },
      graced: false,
    });
    expect(hostSurface(host({ ...OFFLINE, retryAt: NOW - 1 }), NOW)?.meta).toBe("Retrying");
    expect(hostSurface(host({ ...OFFLINE, retryAt: null }), NOW)).not.toHaveProperty("meta");
  });

  it("says each incompatibility in one line with its one recovery", () => {
    const line = (link: HostLinkView, version: string | null = null) => {
      const surface = hostSurface(host(link, { version }), NOW);
      return [surface?.tone, surface?.line, surface?.action?.kind];
    };
    expect(
      line({ status: "incompatible", reason: "host-too-old", requiredVersion: "0.3.0" }),
    ).toEqual(["attention", "hetzner-1 needs Volli host 0.3.0 · Read-only", "update-host"]);
    expect(line({ status: "incompatible", reason: "host-too-old" })).toEqual([
      "attention",
      "hetzner-1 needs a newer Volli host · Read-only",
      "update-host",
    ]);
    expect(line({ status: "incompatible", reason: "database-too-new" })).toEqual([
      "error",
      "hetzner-1’s database is from a newer Volli · Read-only",
      "update-host",
    ]);
    expect(line({ status: "incompatible", reason: "host-too-new" }, "0.4.0")).toEqual([
      "attention",
      "hetzner-1 runs Volli 0.4.0 · Read-only",
      "update-app",
    ]);
    expect(line({ status: "incompatible", reason: "host-too-new" })).toEqual([
      "attention",
      "hetzner-1 runs a newer Volli · Read-only",
      "update-app",
    ]);
    expect(line({ status: "incompatible", reason: "refused" })).toEqual([
      "error",
      "hetzner-1 no longer accepts this Mac · Read-only",
      "manage-hosts",
    ]);
    expect(line({ status: "incompatible", reason: "fenced" })).toEqual([
      "error",
      "hetzner-1 no longer serves this project · Read-only",
      "manage-hosts",
    ]);
    expect(line({ status: "incompatible", reason: "too-many-projects" })).toEqual([
      "attention",
      "Too many projects open on hetzner-1 · Read-only",
      "manage-hosts",
    ]);
  });

  it("says Updating over whatever the link is doing while an update runs", () => {
    expect(
      hostSurface(
        host(
          { status: "reconnecting" },
          { update: { status: "running", progress: 0.4, targetVersion: "0.3.0" } },
        ),
        NOW,
      ),
    ).toEqual({ tone: "quiet", icon: "reconnect", line: "Updating hetzner-1", graced: false });
  });

  it("never counts below zero", () => {
    expect(retryCountdown(NOW + 1, NOW)).toBe(1);
    expect(retryCountdown(NOW - 5_000, NOW)).toBe(0);
  });
});

describe("the chip's tile", () => {
  it("badges each state the lab drew", () => {
    expect(hostBadge(host({ status: "open" }))).toBeNull();
    expect(hostBadge(host({ status: "reconnecting" }))).toBeNull();
    expect(hostBadge(host(OFFLINE))).toBe("offline");
    expect(hostBadge(host({ status: "incompatible", reason: "database-too-new" }))).toBe("fail");
    expect(hostBadge(host({ status: "incompatible", reason: "refused" }))).toBe("fail");
    expect(hostBadge(host({ status: "incompatible", reason: "host-too-old" }))).toBe("attention");
    expect(hostBadge(host({ status: "incompatible", reason: "host-too-new" }))).toBe("attention");
    expect(hostBadge(host({ status: "version-skewed", availableVersion: "0.3.0" }))).toBe(
      "attention",
    );
    expect(
      hostBadge(host({ status: "open" }, { expiredSignIns: [{ providerId: "x", name: "X" }] })),
    ).toBe("attention");
  });

  it("breathes while the link comes back or an update runs", () => {
    expect(hostPulsing(host({ status: "connecting" }))).toBe(true);
    expect(hostPulsing(host({ status: "reconnecting" }))).toBe(true);
    expect(
      hostPulsing(
        host(
          { status: "open" },
          { update: { status: "running", progress: 0, targetVersion: "1" } },
        ),
      ),
    ).toBe(true);
    expect(hostPulsing(host({ status: "open" }, { update: { status: "scheduled" } }))).toBe(false);
    expect(hostPulsing(host(OFFLINE))).toBe(false);
  });
});

describe("the switcher's words", () => {
  it("counts Sessions and projects", () => {
    expect(countSessions(1)).toBe("1 Session");
    expect(countSessions(2)).toBe("2 Sessions");
    expect(hostMeta(THIS_MAC_HOST, 3, NOW)).toBe("3 projects");
    expect(hostMeta(THIS_MAC_HOST, 1, NOW)).toBe("1 project");
    expect(hostMeta(host({ status: "open" }, { liveSessions: 2 }), 1, NOW)).toBe(
      "2 Sessions running",
    );
    expect(hostMeta(host({ status: "open" }, { liveSessions: 0 }), 4, NOW)).toBe("4 projects");
  });

  it("names what the link is doing", () => {
    expect(hostMeta(host({ status: "connecting" }), 0, NOW)).toBe("Connecting");
    expect(hostMeta(host({ status: "reconnecting" }), 0, NOW)).toBe("Reconnecting");
    expect(hostMeta(host(OFFLINE), 0, NOW, "en-US")).toBe("Offline · since 4:12 PM");
    expect(
      hostMeta(
        host(
          { status: "open" },
          { update: { status: "running", progress: 0, targetVersion: "1" } },
        ),
        0,
        NOW,
      ),
    ).toBe("Updating");
  });

  it("names the host's version when it is the problem", () => {
    expect(
      hostMeta(
        host({ status: "version-skewed", availableVersion: "0.3.0" }, { version: "0.2.4" }),
        1,
        NOW,
      ),
    ).toBe("Volli host 0.2.4");
    expect(
      hostMeta(
        host({ status: "incompatible", reason: "host-too-old" }, { version: "0.1.8" }),
        1,
        NOW,
      ),
    ).toBe("Volli host 0.1.8");
    expect(hostMeta(host({ status: "incompatible", reason: "fenced" }), 2, NOW)).toBe("2 projects");
  });

  it("dates an outage from an earlier day", () => {
    expect(formatSince(new Date(2026, 9, 3, 9).getTime(), NOW, "en-US")).toBe("Oct 3");
  });
});

describe("the current host's detail", () => {
  it("says nothing for a host with nothing to say", () => {
    expect(hostDetail(host({ status: "open" }))).toBeNull();
    expect(hostDetail(host({ status: "reconnecting" }))).toBeNull();
  });

  it("puts an update in flight first", () => {
    expect(
      hostDetail(
        host(OFFLINE, { update: { status: "running", progress: 0.5, targetVersion: "0.3.0" } }),
      ),
    ).toEqual({ kind: "updating", progress: 0.5, targetVersion: "0.3.0" });
  });

  it("then a host that cannot serve", () => {
    expect(hostDetail(host(OFFLINE))).toEqual({ kind: "offline" });
    const detail = (reason: Parameters<typeof hostSurface>[0]["link"]) => hostDetail(host(reason));
    expect(detail({ status: "incompatible", reason: "host-too-old" })).toEqual({
      kind: "incompatible",
      text: "Too old for this app",
      action: { kind: "update-host", label: "Re-add to update" },
    });
    expect(detail({ status: "incompatible", reason: "database-too-new" })).toMatchObject({
      text: "Database from a newer Volli",
    });
    expect(detail({ status: "incompatible", reason: "host-too-new" })).toMatchObject({
      text: "Newer than this app",
      action: { kind: "update-app" },
    });
    expect(detail({ status: "incompatible", reason: "refused" })).toMatchObject({
      action: { kind: "manage-hosts" },
    });
    expect(detail({ status: "incompatible", reason: "fenced" })).toMatchObject({
      text: "No longer serves this project",
    });
    expect(detail({ status: "incompatible", reason: "too-many-projects" })).toMatchObject({
      text: "Too many projects open",
      action: { kind: "manage-hosts" },
    });
  });

  it("then an expired sign-in, then an update on offer or scheduled", () => {
    const claude = { providerId: "anthropic", name: "Claude" };
    const skewed: HostLinkView = { status: "version-skewed", availableVersion: "0.3.0" };
    expect(hostDetail(host(skewed, { expiredSignIns: [claude] }))).toEqual({
      kind: "sign-in",
      signIn: claude,
    });
    expect(hostDetail(host(skewed))).toEqual({ kind: "update-available", version: "0.3.0" });
    expect(hostDetail(host(skewed, { update: { status: "scheduled" } }))).toEqual({
      kind: "update-scheduled",
    });
  });
});

describe("recovery toasts", () => {
  it("welcomes a host back, with what kept running", () => {
    expect(
      hostTransitionToast(host(OFFLINE), host({ status: "open" }, { liveSessions: 2 })),
    ).toEqual({
      title: "Back on hetzner-1",
      description: "2 Sessions kept running while you were away",
    });
    expect(hostTransitionToast(host(OFFLINE), host({ status: "open" }))).toEqual({
      title: "Back on hetzner-1",
    });
    expect(
      hostTransitionToast(
        host(OFFLINE),
        host({ status: "version-skewed", availableVersion: "1" }, { liveSessions: 0 }),
      ),
    ).toEqual({ title: "Back on hetzner-1" });
  });

  it("announces a landed update, with the host's new version", () => {
    const running = host(
      { status: "reconnecting" },
      { update: { status: "running", progress: 1, targetVersion: "0.3.0" } },
    );
    expect(hostTransitionToast(running, host({ status: "open" }, { version: "0.3.1" }))).toEqual({
      title: "hetzner-1 is on Volli host 0.3.1",
    });
    expect(hostTransitionToast(running, host({ status: "open" }))?.title).toBe(
      "hetzner-1 is on Volli host 0.3.0",
    );
  });

  it("stays quiet otherwise", () => {
    expect(hostTransitionToast(host({ status: "open" }), host({ status: "open" }))).toBeNull();
    expect(hostTransitionToast(host(OFFLINE), host({ status: "reconnecting" }))).toBeNull();
    expect(hostTransitionToast(host(OFFLINE), host({ ...OFFLINE, retryAt: null }))).toBeNull();
    expect(hostTransitionToast(THIS_MAC_HOST, THIS_MAC_HOST)).toBeNull();
  });
});

describe("the Running on dot", () => {
  it("is the host's state, not the Session's", () => {
    expect(hostDotState(host({ status: "open" }))).toBe("ready");
    expect(hostDotState(host({ status: "version-skewed", availableVersion: "1" }))).toBe("ready");
    expect(hostDotState(host(OFFLINE))).toBe("exited");
    expect(hostDotState(host({ status: "incompatible", reason: "fenced" }))).toBe("error");
    expect(hostDotState(host({ status: "reconnecting" }))).toBe("starting");
    expect(hostDotState(host({ status: "connecting" }))).toBe("starting");
    expect(hostDotState(host({ status: "open" }, { update: { status: "scheduled" } }))).toBe(
      "waiting",
    );
    expect(
      hostDotState(host({ status: "open" }, { expiredSignIns: [{ providerId: "x", name: "X" }] })),
    ).toBe("waiting");
  });
});
