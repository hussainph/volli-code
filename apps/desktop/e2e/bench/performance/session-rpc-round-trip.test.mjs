import { describe, expect, it, vi } from "vitest";

import { sessionProjectionRequest, sessionRpcRoundTrip } from "./session-rpc-round-trip.mjs";

describe("Session RPC round-trip primitive", () => {
  it("publishes an exact JSON-safe transport request and measures only the bridge call", async () => {
    const request = sessionProjectionRequest("session-353");
    const bridge = {
      request: vi.fn(async () => ({ ok: true, data: { projection: {}, throughSequence: 9 } })),
    };
    const times = [100, 102.75];

    const result = await sessionRpcRoundTrip(request, bridge, () => times.shift());

    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
    expect(bridge.request).toHaveBeenCalledWith({
      procedure: "session.projection",
      input: { sessionId: "session-353" },
    });
    expect(result).toEqual({
      request,
      response: { ok: true, data: { projection: {}, throughSequence: 9 } },
      latencyMs: 2.75,
    });
  });

  it("rejects non-JSON requests and transport failures", async () => {
    await expect(
      sessionRpcRoundTrip(
        { procedure: "session.projection", input: { sequence: 1n } },
        { request: vi.fn() },
      ),
    ).rejects.toThrow("JSON-safe");
    await expect(
      sessionRpcRoundTrip(
        sessionProjectionRequest("session-353"),
        { request: async () => ({ ok: false, error: { code: "FAILED", message: "nope" } }) },
        () => 1,
      ),
    ).rejects.toThrow("request failed");
    expect(() => sessionProjectionRequest("")).toThrow("non-empty session id");
  });
});
