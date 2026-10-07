import { describe, expect, it } from "vite-plus/test";
import type { RemoteHostDevice } from "@volli/shared";

import { THIS_MAC_HOST, type HostRecord } from "@renderer/stores/host-connection";
import { registryHost } from "@renderer/stores/remote-hosts.test-support";

import {
  deviceMeta,
  hostFacts,
  hostHealth,
  hostRowMeta,
  orderDevices,
  shortFingerprint,
  systemLine,
} from "./hosts-pane-model";

const remote = (patch: Partial<HostRecord>): HostRecord => ({
  ...THIS_MAC_HOST,
  id: "h",
  name: "box",
  local: false,
  ...patch,
});

function device(patch: Partial<RemoteHostDevice>): RemoteHostDevice {
  return {
    deviceId: "d",
    name: "Laptop",
    fingerprint: "SHA256:x",
    enrolledAt: "2026-10-03T12:00:00.000Z",
    via: "ssh",
    revokedAt: null,
    thisMac: false,
    ...patch,
  };
}

describe("a host's health in Settings", () => {
  it("says nothing for a host serving no project here", () => {
    expect(hostHealth(remote({}), 0)).toBeNull();
  });

  it("reads its projects' aggregate link", () => {
    expect(hostHealth(remote({}), 1)).toEqual({ state: "ready", label: "Online" });
    expect(hostHealth(remote({ link: { status: "connecting" } }), 1)?.label).toBe("Connecting");
    expect(hostHealth(remote({ link: { status: "reconnecting" } }), 1)?.label).toBe("Connecting");
    expect(hostHealth(remote({ link: { status: "offline", since: 0, retryAt: null } }), 1)).toEqual(
      { state: "exited", label: "Offline" },
    );
    expect(
      hostHealth(remote({ link: { status: "version-skewed", availableVersion: "2" } }), 1)?.label,
    ).toBe("Update available");
    expect(hostHealth(remote({ link: { status: "incompatible", reason: "refused" } }), 2)).toEqual({
      state: "error",
      label: "Can’t serve",
    });
    expect(
      hostHealth(remote({ update: { status: "running", progress: 0.5, targetVersion: "2" } }), 1)
        ?.label,
    ).toBe("Updating");
  });
});

describe("a host's words", () => {
  it("sums the row up", () => {
    expect(hostRowMeta(registryHost(), 2)).toBe("SSH · deploy@box · 1.1.0");
    expect(hostRowMeta(registryHost({ version: null }), 0)).toBe(
      "SSH · deploy@box · No projects yet",
    );
  });

  it("lists a system install's facts", () => {
    expect(hostFacts(registryHost()).map(({ label, value }) => `${label}: ${value}`)).toEqual([
      "System: Linux",
      "Version: Volli host 1.1.0",
      "Connection: SSH · deploy@box",
      "Runs as: Its own account",
      "Starts: When it boots",
    ]);
  });

  it("says a user install's agents share the person's account, and when a Mac starts", () => {
    const facts = hostFacts(
      registryHost({ name: "studio", os: "macos", mode: "user", agentsShareAccount: true }),
    );
    expect(facts.find((fact) => fact.label === "Runs as")).toMatchObject({
      value: "Your account",
      hint: expect.stringContaining("Agents on studio share your account"),
    });
    expect(facts.find((fact) => fact.label === "Starts")?.value).toBe("When you log in to studio");
    expect(hostFacts(registryHost({ os: null, version: null })).slice(0, 2)).toEqual([
      { label: "System", value: "Unknown" },
      { label: "Version", value: "Unknown" },
    ]);
  });
});

describe("paired devices", () => {
  it("says when each paired, or was revoked", () => {
    expect(deviceMeta(device({}), "en-GB")).toBe("Paired 3 Oct 2026");
    expect(deviceMeta(device({ revokedAt: "2026-10-05T00:00:00.000Z" }), "en-GB")).toBe(
      "Revoked 5 Oct 2026",
    );
    expect(deviceMeta(device({ enrolledAt: "not a date" }))).toBe("Paired not a date");
  });

  it("puts this Mac first and revoked devices last, otherwise as the host listed them", () => {
    const list = [
      device({ deviceId: "old", revokedAt: "2026-10-05T00:00:00.000Z" }),
      device({ deviceId: "phone" }),
      device({ deviceId: "me", thisMac: true }),
      device({ deviceId: "tablet" }),
    ];
    expect(orderDevices(list).map((entry) => entry.deviceId)).toEqual([
      "me",
      "phone",
      "tablet",
      "old",
    ]);
  });
});

describe("the host's system and key", () => {
  it("reads the system its check found, and its OS where it found nothing", () => {
    expect(systemLine(registryHost({ system: "Ubuntu 24.04.1 LTS", arch: "x86-64" }))).toBe(
      "Ubuntu 24.04.1 LTS · x86-64",
    );
    expect(systemLine(registryHost({ os: "macos", system: null, arch: "arm64" }))).toBe(
      "macOS · arm64",
    );
    expect(systemLine(registryHost({ os: null, system: null, arch: null }))).toBe("Unknown");
  });

  it("shows a trusted host key short, the whole one to copy; none when it was already known", () => {
    expect(shortFingerprint("SHA256:q3Zt9fK1x0mVabcdefg")).toBe("q3Zt 9fK1 x0mV");
    expect(shortFingerprint("SHA256:")).toBe("");
    const facts = hostFacts(
      registryHost({ hostKeys: ["SHA256:q3Zt9fK1x0mVabcdefg", "SHA256:other"] }),
    );
    expect(facts.at(-1)).toMatchObject({
      label: "Host key",
      value: "q3Zt 9fK1 x0mV",
      full: "SHA256:q3Zt9fK1x0mVabcdefg\nSHA256:other",
    });
    expect(hostFacts(registryHost()).map((fact) => fact.label)).not.toContain("Host key");
  });
});
