import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { cleanupRehearsalState, rehearsalMetrics, type RehearsalResult } from "./move-rehearsal";
import { rehearsalRedaction, type MoveJob } from "./move-worker";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function state() {
  const root = mkdtempSync(join(tmpdir(), "rehearsal-cleanup-"));
  roots.push(root);
  const file = join(root, "state.json");
  const job: MoveJob & { cleanupMoves: string[] } = {
    source: join(root, "source"),
    profile: join(root, "copy"),
    target: "http://127.0.0.1:3210",
    allowProduction: false,
    userId: "person",
    runnerId: "runner",
    workspaceId: "workspace",
    includeRemoved: false,
    operation: "run",
    cleanupMoves: ["a", "b"],
  };
  writeFileSync(file, JSON.stringify(job));
  vi.stubEnv("VOLLI_MOVE_TOKEN_FILE", "");
  vi.stubEnv("VOLLI_MOVE_TOKEN", "test-person-token");
  vi.stubEnv("VOLLI_MOVE_ADMIN_KEY", "test-admin-key");
  return { file, job };
}

test("cleanup aborts ALL imports before waiting, preserves recovery ids, then removes only its Workspace", async () => {
  const { file } = state();
  const calls: string[] = [];
  const aborted = new Set<string>();
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const {
      path,
      args: [args],
    } = JSON.parse(init.body as string) as {
      path: string;
      args: { moveId: string; workspaceId?: string; checkOnly?: boolean }[];
    };
    calls.push(`${path}:${args.moveId ?? ""}`);
    let value: unknown = {};
    if (path === "projectImports:status") {
      if (aborted.has(args.moveId)) expect(aborted.size).toBe(2);
      value = {
        status: aborted.has(args.moveId) ? "purged" : "committed",
        workspaceId: "workspace",
      };
    }
    if (path === "projectImports:abort") aborted.add(args.moveId);
    if (path === "migration:cleanupRehearsal") {
      expect(args.workspaceId).toBe("workspace");
      value = { done: !args.checkOnly };
    }
    return Response.json({ status: "success", value });
  });
  await cleanupRehearsalState(file);
  expect(calls.filter((c) => c.startsWith("projectImports:abort"))).toEqual([
    "projectImports:abort:a",
    "projectImports:abort:b",
  ]);
  expect(JSON.parse(readFileSync(file, "utf8")).cleanupMoves).toEqual(["a", "b"]);
});

test("cleanup cannot uncommit a foreign Workspace and keeps recovery state after auth failure", async () => {
  const { file } = state();
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const { path } = JSON.parse(init.body as string) as { path: string };
    calls.push(path);
    return Response.json({
      status: "success",
      value:
        path === "projectImports:status"
          ? { status: "committed", workspaceId: "foreign" }
          : { done: false },
    });
  });
  await expect(cleanupRehearsalState(file)).rejects.toThrow("foreign_import_cleanup_refused");
  expect(calls).not.toContain("projectImports:uncommit");
  vi.stubGlobal("fetch", async () => {
    throw new Error("expired auth");
  });
  await expect(cleanupRehearsalState(file)).rejects.toThrow();
  expect(JSON.parse(readFileSync(file, "utf8")).cleanupMoves).toEqual(["a", "b"]);
});

test("real targets require an explicit nonempty redaction inventory and use the runner's redactor", () => {
  const { file } = state();
  vi.stubEnv("VOLLI_MOVE_REDACTIONS_FILE", "");
  expect(() => rehearsalRedaction("https://staging.convex.cloud")).toThrow(
    "redaction_inventory_required",
  );
  vi.stubEnv("VOLLI_MOVE_REDACTIONS_FILE", file);
  writeFileSync(file, "[]");
  expect(() => rehearsalRedaction("https://staging.convex.cloud")).toThrow(
    "complete_redaction_inventory_required",
  );
  writeFileSync(file, JSON.stringify(["fixture-sensitive-value"]));
  const redactor = rehearsalRedaction("https://staging.convex.cloud");
  const result = redactor.step(Buffer.from("before fixture-sensitive-value after"), 0, true);
  expect(Buffer.from(result.bytes).toString()).toBe("before [REDACTED] after");
});

test("the report projection excludes ids, content, paths and future result fields", () => {
  const input = {
    outcome: "done",
    profileRefused: { "private-profile-key": 1 },
    token: "secret-token",
    projects: [
      {
        moveId: "private-move-id",
        state: "checked",
        rows: { tickets: 2, "/private/row-key": 3 },
        failureCode: null,
        refused: { "private-refusal-key": 4 },
        verified: true,
        realPath: true,
        title: "private-title",
        path: "/private/path",
        future: "secret-future",
      },
    ],
  };
  const report = JSON.stringify(rehearsalMetrics(input as RehearsalResult, 42));
  expect(JSON.parse(report)).toMatchObject({
    elapsedMs: 42,
    projects: [{ rows: { tickets: 2 }, verified: true }],
  });
  for (const value of ["private-", "/private/", "secret-"]) expect(report).not.toContain(value);
});
