import { describe, expect, it } from "vite-plus/test";
import { REMOTE_HOST_HEALTH_LIMITS as limits, type RemoteHost } from "@volli/shared";
import { remoteHostsSnapshotSchema } from "./remote-hosts-schema";

const host: RemoteHost = {
  id: "host",
  name: "box",
  target: "box",
  transport: "ssh-tunnel",
  os: "linux",
  mode: "user",
  agentsShareAccount: true,
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
const welcome = { at: 0, hostId: "host", version: "1.0.0", protocol: 1, features: [] };
const expiry = { providerId: "provider", name: "Provider", expiresAt: null, expired: false };
const failure = { code: "key-refused", line: "box didn’t accept your key" };
const error = { code: "SERVICE_UNAVAILABLE", reason: "host-unreachable", message: "Gone" };
const reachability = {
  state: { status: "unreachable", error, attempt: 0, closeCode: null, retryAt: 0 },
  everReady: false,
  droppedAt: 0,
};
const accepts = (fields: Partial<RemoteHost> | Record<string, unknown>) =>
  remoteHostsSnapshotSchema.safeParse({
    v: 1,
    hosts: [{ ...host, ...fields }],
    projects: {},
    readOnly: null,
  }).success;

const textCases = [
  {
    name: "welcome host id",
    max: limits.hostId,
    fields: (text: string) => ({ lastWelcome: { ...welcome, hostId: text } }),
  },
  {
    name: "welcome version",
    max: limits.version,
    fields: (text: string) => ({ lastWelcome: { ...welcome, version: text } }),
  },
  {
    name: "welcome feature",
    max: limits.feature,
    fields: (text: string) => ({ lastWelcome: { ...welcome, features: [text] } }),
  },
  {
    name: "expiry provider id",
    max: limits.providerId,
    fields: (text: string) => ({ signInExpiry: [{ ...expiry, providerId: text }] }),
  },
  {
    name: "expiry name",
    max: limits.providerName,
    fields: (text: string) => ({ signInExpiry: [{ ...expiry, name: text }] }),
  },
  {
    name: "SSH failure code",
    max: limits.sshCode,
    fields: (text: string) => ({ lastSshFailure: { ...failure, code: text } }),
  },
  {
    name: "SSH failure line",
    max: limits.diagnostic,
    fields: (text: string) => ({ lastSshFailure: { ...failure, line: text } }),
  },
  ...(["unreachable", "refused", "fenced"] as const).flatMap((status) =>
    (["code", "reason", "message"] as const).map((field) => ({
      name: `${status} health error ${field}`,
      max:
        field === "code"
          ? limits.errorCode
          : field === "reason"
            ? limits.errorReason
            : limits.diagnostic,
      fields: (text: string) => ({
        reachability: {
          ...reachability,
          state: { ...reachability.state, status, error: { ...error, [field]: text } },
        },
      }),
    })),
  ),
];

describe("new host-health output bounds without narrowing old project fields", () => {
  it.each(textCases)("$name accepts exactly the limit and rejects limit+1", ({ max, fields }) => {
    expect(accepts(fields("x".repeat(max)))).toBe(true);
    expect(accepts(fields("x".repeat(max + 1)))).toBe(false);
  });
  it("caps expiry entries and welcome features inclusively", () => {
    expect(
      accepts({ signInExpiry: Array.from({ length: limits.signInExpiry }, () => expiry) }),
    ).toBe(true);
    expect(
      accepts({ signInExpiry: Array.from({ length: limits.signInExpiry + 1 }, () => expiry) }),
    ).toBe(false);
    expect(
      accepts({
        lastWelcome: {
          ...welcome,
          features: Array.from({ length: limits.features }, () => "feature"),
        },
      }),
    ).toBe(true);
    expect(
      accepts({
        lastWelcome: {
          ...welcome,
          features: Array.from({ length: limits.features + 1 }, () => "feature"),
        },
      }),
    ).toBe(false);
  });
  it("leaves previously published host and project fields unbounded", () => {
    const text = "x".repeat(10_000);
    expect(accepts({ id: text, name: text, version: text })).toBe(true);
    expect(
      remoteHostsSnapshotSchema.safeParse({
        v: 1,
        hosts: [host],
        readOnly: null,
        projects: {
          workspace: {
            hostId: "host",
            link: { ...reachability.state, error: { code: text, reason: text, message: text } },
          },
        },
      }).success,
    ).toBe(true);
  });
});
