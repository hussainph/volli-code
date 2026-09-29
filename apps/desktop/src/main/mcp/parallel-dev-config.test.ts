import { describe, expect, it } from "vite-plus/test";

import { MCP_PARALLEL_DEV_ENV, readMcpParallelDevConfig } from "./parallel-dev-config";

const dev = { packaged: false };

function read(value: unknown, options = dev) {
  return readMcpParallelDevConfig(
    { [MCP_PARALLEL_DEV_ENV]: typeof value === "string" ? value : JSON.stringify(value) },
    options,
  );
}

describe("readMcpParallelDevConfig (VC-454)", () => {
  it("is off unless an unpackaged build is given a value", () => {
    expect(readMcpParallelDevConfig({}, dev)).toEqual({ kind: "off" });
    expect(read("   ")).toEqual({ kind: "off" });
    // A shipped app never reads it, however it is launched.
    expect(read({ reads: ["github:search"] }, { packaged: true })).toEqual({ kind: "off" });
  });

  it("reads exact server:tool keys and host-authored per-server limits", () => {
    const result = read({
      reads: ["github:search_issues", "fixture-1:ns:read/thing"],
      limits: {
        github: { maxConcurrent: 2, maxStarts: 6, windowMs: 100 },
        "fixture-1": { maxConcurrent: 3 },
      },
    });
    expect(result).toEqual({
      kind: "on",
      config: {
        reads: new Set(["github:search_issues", "fixture-1:ns:read/thing"]),
        limits: new Map([
          ["github", { maxConcurrent: 2, maxStarts: 6, windowMs: 100 }],
          ["fixture-1", { maxConcurrent: 3, maxStarts: Infinity, windowMs: 1_000 }],
        ]),
      },
    });
    // An empty object still turns the switch on: marks already frozen into
    // Sessions take effect, and nothing new is marked.
    expect(read({})).toEqual({ kind: "on", config: { reads: new Set(), limits: new Map() } });
  });

  it.each([
    ["not JSON", "{reads:", /ignored: .+/],
    ["an array", [], /must be a JSON object/],
    ["an unknown field", { reads: [], parallel: true }, /unknown field "parallel"/],
    ["reads that are not a list", { reads: "github:search" }, /reads must be an array/],
    ["a non-string read", { reads: [7] }, /must be a string/],
    [
      "a missing concurrency",
      { limits: { github: { maxStarts: 2 } } },
      /maxConcurrent must be a number/,
    ],
    [
      "a string window",
      { limits: { github: { maxConcurrent: 1, windowMs: "100" } } },
      /windowMs must be a number/,
    ],
    ["a read with no tool", { reads: ["github:"] }, /is not "<serverId>:<toolName>"/],
    ["a read with no colon", { reads: ["github"] }, /is not "<serverId>:<toolName>"/],
    ["a read with a bad server id", { reads: ["git hub:search"] }, /is not/],
    ["an overlong tool name", { reads: [`github:${"x".repeat(129)}`] }, /too long/],
    ["limits that are not an object", { limits: [] }, /limits must be an object/],
    ["a limits key that is not a server id", { limits: { "a b": {} } }, /is not a server id/],
    ["limits that are not an object per server", { limits: { github: 2 } }, /must be an object/],
    ["a zero concurrency", { limits: { github: { maxConcurrent: 0 } } }, /maxConcurrent/],
    [
      "a fractional start budget",
      { limits: { github: { maxConcurrent: 1, maxStarts: 1.5 } } },
      /maxStarts/,
    ],
  ])("ignores %s, failing closed with a reason", (_label, value, reason) => {
    const result = read(value);
    expect(result.kind).toBe("invalid");
    expect(result.kind === "invalid" ? result.reason : "").toMatch(reason);
    expect(result.kind === "invalid" ? result.reason : "").toMatch(/^VOLLI_DEV_MCP_PARALLEL/);
  });
});
