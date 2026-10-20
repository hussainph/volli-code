import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { canonicalize, isInside, samePath } from "./paths";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "volli-paths-"));
  dirs.push(dir);
  return dir;
}

describe("canonicalize", () => {
  it("resolves a symlink to its real target (macOS /private aliasing)", () => {
    const real = tempDir();
    const link = `${real}-link`;
    symlinkSync(real, link);
    dirs.push(link);
    expect(canonicalize(link)).toBe(canonicalize(real));
  });

  it("canonicalizes a not-yet-existing path via its deepest existing ancestor", () => {
    const root = tempDir();
    const future = join(root, "a", "b", "c");
    // The ancestor (root) is realpath'd; the missing tail is re-appended.
    expect(canonicalize(future)).toBe(join(canonicalize(root), "a", "b", "c"));
  });
});

describe("isInside", () => {
  it("accepts the root itself and a nested child", () => {
    const root = tempDir();
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, join(root, "sub", "file.txt"))).toBe(true);
  });

  it("rejects a ../escape and a sibling", () => {
    const root = tempDir();
    expect(isInside(root, join(root, "..", "secret.txt"))).toBe(false);
    expect(isInside(root, `${root}-sibling`)).toBe(false);
  });
});

describe("samePath", () => {
  it("treats a symlink and its target as the same location", () => {
    const real = tempDir();
    const link = `${real}-link`;
    symlinkSync(real, link);
    dirs.push(link);
    expect(samePath(real, link)).toBe(true);
  });
});
