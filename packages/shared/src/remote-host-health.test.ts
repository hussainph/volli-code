import { describe, expect, it } from "vite-plus/test";
import {
  boundedRemoteHostHealth,
  remoteHostDiagnostic,
  REMOTE_HOST_HEALTH_LIMITS as limits,
} from "./remote-host-health";

type Health = Parameters<typeof boundedRemoteHostHealth>[0];
const welcome = { at: 1, hostId: "host", version: "1.0.0", protocol: 1, features: [] };
const expiry = { providerId: "provider", name: "Provider", expiresAt: null, expired: true };
const failure = { code: "key-refused", line: "box didn’t accept your key" };
function health(): Health {
  return {
    reachability: { state: { status: "ready" }, everReady: true, droppedAt: null },
    lastWelcome: welcome,
    signInExpiry: [expiry],
    lastSshFailure: failure,
  };
}

describe("bounded host health producer", () => {
  it("preserves valid facts and unknown nullable facts", () => {
    expect(boundedRemoteHostHealth(health())).toEqual(health());
    const unknown = { ...health(), lastWelcome: null, signInExpiry: null, lastSshFailure: null };
    expect(boundedRemoteHostHealth(unknown)).toEqual(unknown);
  });

  it.each(["hostId", "version"] as const)(
    "rejects welcome %s evidence above its bound, rather than inventing a truncated identity",
    (field) => {
      const max = limits[field];
      const atLimit = { ...health(), lastWelcome: { ...welcome, [field]: "x".repeat(max) } };
      expect(boundedRemoteHostHealth(atLimit)).toEqual(atLimit);
      expect(
        boundedRemoteHostHealth({
          ...atLimit,
          lastWelcome: { ...atLimit.lastWelcome, [field]: "x".repeat(max + 1) },
        }).lastWelcome,
      ).toBeNull();
    },
  );

  it("bounds feature strings and array at the producer", () => {
    const atLimit = {
      ...health(),
      lastWelcome: {
        ...welcome,
        features: Array.from({ length: limits.features }, () => "x".repeat(limits.feature)),
      },
    };
    expect(boundedRemoteHostHealth(atLimit)).toEqual(atLimit);
    const over = {
      ...health(),
      lastWelcome: {
        ...welcome,
        features: Array.from({ length: limits.features + 1 }, () => "x".repeat(limits.feature + 1)),
      },
    };
    expect(boundedRemoteHostHealth(over)).toEqual(atLimit);
  });

  it("drops oversized provider identities, bounds names and caps the expiry array", () => {
    const row = {
      ...expiry,
      providerId: "x".repeat(limits.providerId),
      name: "n".repeat(limits.providerName),
    };
    const atLimit = {
      ...health(),
      signInExpiry: Array.from({ length: limits.signInExpiry }, () => row),
    };
    expect(boundedRemoteHostHealth(atLimit)).toEqual(atLimit);
    const over = {
      ...health(),
      signInExpiry: [
        { ...row, providerId: row.providerId + "x" },
        ...Array.from({ length: limits.signInExpiry + 1 }, () => ({
          ...row,
          name: row.name + "n",
        })),
      ],
    };
    const bounded = boundedRemoteHostHealth(over).signInExpiry!;
    expect(bounded).toHaveLength(limits.signInExpiry);
    expect(bounded[0]).toEqual({ ...row, name: `${row.name.slice(0, -1)}…` });
  });

  it("bounds SSH failure code and line without changing safe human copy", () => {
    const atLimit = {
      ...health(),
      lastSshFailure: { code: "c".repeat(limits.sshCode), line: "l".repeat(limits.diagnostic) },
    };
    expect(boundedRemoteHostHealth(atLimit)).toEqual(atLimit);
    const bounded = boundedRemoteHostHealth({
      ...atLimit,
      lastSshFailure: {
        code: atLimit.lastSshFailure.code + "c",
        line: atLimit.lastSshFailure.line + "l",
      },
    }).lastSshFailure!;
    expect(bounded.code).toBe(`${"c".repeat(limits.sshCode - 1)}…`);
    expect(bounded.line).toBe(`${"l".repeat(limits.diagnostic - 1)}…`);
  });

  it("bounds reachability errors at limit and limit+1", () => {
    const error = {
      code: "c".repeat(limits.errorCode),
      reason: "r".repeat(limits.errorReason),
      message: "m".repeat(limits.diagnostic),
    };
    const reachability = {
      state: { status: "refused" as const, closeCode: null, error },
      everReady: false,
      droppedAt: 1,
    };
    expect(boundedRemoteHostHealth({ ...health(), reachability }).reachability).toEqual(
      reachability,
    );
    const state = boundedRemoteHostHealth({
      ...health(),
      reachability: {
        ...reachability,
        state: {
          ...reachability.state,
          error: {
            code: error.code + "c",
            reason: error.reason + "r",
            message: error.message + "m",
          },
        },
      },
    }).reachability.state;
    expect(state).toMatchObject({
      error: {
        code: `${error.code.slice(0, -1)}…`,
        reason: `${error.reason.slice(0, -1)}…`,
        message: `${error.message.slice(0, -1)}…`,
      },
    });
  });
});

describe("host diagnostic one-line policy", () => {
  it("strips controls, redacts URL userinfo/query/fragment and credential-shaped text before bounding", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const text = `bad\u0007\n\u202e\u2028 vdc1.fixture_body.fixture_signature https://person:fake-password@example.test/path?token=fake-query#fake-fragment ${token} https://user:fake-other@example.test/plain`;
    const line = remoteHostDiagnostic(text);
    expect(line).not.toMatch(/[\p{Cc}]/u);
    for (const secret of [
      "fake-password",
      "fake-query",
      "fake-fragment",
      "fake-other",
      token,
      "vdc1.",
      "fixture_body",
      "fixture_signature",
    ])
      expect(line).not.toContain(secret);
    expect(line).toContain("[redacted]");
    expect(remoteHostDiagnostic("x".repeat(limits.diagnostic))).toHaveLength(limits.diagnostic);
    expect(remoteHostDiagnostic("x".repeat(limits.diagnostic + 1))).toBe(
      `${"x".repeat(limits.diagnostic - 1)}…`,
    );
  });
});
