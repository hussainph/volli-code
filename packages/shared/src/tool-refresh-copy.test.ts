import { describe, expect, it } from "vite-plus/test";
import { verbEntry, type VerbToolKey } from "./verb-registry";
import { sessionVerbToolDescription } from "./tool-refresh-copy";

describe("versioned refresh tool copy", () => {
  it.each([
    "mcp.install",
    "mcp.enable",
    "mcp.tools",
    "mcp.remove",
    "session.delegate",
    "watch",
  ] as const)("preserves legacy bytes for %s", (key) => {
    expect(sessionVerbToolDescription(key)).toBe(verbEntry(key)?.tool?.description);
  });
  it("explains cache-safe additions and inheritance on new descriptions", () => {
    expect(sessionVerbToolDescription("mcp.install", true)).toContain("before the next program");
    expect(sessionVerbToolDescription("mcp.install", true)).not.toContain("do NOT appear");
    expect(sessionVerbToolDescription("mcp.enable", true)).toContain("before the next program");
    expect(sessionVerbToolDescription("mcp.disable", true)).toContain("tools they already hold");
    expect(sessionVerbToolDescription("mcp.tools", true)).toContain("keep every tool");
    expect(sessionVerbToolDescription("mcp.remove", true)).toContain("named unavailable error");
    expect(sessionVerbToolDescription("session.delegate", true)).toContain(
      "including refreshed additions",
    );
    expect(sessionVerbToolDescription("watch", true)).toBe(verbEntry("watch")?.tool?.description);
    expect(sessionVerbToolDescription("not-a-verb" as VerbToolKey, true)).toBeUndefined();
  });
});
