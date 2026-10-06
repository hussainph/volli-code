import { describe, expect, it } from "vite-plus/test";

import { validateListenerLimits } from "@volli/session-rpc/websocket";

import {
  cloudEnabled,
  HOSTD_FEATURES,
  HOSTD_LISTENER_LIMITS,
  isLiteralLoopback,
  sessionWorkspace,
} from "./host-protocol";

describe("the cloud flag", () => {
  it("is on only when the environment's opt-in list names it", () => {
    expect(cloudEnabled({})).toBe(false);
    expect(cloudEnabled({ VOLLI_EXPERIMENTAL: "" })).toBe(false);
    expect(cloudEnabled({ VOLLI_EXPERIMENTAL: "something-else" })).toBe(false);
    expect(cloudEnabled({ VOLLI_EXPERIMENTAL: "Cloud" })).toBe(true);
    expect(cloudEnabled({ VOLLI_EXPERIMENTAL: "future, cloud" })).toBe(true);
  });
});

describe("what hostd offers", () => {
  it("is every v1 feature it composes, and not Model Access, which it does not", () => {
    expect(HOSTD_FEATURES).toStrictEqual([
      "sessions",
      "sessions.queue",
      "sessions.subscribe",
      "sessions.history",
      "session.read",
      // Sign-ins on this host and the relay's delivery (VC-702).
      "sign-ins",
      "auth.callback",
    ]);
  });
});

describe("the Session router's resource port", () => {
  it("answers a Session's project, null for an absent one, and nothing for another kind", async () => {
    const asked: string[] = [];
    const resolve = sessionWorkspace({
      getSession: async ({ sessionId }) => {
        asked.push(sessionId);
        return sessionId === "known"
          ? ({ session: { projectId: "project-1" } } as Awaited<
              ReturnType<Parameters<typeof sessionWorkspace>[0]["getSession"]>
            >)
          : null;
      },
    });
    expect(await resolve({ kind: "session", id: "known" })).toBe("project-1");
    expect(await resolve({ kind: "session", id: "absent" })).toBeNull();
    expect(await resolve({ kind: "ticket", id: "known" })).toBeNull();
    expect(asked).toEqual(["known", "absent"]);
  });
});

// B9 (VC-700): until VC-575's host-wide budget, the listener's own bounds are it.
describe("hostd's listener limits", () => {
  const MIB = 1024 * 1024;

  it("are tight, valid, and bound the worst case to 584 MiB", () => {
    const limits = HOSTD_LISTENER_LIMITS;
    expect(() => validateListenerLimits(limits)).not.toThrow();
    expect(limits).toMatchObject({
      maxConnections: 8,
      maxSubscriptions: 8,
      maxFrameBytes: 4 * MIB,
      maxReplayBytes: 4 * MIB,
      maxOutboundBytes: 8 * MIB,
      maxInboundBytes: 1 * MIB,
    });
    // A full resume and the frame behind it fit what one connection may hold unsent.
    expect(limits.maxReplayBytes + limits.maxFrameBytes).toBeLessThanOrEqual(
      limits.maxOutboundBytes,
    );
    const perConnection =
      limits.maxOutboundBytes +
      limits.maxSubscriptions * 2 * limits.maxReplayBytes +
      limits.maxInboundBytes;
    expect(limits.maxConnections * perConnection).toBe(584 * MIB);
  });

  it("serve a literal loopback address only, never a name", () => {
    for (const host of ["127.0.0.1", "127.8.9.10", "::1"])
      expect(isLiteralLoopback(host)).toBe(true);
    for (const host of ["localhost", "0.0.0.0", "::", "192.168.1.5", "box.local"]) {
      expect(isLiteralLoopback(host)).toBe(false);
    }
  });
});
