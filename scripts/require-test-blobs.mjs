#!/usr/bin/env node
// Compare against the actual matrix, not a count claimed by a downloaded blob:
// a partial upload must never become a smaller, apparently complete suite.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";

const [suite, directory] = process.argv.slice(2);
if (!["desktop", "host-core"].includes(suite) || !directory) {
  throw new Error("Usage: require-test-blobs.mjs <desktop|host-core> <directory>");
}
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);
const shards = workflow.jobs[`test-${suite}`].strategy.matrix.shard;
const expected = shards.map((shard) => `${suite}-${shard}-of-${shards.length}.json`).toSorted();
const actual = readdirSync(directory).toSorted();
if (
  JSON.stringify(actual) !== JSON.stringify(expected) ||
  actual.some(
    (file) =>
      !statSync(join(directory, file)).isFile() || statSync(join(directory, file)).size === 0,
  )
) {
  throw new Error(
    `Incomplete ${suite} blob reports: expected ${expected.join(", ")}; found ${actual.join(", ")}`,
  );
}
console.log(`All ${shards.length} ${suite} shard blobs present.`);
