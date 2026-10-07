import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { test } from "vite-plus/test";
import { parse } from "yaml";

import {
  findExportedSeams,
  formatReport,
  isNonProduction,
  runAdvisory,
} from "./report-exported-seams.mjs";

const source = (path, text) => ({ path, text });
const seam = source(
  "packages/fixture/src/seam.ts",
  "export async function unwired() {}\nexport type Unused = string;",
);
const inventory = (callers) => findExportedSeams([seam, ...callers]);

test("reports test/lab-only exports and separately labels unreferenced exports", () => {
  const findings = inventory([
    source("packages/fixture/src/seam.test.ts", "import { unwired } from './seam'; unwired();"),
    source("apps/desktop/src/renderer/lab/scratches/demo.tsx", "unwired();"),
  ]);
  assert.deepEqual(findings[0].references, [
    "apps/desktop/src/renderer/lab/scratches/demo.tsx",
    "packages/fixture/src/seam.test.ts",
  ]);
  assert.equal(findings[1].name, "Unused");
  assert.deepEqual(findings[1].references, []);
  const report = formatReport(findings, 3);
  assert.match(
    report,
    /1 exports referenced only by tests\/lab; 1 exports with no external spelling reference/,
  );
  assert.match(report, /### packages\/fixture\/src\//);
  assert.match(report, /seam.ts: unwired@1/);
  assert.doesNotMatch(report, /Unused@/);
  assert.match(report, /Unreferenced exports are counted, not listed/);
  assert.match(report, /Not a wiring or dead-code proof/);
});

test("production callers in desktop, hostd, other packages and scripts suppress findings", () => {
  for (const path of [
    "apps/desktop/src/main/runtime.ts",
    "apps/hostd/src/runtime.ts",
    "packages/other/src/index.ts",
    "scripts/operator.mjs",
  ]) {
    assert.equal(
      inventory([source(path, "import { unwired as call } from './seam'; call();")]).some(
        (item) => item.name === "unwired",
      ),
      false,
    );
  }
});

test("bare barrels are not callers, including multiline and type forwarding", () => {
  const findings = inventory([
    source(
      "packages/fixture/src/index.ts",
      "export * from './seam';\nexport type {\n Unused\n} from './seam';\nexport { unwired } from './seam';",
    ),
    source("packages/fixture/src/seam.test.ts", "unwired();"),
  ]);
  assert.equal(findings.length, 2);
  assert.deepEqual(findings[0].references, ["packages/fixture/src/seam.test.ts"]);
});

test("forwarding alias chains connect to production references, without counting the barrels", () => {
  const barrels = [
    source("packages/fixture/src/index.ts", "export { unwired as renamed } from './seam';"),
    source("packages/other/src/index.ts", "export { renamed as again } from 'fixture';"),
  ];
  assert.equal(inventory(barrels)[0].name, "unwired");
  assert.equal(
    inventory([
      ...barrels,
      source("apps/hostd/src/main.ts", "import { again } from 'other'; again();"),
    ]).some((item) => item.name === "unwired"),
    false,
  );
});

test("local export lists, declarations and named defaults are inventoried", () => {
  const findings = findExportedSeams([
    source(
      "apps/desktop/src/demo.ts",
      "const local = 1;\nexport { local as publicName };\nexport default class Demo {}\nexport declare const declared: number;\nexport interface Port {}\nexport enum State { Ready }",
    ),
  ]);
  assert.deepEqual(
    findings.map((item) => item.name),
    ["publicName", "Demo", "declared", "Port", "State"],
  );
});

test("export declarations outside the requested scope and in fixture code are excluded", () => {
  const findings = findExportedSeams([
    source("apps/hostd/src/demo.ts", "export function hostOnly() {}"),
    source("packages/fixture/src/testing/index.ts", "export function helper() {}"),
    source("apps/desktop/src/renderer/lab/demo.tsx", "export const fixture = 1;"),
    source("packages/fixture/src/test-support.ts", "export const helper = 1;"),
    source("packages/fixture/src/ambient.d.ts", "export interface Ambient {}"),
  ]);
  assert.deepEqual(findings, []);
  for (const path of [
    "a.test.ts",
    "a.test.mjs",
    "src/testing/a.ts",
    "src/test-support/a.ts",
    "src/a.test-support.ts",
    "src/lab/a.ts",
    "e2e/probe.mjs",
    "src/__fixtures__/a.ts",
  ]) {
    assert.equal(isNonProduction(path), true, path);
  }
  assert.equal(isNonProduction("src/latest.ts"), false);
});

test("name collisions, comments and unused imports intentionally err toward suppressing findings", () => {
  for (const text of [
    "// unwired will be useful",
    "const message = 'unwired';",
    "const unwired = 2;",
    "import { unwired } from './seam';",
  ]) {
    assert.equal(
      inventory([source("apps/hostd/src/main.ts", text)]).some((item) => item.name === "unwired"),
      false,
    );
  }
});

test("advisory reports scanner errors without throwing", () => {
  const messages = [];
  runAdvisory({ root: "/path/that/does/not/exist", print: (text) => messages.push(text) });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /advisory unavailable:.*No gate failed/);
});

