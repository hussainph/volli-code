import { describe, expect, it } from "vite-plus/test";

import { cloudEnabled, HOSTD_FEATURES, sessionWorkspace } from "./host-protocol";

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
      "board.read",
      "board.write",
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
