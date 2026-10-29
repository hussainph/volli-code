import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertRestoreRestart } from "./restore-acceptance.mjs";

test("restore restart admits only the current real button in an isolated local fixture", () => {
  const current = { generation: 3, refs: new Set(["e7"]) };
  const args = { gen: 3, ref: "e7" };
  assert.doesNotThrow(() => assertRestoreRestart({}, current, args));
  for (const spec of [{ cloud: {} }, { deployment: {} }, { remoteAcceptance: {} }])
    assert.throws(() => assertRestoreRestart(spec, current, args), /isolated local/);
  assert.throws(() => assertRestoreRestart({}, current, { ...args, gen: 2 }), /stale/);
  assert.throws(() => assertRestoreRestart({}, current, { ...args, ref: "e8" }), /ref/);
  assert.throws(() => assertRestoreRestart({}, current, args, "Other button"), /not the product/);
});
test("the supervisor records only native relaunch, drives the real button, proves clean exit, and rechecks the guard", async () => {
  const source = await readFile(new URL("../supervisor.mjs", import.meta.url), "utf8");
  const body = source.slice(
    source.indexOf("async function restoreRestart("),
    source.indexOf("async function handle("),
  );
  assert.match(body, /assertRestoreRestart\(spec, current, args/);
  assert.match(body, /electronApp\.relaunch =/);
  assert.match(body, /await target\.click/);
  assert.match(body, /observedChildExit\(child, pid\)/);
  assert.match(body, /cleanQuitProblems\(close\)/);
  assert.match(body, /startElectron\(launchEnv\)/);
  assert.doesNotMatch(body, /window\.api|setState|SIGTERM|SIGKILL|\.kill\(/);
});
