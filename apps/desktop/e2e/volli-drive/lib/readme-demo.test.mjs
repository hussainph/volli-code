import assert from "node:assert/strict";
import { test } from "node:test";
import { frameManifest } from "../readme-demo.mjs";

test("renderer capture preserves irregular frame timing and the final reading beat", () => {
  assert.equal(
    frameManifest(
      [
        { path: "/scratch/00000.png", at: 0.1 },
        { path: "/scratch/00001.png", at: 0.15 },
        { path: "/scratch/00002.png", at: 1.2 },
      ],
      4.2,
    ),
    "file '/scratch/00000.png'\noption framerate 1000\nduration 0.050000\nfile '/scratch/00001.png'\noption framerate 1000\nduration 1.050000\nfile '/scratch/00002.png'\noption framerate 1000\nduration 3.000000\nfile '/scratch/00002.png'\noption framerate 1000\n",
  );
});

test("empty, out-of-order and unsafe captures cannot become ffmpeg input", () => {
  assert.throws(() => frameManifest([], 1), /no frames/);
  assert.throws(() => frameManifest([{ path: "a", at: 2 }], 1), /timing/);
  assert.throws(() => frameManifest([{ path: "a", at: 0 }], NaN), /timing/);
  for (const path of ["a'b", "a\nb", "a\rb"]) {
    assert.throws(() => frameManifest([{ path, at: 0 }], 1), /unsafe/);
  }
});
