/**
 * The first paint's inputs beside the database (VC-1203): what the check's
 * window reads before the database may be, and how the workbench keeps it.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DEFAULT_CANVAS } from "@volli/shared";

import {
  FIRST_PAINT_MIRROR_FILE_NAME,
  firstPaintMirrorPath,
  firstPaintMirrorWriter,
  readFirstPaintMirror,
  type FirstPaintMirror,
} from "./first-paint-mirror";
import { resolveFirstPaint } from "./window-theme";

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function mirrorPath(): string {
  dir = mkdtempSync(join(tmpdir(), "volli-first-paint-"));
  return firstPaintMirrorPath(join(dir, "volli.db"));
}

const stored: FirstPaintMirror = {
  hint: { appearance: "dark", background: "#34293a" },
  canvas: DEFAULT_CANVAS,
  appearance: "dark",
};

describe("readFirstPaintMirror", () => {
  it("sits beside the database", () => {
    expect(firstPaintMirrorPath("/profile/volli.db")).toBe(
      `/profile/${FIRST_PAINT_MIRROR_FILE_NAME}`,
    );
  });

  it("reads back what the workbench wrote, so the window opens in the stored look", async () => {
    const path = mirrorPath();
    await firstPaintMirrorWriter(path, () => {}).write(stored);
    const mirror = readFirstPaintMirror(path);
    expect(mirror).toEqual(stored);
    // An explicit appearance trusts the hint whatever the system says.
    expect(resolveFirstPaint({ ...mirror, systemPrefersDark: false })).toEqual(stored.hint);
  });

  it("is a first-ever launch's look when missing, broken or partly unreadable", () => {
    const path = mirrorPath();
    const empty = { hint: null, canvas: null, appearance: null };
    expect(readFirstPaintMirror(path)).toEqual(empty);
    writeFileSync(path, "{not json");
    expect(readFirstPaintMirror(path)).toEqual(empty);
    writeFileSync(path, "[]");
    expect(readFirstPaintMirror(path)).toEqual(empty);
    writeFileSync(
      path,
      JSON.stringify({
        hint: { appearance: "auto", background: "#123456" },
        canvas: { tokens: "a resolved ladder, not a canvas" },
        appearance: "dark",
      }),
    );
    expect(readFirstPaintMirror(path)).toEqual({ hint: null, canvas: null, appearance: "dark" });
    writeFileSync(path, JSON.stringify({ hint: { appearance: "dark", background: "url(x)" } }));
    expect(readFirstPaintMirror(path).hint).toBeNull();
  });
});

describe("firstPaintMirrorWriter", () => {
  it("writes in order, and an unchanged paint writes nothing", async () => {
    const path = mirrorPath();
    const writer = firstPaintMirrorWriter(path, () => {});
    const light: FirstPaintMirror = {
      ...stored,
      hint: { appearance: "light", background: "#f6d4c6" },
      appearance: "light",
    };
    void writer.write(stored);
    await writer.write(light);
    expect(readFirstPaintMirror(path)).toEqual(light);
    const written = statSync(path).mtimeMs;
    const before = readFileSync(path, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writer.write(light);
    expect(statSync(path).mtimeMs).toBe(written);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("settles once every write handed to it has landed, for an exit that cannot wait on Node", async () => {
    const path = mirrorPath();
    const writer = firstPaintMirrorWriter(path, () => {});
    await writer.settled();
    void writer.write(stored);
    await writer.settled();
    expect(readFirstPaintMirror(path)).toEqual(stored);
  });

  it("does not rewrite what an earlier launch left, and reports a failed write", async () => {
    const path = mirrorPath();
    await firstPaintMirrorWriter(path, () => {}).write(stored);
    const written = statSync(path).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await firstPaintMirrorWriter(path, () => {}).write(stored);
    expect(statSync(path).mtimeMs).toBe(written);

    const errors: unknown[] = [];
    const missing = join(dir!, "no-such-directory", FIRST_PAINT_MIRROR_FILE_NAME);
    await firstPaintMirrorWriter(missing, (error) => errors.push(error)).write(stored);
    expect(errors).toHaveLength(1);
  });
});
