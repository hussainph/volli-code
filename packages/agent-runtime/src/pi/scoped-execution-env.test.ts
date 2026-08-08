import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { ScopedExecutionEnv } from "./scoped-execution-env";

function roots() {
  const parent = mkdtempSync(join(tmpdir(), "volli-scoped-env-"));
  const worktree = join(parent, "worktree");
  const outside = join(parent, "outside.txt");
  mkdirSync(worktree);
  writeFileSync(join(worktree, "inside.txt"), "inside\n");
  writeFileSync(outside, "outside\n");
  return { worktree, outside };
}

describe("ScopedExecutionEnv", () => {
  it("reads and writes ordinary files inside the Ticket worktree", async () => {
    const { worktree } = roots();
    const env = await ScopedExecutionEnv.create(worktree);

    expect(await env.absolutePath("inside.txt")).toEqual({
      ok: true,
      value: join(env.cwd, "inside.txt"),
    });
    expect(await env.exists("inside.txt")).toEqual({ ok: true, value: true });
    expect(await env.readTextFile("inside.txt")).toEqual({ ok: true, value: "inside\n" });
    expect(await env.readBinaryFile("inside.txt")).toMatchObject({ ok: true });
    expect(await env.fileInfo("inside.txt")).toMatchObject({
      ok: true,
      value: { kind: "file", path: join(env.cwd, "inside.txt") },
    });
    expect(await env.writeFile("written.txt", "written\n")).toEqual({
      ok: true,
      value: undefined,
    });
    expect(readFileSync(join(worktree, "written.txt"), "utf8")).toBe("written\n");
    await env.cleanup();
  });

  it("rejects absolute, parent-relative, symlink, and aborted paths", async () => {
    const { worktree, outside } = roots();
    symlinkSync(outside, join(worktree, "escape-link"));
    const env = await ScopedExecutionEnv.create(worktree);

    for (const result of [
      await env.readTextFile(outside),
      await env.readBinaryFile(outside),
      await env.fileInfo(outside),
      await env.exists(outside),
      await env.writeFile("../escape.txt", "no"),
      await env.readTextFile("escape-link"),
    ]) {
      expect(result).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    }

    const controller = new AbortController();
    controller.abort();
    expect(await env.absolutePath("inside.txt", controller.signal)).toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
    expect(await env.exists("missing.txt")).toEqual({ ok: true, value: false });
    expect(await env.absolutePath("inside.txt/child")).toMatchObject({
      ok: false,
      error: { code: "unknown" },
    });
  });

  it("does not expose unused filesystem or process capabilities", async () => {
    const { worktree } = roots();
    const env = await ScopedExecutionEnv.create(worktree);
    const unsupported = await Promise.all([
      env.joinPath(["a", "b"]),
      env.readTextLines("inside.txt"),
      env.appendFile("inside.txt", "x"),
      env.renameFile("inside.txt", "other.txt"),
      env.listDir("."),
      env.canonicalPath("inside.txt"),
      env.createDir("dir"),
      env.remove("inside.txt"),
      env.createTempDir(),
      env.createTempFile(),
    ]);
    for (const result of unsupported) {
      expect(result).toMatchObject({ ok: false, error: { code: "not_supported" } });
    }
    expect(await env.exec("pwd")).toMatchObject({
      ok: false,
      error: { code: "shell_unavailable" },
    });
  });
});
