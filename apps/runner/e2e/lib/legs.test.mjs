import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  describeMissing,
  exitCodeFor,
  missingPrerequisites,
  prerequisiteMet,
  redact,
  renderSummary,
  runLegs,
} from "./legs.mjs";

const root = mkdtempSync(join(tmpdir(), "byo-legs-"));
after(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, "convex/functions"), { recursive: true });
writeFileSync(join(root, "convex/functions/http.ts"), 'http.route({ path: "/runner/token" });\n');

const here = { ticket: "T-1", path: "convex/functions/http.ts" };
const absent = { ticket: "T-2", path: "apps/runner/package.json" };
const withText = {
  ticket: "T-3",
  path: "convex/functions/http.ts",
  contains: "/runner/github-token",
};

test("a prerequisite is a merged file, optionally holding some text", () => {
  assert.equal(prerequisiteMet(root, here), true);
  assert.equal(prerequisiteMet(root, absent), false);
  assert.equal(prerequisiteMet(root, withText), false);
  assert.equal(prerequisiteMet(root, { ...withText, contains: "/runner/token" }), true);
  assert.deepEqual(missingPrerequisites(root, { needs: [here, absent, withText] }), [
    absent,
    withText,
  ]);
  assert.equal(
    describeMissing([absent, withText]),
    'T-2: apps/runner/package.json; T-3: convex/functions/http.ts (with "/runner/github-token")',
  );
});

test("legs run in order: pass, fail, pending on unmerged work or no wiring, blocked downstream", async () => {
  const ran = [];
  const legs = [
    { id: "a", title: "A", run: async () => (ran.push("a"), "ok") },
    { id: "b", title: "B", after: ["a"], run: async () => ran.push("b") },
    { id: "c", title: "C", after: ["a"], needs: [absent] },
    { id: "d", title: "D", after: ["a"], needs: [here] },
    { id: "e", title: "E", after: ["c"], needs: [withText], run: async () => ran.push("e") },
    {
      id: "f",
      title: "F",
      run: async () => {
        throw new Error("boom");
      },
    },
    { id: "g", title: "G", after: ["f"], run: async () => ran.push("g") },
  ];
  const results = await runLegs(legs, {}, { root });
  assert.deepEqual(ran, ["a", "b"]);
  assert.deepEqual(
    results.map((result) => [result.id, result.status]),
    [
      ["a", "passed"],
      ["b", "passed"],
      ["c", "pending"],
      ["d", "pending"],
      ["e", "blocked"],
      ["f", "failed"],
      ["g", "blocked"],
    ],
  );
  assert.equal(results[0].detail, "ok");
  assert.match(results[2].detail, /waiting on T-2/u);
  assert.match(results[3].detail, /not wired yet/u);
  assert.match(results[4].detail, /needs c to pass first; also waiting on T-3/u);
  assert.match(results[5].detail, /boom/u);
});

test("a leg that needs a box is pending on a host shell, and never runs there", async () => {
  let ran = false;
  const legs = [
    { id: "a", title: "A", run: async () => "ok" },
    { id: "b", title: "B", needsBox: true, run: async () => (ran = true) },
  ];
  const onShell = await runLegs(legs, { box: { hostShell: true } }, { root });
  assert.deepEqual(
    onShell.map((result) => [result.id, result.status, result.detail]),
    [
      ["a", "passed", "ok"],
      ["b", "pending", "host shell: not a box"],
    ],
  );
  assert.equal(ran, false);
  const inBox = await runLegs(legs, { box: {} }, { root });
  assert.equal(inBox[1].status, "passed");
});

test("only a failure is red, unless every leg is required", () => {
  const passed = { status: "passed" };
  const pending = { status: "pending" };
  const blocked = { status: "blocked" };
  const failed = { status: "failed" };
  assert.equal(exitCodeFor([passed, pending, blocked]), 0);
  assert.equal(exitCodeFor([passed, failed]), 1);
  assert.equal(exitCodeFor([passed, pending], { requireAll: true }), 1);
  assert.equal(exitCodeFor([passed, blocked], { requireAll: true }), 1);
  assert.equal(exitCodeFor([passed], { requireAll: true }), 0);
});

test("the summary names every leg, escapes table cells and says which mode ran", () => {
  const summary = renderSummary(
    [
      { title: "curl … | sh", status: "passed", detail: "online\nsecond line" },
      { title: "Session", status: "pending", detail: "waiting on T-2" },
    ],
    { headSha: "abc123" },
  );
  assert.match(summary, /Scaffold: a failed leg is red/u);
  assert.match(summary, /Head: `abc123`/u);
  assert.match(summary, /\| curl … \\\| sh \| PASS \| online \|/u);
  assert.doesNotMatch(summary, /second line/u);
  assert.match(summary, /\| Session \| PENDING \| waiting on T-2 \|/u);
  assert.match(renderSummary([], { requireAll: true }), /Every leg must pass/u);
  // A backslash before a pipe cannot unescape it and split the cell.
  const tricky = renderSummary([{ title: "a\\|b", status: "failed", detail: "c:\\d" }]);
  assert.match(tricky, /\| a\\\\\\\|b \| FAIL \| c:\\\\d \|/u);
});

test("redaction removes known secrets and every secret-shaped token", () => {
  const jwt = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4eXoifQ.c2lnbmF0dXJlLXZhbHVl";
  const text = `token vrt_AbCdEfGhIjKl cred vrc_0123456789 gh ghu_deadbeefcafe0011 ${jwt} admin-key-123456 ok`;
  const out = redact(text, ["admin-key-123456", "short"]);
  assert.doesNotMatch(out, /AbCdEfGh|0123456789|deadbeef|admin-key|c2lnbmF0/u);
  assert.match(out, /vrt_\[redacted\]/u);
  assert.match(out, /ghu_\[redacted\]/u);
  assert.match(out, /\[redacted-jwt\]/u);
  assert.match(out, /\[redacted\] ok$/u);
  assert.equal(redact("short text", ["short"]), "short text");
});
