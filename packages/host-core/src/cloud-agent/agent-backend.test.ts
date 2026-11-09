/**
 * The Agent-token cache and the offline rules, over a scripted functions
 * client (the HTTP transport itself is `functions-client.test.ts`'s, and the
 * whole path over a real server is `board-verbs.test.ts`'s).
 */
import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_TOKEN_REFRESH_AT,
  CONTENTION_BACKOFF_MAX_MS,
  CONTENTION_BACKOFF_MS,
  CONTENTION_RETRIES,
  createAgentBackend,
  NotYetSyncedError,
  runnerTokenBefore,
} from "./agent-backend";
import {
  CloudContentionError,
  CloudFunctionError,
  CloudOfflineError,
  type CloudFunctionKind,
  type CloudFunctionsClient,
} from "./functions-client";

const SESSION = "5e550000-0000-4000-8000-000000000001";

interface Seen {
  kind: CloudFunctionKind;
  path: string;
  args: Record<string, unknown>;
  token: string;
}

function scripted(answer: (call: Seen, index: number) => unknown): {
  client: CloudFunctionsClient;
  calls: Seen[];
} {
  const calls: Seen[] = [];
  return {
    calls,
    client: {
      async call(kind, path, args, token) {
        const call = { kind, path, args, token };
        calls.push(call);
        const result = answer(call, calls.length - 1);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

let minted = 0;
const grant = (serverTime = 0) => ({
  token: `agent-${++minted}`,
  expiresAt: serverTime + 900_000,
  serverTime,
});

describe("the agent backend", () => {
  it("bounds runner-token refresh before an agent request can be sent", async () => {
    await expect(
      runnerTokenBefore(() => new Promise(() => {}), Date.now() + 10),
    ).rejects.toMatchObject({ code: "offline", reason: "timeout", delivery: "not_sent" });
    await expect(runnerTokenBefore(async () => "unused", 0)).rejects.toMatchObject({
      delivery: "not_sent",
    });
  });
  it("mints once per Session, reuses the token, and refreshes it at two thirds of its life", async () => {
    let now = 1_000_000;
    const { client, calls } = scripted((call) =>
      call.path === "agentTokens:mint" ? grant() : "ok",
    );
    const backend = createAgentBackend({
      functions: client,
      runnerToken: async () => "runner",
      connected: () => true,
      now: () => now,
    });
    await Promise.all([
      backend.query(SESSION, "board:roster", {}),
      backend.query(SESSION, "board:roster", {}),
    ]);
    expect(calls.filter((call) => call.path === "agentTokens:mint")).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: "action",
      token: "runner",
      args: { sessionId: SESSION },
    });
    now += 900_000 * AGENT_TOKEN_REFRESH_AT - 1;
    await backend.query(SESSION, "board:roster", {});
    expect(calls.filter((call) => call.path === "agentTokens:mint")).toHaveLength(1);
    now += 2;
    await backend.query(SESSION, "board:roster", {});
    expect(calls.filter((call) => call.path === "agentTokens:mint")).toHaveLength(2);
    backend.forget(SESSION);
    await backend.mutation(SESSION, "board:createComment", {});
    expect(calls.filter((call) => call.path === "agentTokens:mint")).toHaveLength(3);
    expect(calls.at(-1)).toMatchObject({ kind: "mutation", path: "board:createComment" });
  });

  it("a token the backend fenced or no longer accepts is dropped, and the call tried once more", async () => {
    const refusals: string[] = ["unauthenticated"];
    const { client, calls } = scripted((call) => {
      if (call.path === "agentTokens:mint") return grant();
      const code = refusals.shift();
      return code === undefined ? "ok" : new CloudFunctionError(code, code);
    });
    const backend = createAgentBackend({
      functions: client,
      runnerToken: async () => "runner",
      connected: () => true,
    });
    const mints = () => calls.filter((call) => call.path === "agentTokens:mint").length;
    // An expired token (a sleep) works again under a fresh one.
    await expect(
      backend.mutation(SESSION, "board:createComment", { commandId: "c" }),
    ).resolves.toBe("ok");
    expect(mints()).toBe(2);
    const writes = calls.filter((call) => call.path === "board:createComment");
    expect(new Set(writes.map((call) => call.token)).size).toBe(2);
    expect(writes[1]!.args).toBe(writes[0]!.args);

    // Still fenced under the fresh one: refused, and that token is dropped too.
    refusals.push("fenced", "fenced");
    await expect(backend.query(SESSION, "board:roster", {})).rejects.toMatchObject({
      code: "fenced",
    });
    expect(mints()).toBe(3);
    await backend.query(SESSION, "board:roster", {});
    expect(mints()).toBe(4);

    // Any other refusal keeps the token.
    refusals.push("not_found");
    await expect(backend.query(SESSION, "board:roster", {})).rejects.toMatchObject({
      code: "not_found",
    });
    await backend.query(SESSION, "board:roster", {});
    expect(mints()).toBe(4);
  });

  it("no time left: no retry under a fresh token, no resend, no call at all", async () => {
    let now = 0;
    const { client, calls } = scripted((call) => {
      if (call.path === "agentTokens:mint") return grant();
      now += 9_500;
      return call.kind === "mutation"
        ? new CloudOfflineError("timeout", "slow")
        : new CloudFunctionError("fenced", "fenced");
    });
    const backend = createAgentBackend({
      functions: client,
      runnerToken: async () => "runner",
      connected: () => true,
      now: () => now,
    });
    await expect(
      backend.query(SESSION, "board:roster", {}, { deadline: 10_000 }),
    ).rejects.toMatchObject({ code: "fenced" });
    now = 0;
    await expect(
      backend.mutation(SESSION, "board:createComment", {}, { deadline: 10_000 }),
    ).rejects.toMatchObject({ reason: "timeout" });
    expect(calls.filter((call) => call.path === "board:createComment")).toHaveLength(1);
    await expect(backend.query(SESSION, "board:roster", {}, { deadline: 0 })).rejects.toMatchObject(
      { reason: "timeout", delivery: "not_sent" },
    );
  });

  it("a resend that met a closed door still may have landed the first attempt", async () => {
    const answers: unknown[] = [
      new CloudOfflineError("timeout", "slow"),
      new CloudOfflineError("network", "refused", "not_sent"),
    ];
    const { client } = scripted((call) =>
      call.path === "agentTokens:mint" ? grant() : answers.shift(),
    );
    const backend = createAgentBackend({
      functions: client,
      runnerToken: async () => "runner",
      connected: () => true,
    });
    await expect(backend.mutation(SESSION, "board:createComment", {})).rejects.toMatchObject({
      delivery: "unknown",
    });
  });

  it("sends a mutation that lost to concurrent writes again, same arguments, after jittered doubling waits", async () => {
    let contended = 3;
    const { client, calls } = scripted((call) => {
      if (call.path === "agentTokens:mint") return grant();
      return contended-- > 0 ? new CloudContentionError("busy") : { applied: true };
    });
    const slept: number[] = [];
    const backend = createAgentBackend({
      functions: client,
      runnerToken: async () => "runner",
      connected: () => true,
      random: () => 0.5,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    const args = { commandId: "c-busy" };
    await expect(backend.mutation(SESSION, "board:createTicket", args)).resolves.toEqual({
      applied: true,
    });
    const writes = calls.filter((call) => call.path === "board:createTicket");
    expect(writes).toHaveLength(4);
    for (const write of writes) expect(write.args).toBe(args);
    expect(slept).toEqual([
      CONTENTION_BACKOFF_MS / 2,
      CONTENTION_BACKOFF_MS,
      CONTENTION_BACKOFF_MS * 2,
    ]);
  });

  it("is bounded: past its retries contention is the answer, and the waits stay under their cap", async () => {
    const { client, calls } = scripted((call) =>
      call.path === "agentTokens:mint" ? grant() : new CloudContentionError("busy"),
    );
    const slept: number[] = [];
    const backend = createAgentBackend({
      functions: client,
      runnerToken: async () => "runner",
      connected: () => true,
      random: () => 0.999,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    const error = await backend
      .mutation(SESSION, "board:moveTickets", { commandId: "c" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudContentionError);
    expect(error).toMatchObject({ code: "contention" });
    expect(calls.filter((call) => call.path === "board:moveTickets")).toHaveLength(
      CONTENTION_RETRIES + 1,
    );
    expect(slept).toHaveLength(CONTENTION_RETRIES);
    expect(Math.max(...slept)).toBeLessThan(CONTENTION_BACKOFF_MAX_MS);
  });

  it("never waits past the deadline for contention, and never resends a read or another refusal", async () => {
    let now = 0;
    const { client, calls } = scripted((call) => {
      if (call.path === "agentTokens:mint") return grant();
      if (call.path === "board:createComment") return new CloudFunctionError("not_found", "gone");
      return new CloudContentionError("busy");
    });
    const backend = createAgentBackend({
      functions: client,
      runnerToken: async () => "runner",
      connected: () => true,
      now: () => now,
      random: () => 0.5,
      sleep: async (ms) => {
        now += ms;
      },
    });
    // Too little time left for a wait and a useful attempt: answered at once.
    await expect(
      backend.mutation(SESSION, "board:moveTickets", {}, { deadline: 1_000 }),
    ).rejects.toBeInstanceOf(CloudContentionError);
    expect(calls.filter((call) => call.path === "board:moveTickets")).toHaveLength(1);
    // A query that met contention (it cannot, but a read is never resent).
    await expect(backend.query(SESSION, "board:roster", {})).rejects.toBeInstanceOf(
      CloudContentionError,
    );
    expect(calls.filter((call) => call.path === "board:roster")).toHaveLength(1);
    // A function's own refusal is an answer, sent once.
    await expect(backend.mutation(SESSION, "board:createComment", {})).rejects.toMatchObject({
      code: "not_found",
    });
    expect(calls.filter((call) => call.path === "board:createComment")).toHaveLength(1);
  });

  it("contention after a timed-out attempt leaves the outcome unknown: the first one may have landed", async () => {
    const answers: unknown[] = [new CloudOfflineError("timeout", "slow")];
    const { client } = scripted((call) =>
      call.path === "agentTokens:mint"
        ? grant()
        : (answers.shift() ?? new CloudContentionError("busy")),
    );
    const backend = createAgentBackend({
      functions: client,
      runnerToken: async () => "runner",
      connected: () => true,
      sleep: async () => {},
    });
    const error = await backend
      .mutation(SESSION, "board:createComment", { commandId: "c" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudOfflineError);
    expect(error).toMatchObject({ reason: "timeout", delivery: "unknown" });
  });

  it("a timed-out attempt stays possibly landed across a fresh token: contention after it is not BUSY", async () => {
    const answers: unknown[] = [
      new CloudOfflineError("timeout", "slow"),
      new CloudFunctionError("unauthenticated", "expired"),
    ];
    const { client, calls } = scripted((call) =>
      call.path === "agentTokens:mint"
        ? grant()
        : (answers.shift() ?? new CloudContentionError("busy")),
    );
    const backend = createAgentBackend({
      functions: client,
      runnerToken: async () => "runner",
      connected: () => true,
      sleep: async () => {},
    });
    const error = await backend
      .mutation(SESSION, "board:createComment", { commandId: "c" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudOfflineError);
    expect(error).toMatchObject({ reason: "timeout", delivery: "unknown" });
    // Two tokens; one timeout resend in all, then the contention retries.
    expect(calls.filter((call) => call.path === "agentTokens:mint")).toHaveLength(2);
    expect(calls.filter((call) => call.path === "board:createComment")).toHaveLength(
      2 + CONTENTION_RETRIES + 1,
    );
  });

  it("a timeout after contention is still resent once", async () => {
    const answers: unknown[] = [
      new CloudContentionError("busy"),
      new CloudOfflineError("timeout", "slow"),
      "ok",
    ];
    const { client, calls } = scripted((call) =>
      call.path === "agentTokens:mint" ? grant() : answers.shift(),
    );
    const backend = createAgentBackend({
      functions: client,
      runnerToken: async () => "runner",
      connected: () => true,
      sleep: async () => {},
    });
    await expect(backend.mutation(SESSION, "board:createComment", {})).resolves.toBe("ok");
    expect(calls.filter((call) => call.path === "board:createComment")).toHaveLength(3);
  });

  it("a brand-new Session with too little time left is not yet synced at once", async () => {
    const { client } = scripted(() => new CloudFunctionError("unknown_session", "not yet"));
    let now = 0;
    const backend = createAgentBackend({
      functions: client,
      runnerToken: async () => "runner",
      connected: () => true,
      now: () => now,
      sleep: async () => {
        throw new Error("no time to sleep");
      },
    });
    now = 9_000;
    await expect(
      backend.query(SESSION, "board:roster", {}, { deadline: 10_000 }),
    ).rejects.toBeInstanceOf(NotYetSyncedError);
  });

  it("is offline before any request while the link is down", async () => {
    const { client, calls } = scripted(() => "ok");
    const backend = createAgentBackend({
      functions: client,
      runnerToken: async () => "runner",
      connected: () => false,
    });
    const error = await backend
      .query(SESSION, "board:roster", {})
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudOfflineError);
    expect(error).toMatchObject({ reason: "link_down" });
    expect(calls).toEqual([]);
  });

  it("resends a timed-out mutation once with the same arguments; a timed-out read is not resent", async () => {
    const { client, calls } = scripted((call) =>
      call.path === "agentTokens:mint" ? grant() : new CloudOfflineError("timeout", "slow"),
    );
    const backend = createAgentBackend({
      functions: client,
      runnerToken: async () => "runner",
      connected: () => true,
    });
    const args = { commandId: "c-1" };
    await expect(backend.mutation(SESSION, "board:createComment", args)).rejects.toMatchObject({
      reason: "timeout",
    });
    const writes = calls.filter((call) => call.path === "board:createComment");
    expect(writes).toHaveLength(2);
    expect(writes[1]!.args).toBe(writes[0]!.args);
    await expect(backend.query(SESSION, "board:roster", {})).rejects.toMatchObject({
      reason: "timeout",
    });
    expect(calls.filter((call) => call.path === "board:roster")).toHaveLength(1);
  });

  it("a Session the backend has not seen yet nudges the drain, retries once, then is not yet synced", async () => {
    const nudged: string[] = [];
    const slept: number[] = [];
    let unknownFor = 1;
    const { client, calls } = scripted((call) => {
      if (call.path !== "agentTokens:mint") return "ok";
      if (unknownFor-- > 0) return new CloudFunctionError("unknown_session", "not yet");
      return grant();
    });
    const backend = createAgentBackend({
      functions: client,
      runnerToken: async () => "runner",
      connected: () => true,
      nudgeDrain: (sessionId) => nudged.push(sessionId),
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await expect(backend.query(SESSION, "board:roster", {})).resolves.toBe("ok");
    expect(nudged).toEqual([SESSION]);
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeLessThanOrEqual(5_000);

    backend.forget(SESSION);
    unknownFor = 2;
    const error = await backend
      .query(SESSION, "board:roster", {})
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotYetSyncedError);
    expect(error).toMatchObject({ code: "not_yet_synced", sessionId: SESSION });
    expect(calls.filter((call) => call.path === "agentTokens:mint")).toHaveLength(4);
  });

  it("other mint refusals pass through, before or after the retry", async () => {
    const answers: unknown[] = [new CloudFunctionError("not_claimed", "elsewhere")];
    const { client } = scripted(() => answers.shift() ?? "ok");
    const backend = createAgentBackend({
      functions: client,
      runnerToken: async () => "runner",
      connected: () => true,
      sleep: async () => {},
    });
    await expect(backend.query(SESSION, "board:roster", {})).rejects.toMatchObject({
      code: "not_claimed",
    });
    answers.push(
      new CloudFunctionError("unknown_session", "not yet"),
      new CloudFunctionError("revoked", "gone"),
    );
    await expect(backend.query(SESSION, "board:roster", {})).rejects.toMatchObject({
      code: "revoked",
    });
  });

  it("a runner that lost its link mints nothing", async () => {
    const { client, calls } = scripted(() => "ok");
    const backend = createAgentBackend({
      functions: client,
      runnerToken: async () => null,
      connected: () => true,
    });
    await expect(backend.query(SESSION, "board:roster", {})).rejects.toMatchObject({
      code: "revoked",
    });
    expect(calls).toEqual([]);
  });

  it("waits on its own timer by default", async () => {
    let unknownFor = 1;
    const { client } = scripted((call) => {
      if (call.path !== "agentTokens:mint") return "ok";
      return unknownFor-- > 0 ? new CloudFunctionError("unknown_session", "not yet") : grant();
    });
    const backend = createAgentBackend({
      functions: client,
      runnerToken: async () => "runner",
      connected: () => true,
    });
    const started = Date.now();
    await expect(backend.query(SESSION, "board:roster", {})).resolves.toBe("ok");
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
  });
});
