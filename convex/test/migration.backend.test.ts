/**
 * The migration dry run end to end, against the real pinned backend: the
 * synthetic profile (host-core's test support) is written, then the real
 * harness snapshots it read-only, runs the real exporter, imports through
 * `migration:importRows` over HTTP with the admin key, verifies, and runs the
 * import again. Both steps are child processes, as a person runs them.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vite-plus/test";

const HOST_CORE = fileURLToPath(new URL("../../packages/host-core/", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "volli-migration-dry-run-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function node(script: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--no-warnings",
      join(HOST_CORE, "scripts", script),
      ...args,
    ],
    { cwd: HOST_CORE, env, encoding: "utf8", timeout: 240_000, maxBuffer: 64 * 1024 * 1024 },
  );
  return result;
}

type Report = {
  ok: boolean;
  failures: string[];
  cleanedUp: boolean;
  streams: Record<
    string,
    {
      inserted: number;
      conflicts: number;
      match: boolean;
      skippedRemoved: number;
      rejected: Record<string, number>;
      rerun?: { inserted: number };
    }
  >;
  sessions: {
    hot: number;
    archived: number;
    kindUnknown: number;
    quarantined: number;
    spilled: Record<string, number>;
  };
  objects: { blobs: { copied: number }; legacyRows: number };
  history: { transcriptArtifacts: number; piLogSlices: number; bytes: number };
  invariants: Record<string, number>;
};

describe("the migration dry run", () => {
  test("imports a synthetic profile, verifies it, and a second run changes nothing", () => {
    const profileDir = join(work, "profile");
    const fixture = node("migration-dry-run-fixture.mjs", [profileDir, "--move"]);
    expect(fixture.status, fixture.stderr).toBe(0);
    const dbPath = fixture.stdout.trim();
    const before = statSync(dbPath).mtimeMs;
    const tempRoot = join(work, "tmp");
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot);

    const run = node("migration-dry-run.mjs", ["--profile", dbPath, "--home-dir", profileDir], {
      ...process.env,
      TMPDIR: tempRoot,
      CONVEX_SELF_HOSTED_URL: process.env.VOLLI_CONVEX_URL,
      CONVEX_SELF_HOSTED_ADMIN_KEY: process.env.VOLLI_CONVEX_ADMIN_KEY,
    });
    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout) as Report;

    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.cleanedUp).toBe(true);
    // Nothing of the copy, its sidecars, the export or the stand-ins is left behind.
    expect(readdirSync(tempRoot)).toEqual([]);
    // The profile itself was only read.
    expect(statSync(dbPath).mtimeMs).toBe(before);
    expect(existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0).toBe(0);

    for (const [stream, entry] of Object.entries(report.streams)) {
      expect(entry.rejected, stream).toEqual({});
      expect(entry.match, stream).toBe(true);
      expect(entry.conflicts, stream).toBe(0);
      expect(entry.rerun?.inserted ?? 0, stream).toBe(0);
    }
    expect(report.streams.tickets).toMatchObject({ inserted: 5, skippedRemoved: 1 });
    expect(report.streams.boardEvents!.inserted).toBe(5);
    expect(report.streams.configEntries!.inserted).toBeGreaterThan(0);
    expect(report.sessions).toMatchObject({
      hot: 2,
      archived: 1,
      kindUnknown: 3,
      quarantined: 1,
      spilled: { oversize: 1, "field name the backend refuses": 1 },
    });
    expect(report.objects.blobs.copied).toBe(2);
    expect(report.objects.legacyRows).toBe(4);
    expect(report.history.transcriptArtifacts).toBe(2048);
    expect(report.history.piLogSlices).toBeGreaterThan(1);
    expect(report.history.bytes).toBeGreaterThan(50 * 1024 * 1024);
    expect(report.streams.projects!.inserted).toBe(2);
    expect(report.streams.sessions!.inserted).toBe(3);
    expect(report.streams.runnerJobs!.inserted).toBe(0);
    expect(report.streams.automationArmings!.inserted).toBe(0);
    expect(
      Object.keys(report.invariants).filter((name) => name.startsWith("structuralPathHits")),
    ).toEqual([]);
    expect(report.invariants.placeholdersLeft ?? 0).toBe(0);
  }, 300_000);

  test("refuses a backend that is not on this machine", () => {
    const run = node("migration-dry-run.mjs", ["--profile", join(work, "absent.db")], {
      ...process.env,
      CONVEX_SELF_HOSTED_URL: "https://example.convex.cloud",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "key",
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("only talks to a local backend");
  });
});
