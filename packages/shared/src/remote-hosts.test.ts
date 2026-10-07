import { describe, expect, it } from "vite-plus/test";
import type { RemoteHost } from "./remote-hosts";
import * as contract from "./remote-hosts";

describe("remote host additive health contract", () => {
  it("allows older hosts to omit health and represents unknown expiry separately from known expiry", () => {
    const old: RemoteHost = {
      id: "host",
      name: "box",
      target: "box",
      transport: "ssh-tunnel",
      os: "linux",
      mode: "system",
      agentsShareAccount: false,
      version: null,
      availableUpdate: null,
      hostIsNewer: false,
      deviceId: "device",
      addedAt: "today",
      liveSessions: null,
      system: null,
      arch: null,
      hostKeys: [],
    };
    expect(old.reachability).toBeUndefined();
    const current: RemoteHost = {
      ...old,
      reachability: {
        state: { status: "connecting", attempt: 0 },
        everReady: false,
        droppedAt: null,
      },
      lastWelcome: null,
      lastSshFailure: null,
      signInExpiry: null,
    };
    expect(current.signInExpiry).toBeNull();
    const known: RemoteHost = {
      ...current,
      signInExpiry: [{ providerId: "example", name: "Example", expiresAt: null, expired: false }],
    };
    expect(known.signInExpiry).toHaveLength(1);
    expect(contract.REMOTE_HOST_LINK_CAP).toBe(24);
    expect(contract.REMOTE_HOST_TOO_MANY_PROJECTS).toBe("too-many-projects");
    expect(contract.REMOTE_HOST_NAME_MAX).toBe(120);
    expect(contract.REMOTE_HOST_DEVICES_MAX).toBe(1000);
    expect(contract.REMOTE_HOST_DEVICE_TEXT_MAX).toBe(256);
    expect(contract.REMOTE_HOST_PROJECTS_MAX).toBe(500);
    expect(contract.REMOTE_HOST_PROJECT_TEXT_MAX).toBe(4096);
    expect(contract.REMOTE_PROJECT_FAILURE_TEXT_MAX).toBe(8192);
    expect(contract.REMOTE_HOST_UPDATE_UNAVAILABLE).toContain("Updating");
    expect(contract.REMOTE_HOST_SIGN_IN_UNAVAILABLE).toContain("Signing in");
  });
});
