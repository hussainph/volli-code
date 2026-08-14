import assert from "node:assert/strict";
import { test } from "node:test";

import { createRunner } from "./smoke-kit.mjs";

test("createRunner must summarizes a required failure before throwing", async (context) => {
  const lines = [];
  context.mock.method(console, "log", (line) => lines.push(line));
  const { must, results } = createRunner();

  await assert.rejects(
    must("2c", "required probe", async () => ({ ok: false, detail: "missing evidence" })),
    /required check 2c failed; refusing dependent smoke actions/,
  );

  assert.deepEqual(results, [{ n: "2c", ok: false }]);
  assert.deepEqual(lines, [
    "  [FAIL] 2c. required probe — missing evidence",
    "\n1 CHECK(S) FAILED: 2c",
  ]);
});
