/**
 * The safety copy's clone-or-copy (VC-1105): which door each platform takes,
 * that a failed clone still copies, and, on a Mac, what a real clone is.
 */
import {
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { cloneOrCopyFile, type FileCloneDeps } from "./file-clone";

function deps(overrides: Partial<FileCloneDeps> = {}) {
  const calls: string[] = [];
  const at = new Date("2026-11-12T00:00:00Z");
  const fake: FileCloneDeps = {
    platform: "darwin",
    cloneWithCp: (source, target) => calls.push(`cp -c ${source} ${target}`),
    copyFile: (source, target, mode) => calls.push(`copy ${source} ${target} ${mode}`),
    touch: (target, when) => calls.push(`touch ${target} ${when.toISOString()}`),
    now: () => at,
    ...overrides,
  };
  return { fake, calls };
}

describe("cloneOrCopyFile", () => {
  it("clones with cp -c on a Mac and stamps the clone as taken now", () => {
    const { fake, calls } = deps();
    expect(cloneOrCopyFile("/a", "/b", fake)).toBe("cp-clone");
    expect(calls).toEqual(["cp -c /a /b", "touch /b 2026-11-12T00:00:00.000Z"]);
  });

  it("copies as before when cp fails", () => {
    const { fake, calls } = deps({
      cloneWithCp: () => {
        throw new Error("cp: exited 1");
      },
    });
    expect(cloneOrCopyFile("/a", "/b", fake)).toBe("copy");
    expect(calls).toEqual([`copy /a /b ${constants.COPYFILE_FICLONE}`]);
  });

  it("asks Node for a reflink everywhere else, never cp", () => {
    const cloneWithCp = vi.fn();
    const { fake, calls } = deps({ platform: "linux", cloneWithCp });
    expect(cloneOrCopyFile("/a", "/b", fake)).toBe("copy");
    expect(cloneWithCp).not.toHaveBeenCalled();
    expect(calls).toEqual([`copy /a /b ${constants.COPYFILE_FICLONE}`]);
  });

  describe("on this machine", () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    it("keeps the source's bytes as they were, however the source changes after", () => {
      dir = mkdtempSync(join(tmpdir(), "volli-file-clone-"));
      const source = join(dir, "source.db");
      const target = join(dir, "target.db");
      const original = Buffer.alloc(256 * 1024, 7);
      writeFileSync(source, original);
      // An old source: a clone would otherwise carry this time over.
      utimesSync(source, new Date("2020-01-01"), new Date("2020-01-01"));
      const before = Date.now();
      const method = cloneOrCopyFile(source, target);
      expect(method).toBe(process.platform === "darwin" ? "cp-clone" : "copy");
      writeFileSync(source, Buffer.alloc(256 * 1024, 9));
      expect(readFileSync(target)).toEqual(original);
      // Recovery orders safety copies by this time: it is when the copy was taken.
      expect(statSync(target).mtimeMs).toBeGreaterThanOrEqual(before - 1000);
    });
  });
});
