import { createEditTool, createWriteTool } from "@earendil-works/pi-agent-core/node";
import { describe, expect, it } from "vite-plus/test";
import { normalizeToolPath } from "./pi-tool-path";

/**
 * What Pi's own normalization produces, read out of Pi rather than asserted from
 * memory. Every file tool resolves its `path` through `resolveToolPath`, which
 * calls the module-private `normalizeToolPath` and hands the result to
 * `env.absolutePath`; a stub that records that string and then throws yields the
 * exact output without needing the rest of the tool to run.
 */
async function whatPiWouldOpen(
  tool: ReturnType<typeof createWriteTool> | ReturnType<typeof createEditTool>,
  path: string,
): Promise<string> {
  let seen: string | undefined;
  const env = {
    absolutePath: async (candidate: string) => {
      seen = candidate;
      throw new Error("recorded");
    },
  };
  await expect(
    tool.execute(
      "tool-call-1",
      { path, content: "", edits: [{ oldText: "a", newText: "b" }] },
      undefined,
      undefined,
      { env } as never,
    ),
  ).rejects.toThrow("recorded");
  if (seen === undefined) throw new Error("Pi never resolved a path");
  return seen;
}

/** Every transformation in the upstream function, plus the shapes that must survive. */
const CASES = [
  "@.git/hooks/pre-commit",
  "@.volli/state.json",
  "@types/node/index.d.ts",
  "@@doubled",
  "@",
  "plain/path.ts",
  "no\u00A0break.txt",
  "en\u2000quad.txt",
  "hair\u200Aspace.txt",
  "narrow\u202Fnbsp.txt",
  "medium\u205Fmath.txt",
  "ideographic\u3000space.txt",
  "@mixed\u3000space/.git/config",
  "trailing ",
  "",
];

describe("normalizeToolPath", () => {
  it.each(CASES)("agrees with Pi's own normalization for %j", async (path) => {
    expect(normalizeToolPath(path)).toBe(await whatPiWouldOpen(createWriteTool(), path));
  });

  it("agrees for the edit tool too, which resolves through the same helper", async () => {
    const path = "@.git/hooks/pre-commit";
    expect(normalizeToolPath(path)).toBe(await whatPiWouldOpen(createEditTool(), path));
  });

  it("strips exactly one leading @ and collapses the Unicode spaces", () => {
    expect(normalizeToolPath("@.git/config")).toBe(".git/config");
    expect(normalizeToolPath("@@x")).toBe("@x");
    expect(normalizeToolPath("a\u3000b")).toBe("a b");
    expect(normalizeToolPath("mid@dle")).toBe("mid@dle");
  });
});
