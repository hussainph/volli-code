import { describe, expect, it } from "vite-plus/test";
import type { PiRuntimeHostOptions, ProviderFailureDiagnostic } from "@volli/agent-runtime";
import type { AgentRuntime } from "@volli/shared";

import { createPiRuntimeHost } from "./pi-adapter";

/** The host keeps this many; the support report names no more. */
const PROVIDER_FAILURE_HISTORY = 5;

const failure = (at: number): ProviderFailureDiagnostic => ({
  at,
  provider: "anthropic",
  model: "fixture",
  category: "bad-request",
  httpStatus: 400,
  raw: `400 {"error":{"message":"failure ${at}"}}`,
});

describe("the runtime host's provider failures (VC-1244)", () => {
  it("keeps the last few raw provider errors in memory, oldest first, as copies", () => {
    let options: PiRuntimeHostOptions | undefined;
    const runtime: AgentRuntime = {
      inspectModelAccess: async () => ({ observedAt: 0, providers: [], models: [] }),
      completeUtility: async () => ({ text: "", usage: null }),
      startSession: async () => {
        throw new Error("not attached in this test");
      },
    };
    const host = createPiRuntimeHost({
      sessionDataDir: "/unused",
      resolveRuntimeContext: async () => null,
      createRuntime: (given) => {
        options = given;
        return runtime;
      },
    });
    expect(host.recentProviderFailures()).toEqual([]);
    for (let at = 1; at <= PROVIDER_FAILURE_HISTORY + 2; at += 1) {
      options!.providerDiagnostics!(failure(at));
    }
    const recent = host.recentProviderFailures();
    expect(recent.map((entry) => entry.at)).toEqual([3, 4, 5, 6, 7]);
    // A caller's copy cannot change what the next report reads.
    (recent as ProviderFailureDiagnostic[]).length = 0;
    expect(host.recentProviderFailures()).toHaveLength(PROVIDER_FAILURE_HISTORY);
  });
});
