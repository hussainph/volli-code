import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { HOME, resolveInputPath, resolvePathForPolicy, shellPathTokenToPath } from "./paths";

/** A real temporary tree. On macOS its root is itself a symlink, which is the point. */
function workspace(): { raw: string; real: string } {
  const raw = mkdtempSync(join(tmpdir(), "volli-authority-"));
  return { raw, real: realpathSync(raw) };
}

describe("resolveInputPath", () => {
  it("resolves a relative path against the workspace and leaves an absolute one alone", () => {
    expect(resolveInputPath("/work/ticket", "src/index.ts")).toBe("/work/ticket/src/index.ts");
    expect(resolveInputPath("/work/ticket", "  ../sibling/x  ")).toBe("/work/sibling/x");
    expect(resolveInputPath("/work/ticket", "/etc/hosts")).toBe("/etc/hosts");
  });

  it("does not strip a leading @, because Pi's own tools do not", () => {
    expect(resolveInputPath("/work", "@types/node/index.d.ts")).toBe(
      "/work/@types/node/index.d.ts",
    );
  });

  it("reports that a blank argument names no path", () => {
    expect(resolveInputPath("/work", "")).toBeUndefined();
    expect(resolveInputPath("/work", "   ")).toBeUndefined();
  });
});

describe("shellPathTokenToPath", () => {
  it("expands every spelling of the home directory, bare tilde included", () => {
    expect(shellPathTokenToPath("~", "/work")).toBe(HOME);
    expect(shellPathTokenToPath("$HOME", "/work")).toBe(HOME);
    expect(shellPathTokenToPath("${HOME}", "/work")).toBe(HOME);
    expect(shellPathTokenToPath("~/.zshrc", "/work")).toBe(resolve(HOME, ".zshrc"));
    expect(shellPathTokenToPath("$HOME/.ssh", "/work")).toBe(resolve(HOME, ".ssh"));
    expect(shellPathTokenToPath("${HOME}/.ssh", "/work")).toBe(resolve(HOME, ".ssh"));
  });

  it("resolves ordinary operands against the workspace", () => {
    expect(shellPathTokenToPath("build", "/work")).toBe("/work/build");
    expect(shellPathTokenToPath("  ./build  ", "/work")).toBe("/work/build");
    expect(shellPathTokenToPath("/etc/hosts", "/work")).toBe("/etc/hosts");
  });

  it("reports tokens that denote no location", () => {
    expect(shellPathTokenToPath("", "/work")).toBeUndefined();
    expect(shellPathTokenToPath("   ", "/work")).toBeUndefined();
    expect(shellPathTokenToPath("-", "/work")).toBeUndefined();
    expect(shellPathTokenToPath("&1", "/work")).toBeUndefined();
  });
});

describe("resolvePathForPolicy", () => {
  it("canonicalizes a path that exists", () => {
    const { raw, real } = workspace();
    writeFileSync(join(raw, "MARKER.txt"), "x");
    expect(resolvePathForPolicy(join(raw, "MARKER.txt"))).toBe(join(real, "MARKER.txt"));
  });

  it("resolves a file that does not exist yet through its nearest existing ancestor", () => {
    const { raw, real } = workspace();
    expect(resolvePathForPolicy(join(raw, "new.txt"))).toBe(join(real, "new.txt"));
    expect(resolvePathForPolicy(join(raw, "a", "b", "c.txt"))).toBe(join(real, "a/b/c.txt"));
  });

  it("follows a symlinked directory, including for a target inside it that is missing", () => {
    const { raw, real } = workspace();
    mkdirSync(join(raw, "actual"));
    symlinkSync(join(raw, "actual"), join(raw, "link"));
    expect(resolvePathForPolicy(join(raw, "link"))).toBe(join(real, "actual"));
    expect(resolvePathForPolicy(join(raw, "link", "new.txt"))).toBe(join(real, "actual/new.txt"));
  });

  it("resolves a dangling symlink to the path it points at", () => {
    const { raw, real } = workspace();
    symlinkSync(join(raw, "gone"), join(raw, "dangling"));
    expect(resolvePathForPolicy(join(raw, "dangling"))).toBe(join(real, "gone"));
  });

  it("refuses a symlink cycle rather than looping", () => {
    const { raw } = workspace();
    symlinkSync(join(raw, "b"), join(raw, "a"));
    symlinkSync(join(raw, "a"), join(raw, "b"));
    expect(resolvePathForPolicy(join(raw, "a"))).toBeUndefined();
  });

  it("refuses a path the filesystem cannot name at all", () => {
    const { raw } = workspace();
    expect(resolvePathForPolicy(join(raw, "x".repeat(400)))).toBeUndefined();
  });

  it("resolves through an ancestor that turns out to be a file", () => {
    const { raw, real } = workspace();
    writeFileSync(join(raw, "not-a-dir"), "x");
    expect(resolvePathForPolicy(join(raw, "not-a-dir", "child"))).toBe(
      join(real, "not-a-dir/child"),
    );
  });
});
