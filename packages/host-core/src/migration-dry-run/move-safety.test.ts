import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  assertCopyPaths,
  assertProfileIdle,
  assertReportPath,
  rehearsalTarget,
} from "./move-safety";

const { lsof } = vi.hoisted(() => ({ lsof: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: lsof }));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.resetAllMocks();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rehearsal-rules-"));
  roots.push(root);
  const source = join(root, "source"),
    live = join(root, "live"),
    scratch = join(root, "scratch");
  mkdirSync(source);
  mkdirSync(live);
  return { root, source, live, scratch };
}

describe("rehearsal target", () => {
  test("requires explicit production consent, including URL normalization", () => {
    expect(() => rehearsalTarget("https://ROSY-CARDINAL-131.convex.cloud/")).toThrow(
      "production_target_refused",
    );
    expect(rehearsalTarget("https://rosy-cardinal-131.convex.cloud", true)).toContain(
      "rosy-cardinal",
    );
    expect(rehearsalTarget("https://my-staging.convex.cloud")).toBe(
      "https://my-staging.convex.cloud",
    );
    expect(rehearsalTarget("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  });
  test.each([
    "file:///tmp/data",
    "http://my-staging.convex.cloud",
    "https://user:token@staging.convex.cloud",
    "https://staging.convex.cloud/path",
    "https://staging.convex.cloud/?token=secret",
    "https://example.com",
    "https://rosy-cardinal-131.convex.cloud.evil.test",
    "https://staging.convex.cloud/#secret",
  ])("rejects %s", (url) => expect(() => rehearsalTarget(url)).toThrow());
});

describe("profile separation", () => {
  test("allows cloning a quit live source only into a new, separate scratch directory", () => {
    const f = fixture();
    expect(() => assertCopyPaths(f.live, f.scratch, f.live)).not.toThrow();
    expect(() => assertCopyPaths(f.source, f.live, f.live)).toThrow();
    expect(() => assertCopyPaths(f.source, `${f.live}-dev`, f.live)).toThrow();
    expect(() => assertCopyPaths(f.source, join(f.live, "copy"), f.live)).toThrow();
    expect(() => assertCopyPaths(f.source, f.root, f.live)).toThrow();
    expect(() => assertCopyPaths(f.source, join(f.source, "copy"), f.live)).toThrow();
    mkdirSync(f.scratch);
    expect(() => assertCopyPaths(f.source, f.scratch, f.live)).toThrow("must_not_exist");
  });
  test("resolves symlink ancestors and refuses aliases of the live directory", () => {
    const f = fixture();
    const alias = join(f.root, "alias");
    symlinkSync(f.live, alias);
    expect(() => assertCopyPaths(f.source, join(alias, "copy"), f.live)).toThrow();
  });
});

test("reports cannot overwrite a profile, an existing file, or a symlink", () => {
  const f = fixture();
  expect(() =>
    assertReportPath(f.source, f.scratch, join(f.source, "report.json"), f.live),
  ).toThrow();
  expect(() =>
    assertReportPath(f.source, f.scratch, join(f.live, "report.json"), f.live),
  ).toThrow();
  const output = join(f.root, "report.json");
  expect(() => assertReportPath(f.source, f.scratch, output, f.live)).not.toThrow();
  symlinkSync(join(f.live, "volli.db"), output);
  // Opening output with O_EXCL also rejects dangling symlinks at the write boundary.
  writeFileSync(join(f.live, "volli.db"), "private");
  expect(() => assertReportPath(f.source, f.scratch, output, f.live)).toThrow();
});

describe("app liveness", () => {
  test.each(["volli.sock", "SingletonSocket", "SingletonLock"])(
    "refuses %s even if stale",
    (marker) => {
      const f = fixture();
      symlinkSync("absent-host-99999", join(f.source, marker));
      expect(() => assertProfileIdle(f.source)).toThrow("app_marker");
      expect(lsof).not.toHaveBeenCalled();
    },
  );
  test("refuses any open database, unavailable lsof and permission errors", () => {
    const f = fixture();
    writeFileSync(join(f.source, "volli.db"), "");
    lsof.mockReturnValue("1234\n");
    expect(() => assertProfileIdle(f.source)).toThrow("database_is_open");
    lsof.mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    expect(() => assertProfileIdle(f.source)).toThrow("missing");
    lsof.mockImplementation(() => {
      throw Object.assign(new Error("denied"), { status: 1, stderr: Buffer.from("denied") });
    });
    expect(() => assertProfileIdle(f.source)).toThrow("denied");
    lsof.mockImplementation(() => {
      throw Object.assign(new Error("no matches"), { status: 1, stderr: Buffer.alloc(0) });
    });
    expect(() => assertProfileIdle(f.source)).not.toThrow();
  });
});