function fixtureDirectory() {
  const parent = fileURLToPath(new URL("../.tmp/", import.meta.url));
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "exported-seams-"));
}

test("successful advisory prints the inventory and appends the identical CI summary", () => {
  const temporary = fixtureDirectory();
  try {
    for (const path of ["packages/fixture/src", "apps/desktop/src", "scripts"])
      mkdirSync(join(temporary, path), { recursive: true });
    writeFileSync(join(temporary, "packages/fixture/src/seam.ts"), seam.text);
    writeFileSync(join(temporary, "packages/fixture/src/seam.test.ts"), "unwired();");
    const messages = [];
    const summary = join(temporary, "summary.md");
    runAdvisory({ root: temporary, summary, print: (text) => messages.push(text) });
    assert.equal(messages.length, 1);
    assert.match(messages[0], /seam.ts: unwired@1/);
    assert.equal(readFileSync(summary, "utf8"), messages[0]);
    const failureSummary = join(temporary, "failure-summary.md");
    runAdvisory({
      root: join(temporary, "missing"),
      summary: failureSummary,
      print: (text) => messages.push(text),
    });
    assert.equal(readFileSync(failureSummary, "utf8"), messages.at(-1));
    assert.match(messages.at(-1), /advisory unavailable:.*No gate failed/);
    runAdvisory({
      root: temporary,
      summary: join(temporary, "missing/summary.md"),
      print: (text) => messages.push(text),
    });
    assert.match(messages.at(-1), /advisory unavailable:.*No gate failed/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("CLI scans successfully without a system ripgrep on PATH", () => {
  const run = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./report-exported-seams.mjs", import.meta.url))],
    {
      env: { ...process.env, PATH: "/path/that/does/not/exist", GITHUB_STEP_SUMMARY: "" },
      encoding: "utf8",
    },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Scanned \d+ source files/);
  assert.doesNotMatch(run.stdout, /advisory unavailable/);
});

test("missing packaged ripgrep is also a non-failing advisory diagnostic", () => {
  const messages = [];
  runAdvisory({ rgPath: "/path/that/does/not/exist", print: (text) => messages.push(text) });
  assert.match(messages[0], /advisory unavailable:.*No gate failed/);
});

test("CI bounds runtime and cannot fail the gate on an advisory error or timeout", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const step = workflow.jobs.check.steps.find((item) => item.id === "exported-seams");
  assert.equal(step["continue-on-error"], true);
  assert.match(step.run, /timeout 55s node scripts\/report-exported-seams\.mjs/);
  assert.match(step.run, /\|\| echo/);
  assert.match(step.run, /GITHUB_STEP_SUMMARY/);
  assert.ok(
    workflow.jobs.check.steps.some((item) => item.run?.includes("report-exported-seams.test.mjs")),
  );
  const temporary = fixtureDirectory();
  try {
    for (const status of [1, 124, 137]) {
      const summary = join(temporary, `summary-${status}.md`);
      const run = spawnSync("bash", ["-ec", `timeout() { return ${status}; }\n${step.run}`], {
        env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
        encoding: "utf8",
      });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(readFileSync(summary, "utf8"), /advisory unavailable or timed out/);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
