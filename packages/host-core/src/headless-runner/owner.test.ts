import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  readRunnerOwner,
  resolveRunnerOwner,
  RUNNER_OWNER_FILE,
  runnerTokenOwner,
  writeRunnerOwner,
} from "./owner";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function dataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "runner-owner-"));
  roots.push(root);
  return root;
}
const token = (claims: unknown) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

describe("runnerTokenOwner", () => {
  it("reads the `own` claim", () => {
    expect(runnerTokenOwner(token({ sub: "r", own: "u-1" }))).toBe("u-1");
  });
  it.each([
    ["no payload", "only-a-header"],
    ["a payload that is not JSON", "h.bm90IGpzb24.s"],
    ["a payload that is not an object", token(7)],
    ["no claim", token({ sub: "r" })],
    ["an empty claim", token({ own: "" })],
    ["a claim that is not a string", token({ own: 3 })],
  ])("answers null for %s", (_, value) => {
    expect(runnerTokenOwner(value)).toBeNull();
  });
});

describe("the kept owner", () => {
  it("round-trips per runner, owner-only, and ignores another runner's or a damaged file", () => {
    const dir = dataDir();
    expect(readRunnerOwner(dir, "r1")).toBeNull();
    writeRunnerOwner(dir, "r1", "u-1");
    expect(readRunnerOwner(dir, "r1")).toBe("u-1");
    expect(readRunnerOwner(dir, "r2")).toBeNull();
    expect(statSync(join(dir, RUNNER_OWNER_FILE)).mode & 0o777).toBe(0o600);
    writeFileSync(join(dir, RUNNER_OWNER_FILE), "{not json");
    expect(readRunnerOwner(dir, "r1")).toBeNull();
    writeFileSync(
      join(dir, RUNNER_OWNER_FILE),
      JSON.stringify({ v: 2, runnerId: "r1", ownerUserId: "u" }),
    );
    expect(readRunnerOwner(dir, "r1")).toBeNull();
  });
});

describe("resolveRunnerOwner", () => {
  const never = new AbortController().signal;
  it("answers the kept owner without a token", async () => {
    const dir = dataDir();
    writeRunnerOwner(dir, "r1", "u-1");
    const fetch = vi.fn();
    await expect(
      resolveRunnerOwner({ dataDir: dir, runnerId: "r1", token: fetch, signal: never }),
    ).resolves.toEqual({ kind: "owner", ownerUserId: "u-1" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries an unreachable backend with a doubling wait, then keeps what the token names", async () => {
    const dir = dataDir();
    const waits: number[] = [];
    const tokenFor = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(token({ own: "u-2" }));
    const outcome = await resolveRunnerOwner({
      dataDir: dir,
      runnerId: "r1",
      token: tokenFor,
      signal: never,
      wait: async (ms) => void waits.push(ms),
    });
    expect(outcome).toEqual({ kind: "owner", ownerUserId: "u-2" });
    expect(waits).toEqual([1_000, 2_000]);
    expect(readRunnerOwner(dir, "r1")).toBe("u-2");
  });

  it("answers lost when the link ends first, and stopped when aborted", async () => {
    const dir = dataDir();
    await expect(
      resolveRunnerOwner({ dataDir: dir, runnerId: "r1", token: async () => null, signal: never }),
    ).resolves.toEqual({ kind: "lost" });
    const abort = new AbortController();
    const outcome = resolveRunnerOwner({
      dataDir: dir,
      runnerId: "r1",
      token: async () => {
        throw new Error("offline");
      },
      signal: abort.signal,
    });
    abort.abort();
    await expect(outcome).resolves.toEqual({ kind: "stopped" });
  });

  it("refuses a token that names no owner", async () => {
    await expect(
      resolveRunnerOwner({
        dataDir: dataDir(),
        runnerId: "r1",
        token: async () => token({ sub: "r1" }),
        signal: never,
      }),
    ).rejects.toThrow(/does not name its owner/);
  });
});
