import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import DesktopTestSequencer from "./test-sequencer.ts";

const durations = JSON.parse(
  readFileSync(new URL("./test-durations.json", import.meta.url), "utf8"),
);
const spec = (path, name = path.startsWith("src/main/") ? "main" : "renderer") => ({
  moduleId: fileURLToPath(new URL(`../${path}`, import.meta.url)),
  project: { name },
});
const split = (files, count, index) =>
  new DesktopTestSequencer({ config: { shard: { count, index } } }).shard(files);

test("recorded and fallback timing costs are finite and positive", () => {
  for (const cost of [...Object.values(durations.files), ...Object.values(durations.fallbackMs)]) {
    assert.ok(Number.isFinite(cost) && cost > 0);
  }
});

for (const count of [1, 2, 3, 4, 5, 8]) {
  test(`${count} shards partition live discovery exactly once, independent of discovery order`, async () => {
    const files = [
      ...Object.keys(durations.files).map((path) => spec(path)),
      ...Array.from({ length: 30 }, (_, i) => spec(`src/renderer/new-${i}.test.ts`)),
    ];
    const original = [...files];
    const shards = [];
    for (let i = 1; i <= count; i++) {
      const shard = await split(files, count, i);
      const reversed = await split(files.toReversed(), count, i);
      assert.deepEqual(shard, reversed);
      shards.push(shard);
    }
    assert.deepEqual(files, original, "input order must not be mutated");
    assert.equal(shards.flat().length, files.length);
    assert.deepEqual(new Set(shards.flat()), new Set(files));
  });
}

test("the expensive tail is distributed before new files, with no stale file selection", async () => {
  const heavy = Object.entries(durations.files)
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([path]) => spec(path));
  const unknown = spec("src/main/new.test.ts");
  const files = [...heavy, unknown];
  for (let i = 1; i <= 4; i++) {
    const shard = await split(files, 4, i);
    assert.equal(shard.filter((file) => heavy.includes(file)).length, 1);
    assert.ok(shard.every((file) => files.includes(file)));
  }
});

test("empty and unsharded selections retain their meaning", async () => {
  assert.deepEqual(await split([], 4, 2), []);
  const files = [spec("src/renderer/new.test.ts")];
  const sequencer = new DesktopTestSequencer({ config: {} });
  assert.equal(await sequencer.shard(files), files);
});

test("project identity is preserved when two projects discover the same path", async () => {
  const files = [spec("src/shared.test.ts", "main"), spec("src/shared.test.ts", "renderer")];
  const all = [...(await split(files, 2, 1)), ...(await split(files, 2, 2))];
  assert.deepEqual(new Set(all), new Set(files));
});
