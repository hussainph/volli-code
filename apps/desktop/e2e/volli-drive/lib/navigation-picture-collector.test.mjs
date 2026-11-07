import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { Script } from "node:vm";
import {
  NavigationCollectionError,
  activityGroup,
  collectNavigationMetrics,
  metricsText,
  navigationToolProgram,
  parseNavigationMetrics,
} from "./navigation-picture-collector.mjs";

// The renderer volli-drive's page.ariaSnapshot uses, from the same pinned
// package: expanded trees below are real codec output, not hand-written YAML.
const { iso } = createRequire(import.meta.url)("playwright-core/lib/coreBundle");

const metrics = {
  tabId: "a78c3edf-16bb-4011-ac12-fda33c4dca32",
  generation: 1,
  requestedAt: 10,
  answeredAt: 20,
  screenshotMs: 10,
  width: 1280,
  height: 720,
  clickRequestedAt: 30,
  clickAnsweredAt: 40,
  hasImage: true,
  clickedWhileCompiling: true,
};
const SUCCESS = "Browsed 127.0.0.1:54947, used 1 tool";
const OUTPUT = `Code Mode: 9 calls.\nNAVIGATION_METRICS:${JSON.stringify(metrics)}`;
const failedAfter = (calls, cause) =>
  `Program failed after ${calls} successful call${calls === 1 ? "" : "s"}. Error: ${cause}`;

// Verbatim minimal excerpt of retained run-EmUg4N gen-0021 (the failed run):
// the settled bundle is one collapsed header; no row disclosure exists yet. The
// worktree control and the rail toggle are look-alike "details" buttons.
const RETAINED_COLLAPSED = [
  '      - button "Hide details rail" [ref=f2e494]',
  "                    - generic [ref=f2e1013]:",
  "                      - generic [ref=f2e1015]:",
  `                        - button "${SUCCESS}" [ref=f2e1092]`,
  "                        - paragraph [ref=f2e1097]: Navigation picture commands complete",
  '                      - button "Copy" [ref=f2e1099]',
  `              - 'button "Worktree: No commits. Show details" [ref=f2e1057]':`,
  "                - generic [ref=f2e1058]: No commits",
].join("\n");

/** One activity row: wrapper, header (verb + disclosure), and its open body. */
const row = (ref, verb, open, body) => ({
  role: "generic",
  ref: `${ref}a`,
  children: [
    {
      role: "generic",
      ref: `${ref}b`,
      children: [
        { role: "generic", ref: `${ref}c`, children: [verb] },
        {
          role: "button",
          name: open ? "Hide details" : "Show details",
          expanded: open,
          ref: `${ref}d`,
        },
      ],
    },
    ...(open && body ? [{ role: "generic", ref: `${ref}e`, children: [body] }] : []),
  ],
});

/**
 * A bundle through Playwright's own YAML renderer. `header` is the summary the
 * production rules give this script; `rows` default to one browse row and the
 * codemode row, the shape the success header states.
 */
function tree({
  header = SUCCESS,
  open = true,
  browseOpen = false,
  codeOpen = false,
  body,
  rows = [row("f2e2", "Opened", browseOpen, "tab card"), row("f2e3", "codemode", codeOpen, body)],
} = {}) {
  return iso.renderAriaSnapshotAsYaml([
    { role: "button", name: "Hide details rail", ref: "f2e494" },
    {
      role: "generic",
      ref: "f2e1015",
      children: [
        { role: "button", name: header, expanded: open, ref: "f2e1092" },
        ...(open ? rows : []),
        { role: "paragraph", ref: "f2e1097", children: ["Navigation picture commands complete"] },
      ],
    },
    { role: "button", name: "Worktree: No commits. Show details", ref: "f2e1057" },
  ]);
}

const BROWSE_REFS = new Set(["f2e2d", "f2e494", "f2e1057"]);

function driver(states) {
  const clicks = [];
  const phases = [];
  let position = 0;
  return {
    clicks,
    phases,
    snapshot: async () => ({ generation: 21, text: states[0] }),
    click: async (generation, ref) => {
      assert.ok(!BROWSE_REFS.has(ref), `opened a forbidden disclosure ${ref}`);
      clicks.push({ generation, ref });
      position++;
      return { generation: 21 + position, text: states[position] };
    },
    checkpoint: (phase) => phases.push(phase),
  };
}

async function failure(states, phase) {
  const drive = driver(states);
  const error = await collectNavigationMetrics(drive).catch((caught) => caught);
  assert.ok(error instanceof NavigationCollectionError, String(error));
  assert.equal(error.collection.phase, phase);
  assert.equal(drive.phases.at(-1), phase);
  // Facts only: no tree, page, tool or metrics text survives in the record.
  assert.doesNotMatch(JSON.stringify(error.collection), /NAVIGATION|127\.0\.0\.1|Program|tab card/);
  return { collection: error.collection, clicks: drive.clicks };
}

test("the real renderer double-quotes the metrics record and escapes its quotes", () => {
  const text = tree({ codeOpen: true, body: OUTPUT });
  assert.ok(text.includes('NAVIGATION_METRICS:{\\"tabId\\":'), "codec shape changed");
  assert.equal(metricsText(text.split("\n")), JSON.stringify(metrics));
  assert.equal(
    metricsText([`- generic: NAVIGATION_METRICS:${JSON.stringify(metrics)}`]),
    JSON.stringify(metrics),
  );
  assert.throws(() => metricsText(['- generic: "NAVIGATION_METRICS:{\\x01}"']), /escape/);
});

test("retained collapsed shape: fresh header ref, fresh tree, ONLY the codemode row, then parse", async () => {
  const drive = driver([RETAINED_COLLAPSED, tree(), tree({ codeOpen: true, body: OUTPUT })]);
  const value = await collectNavigationMetrics(drive);
  assert.deepEqual(value.metrics, metrics);
  assert.deepEqual(value.collection, {
    groupOpened: true,
    summary: { browse: true, failed: 0, denied: 0, notRun: 0 },
    rows: 2,
    codemodeRows: 1,
    disclosures: 1,
  });
  assert.deepEqual(drive.clicks, [
    { generation: 21, ref: "f2e1092" },
    { generation: 22, ref: "f2e3d" },
  ]);
  assert.deepEqual(drive.phases, [
    "collection:activity-snapshot",
    "collection:open-activity-group",
    "collection:codemode-row",
    "collection:open-codemode-row",
    "collection:metrics-parse",
  ]);
});

test("production failure summaries keep the program's fixed cause", async () => {
  // A throwing program adds "1 failed"; a failed nested call adds to it; no
  // browse row at all leaves "Used 1 tool"; no known page counts calls. A
  // failure opens the bundle by itself, so the header is never clicked shut.
  const cases = [
    [`${SUCCESS} · 1 failed`, 3, "cold module not observed in flight", true],
    [`${SUCCESS} · 2 failed`, 4, "fixture button ref missing", true],
    ["Browsed 1 time, used 1 tool · 1 failed", 0, "navigation provenance missing", true],
    ["Used 1 tool · 1 failed", 0, "navigation provenance missing", false],
  ];
  for (const [header, calls, cause, browse] of cases) {
    const rows = (open) => [
      ...(browse ? [row("f2e2", "Opened", false, "tab card")] : []),
      row("f2e3", "codemode", open, failedAfter(calls, cause)),
    ];
    const { collection, clicks } = await failure(
      [tree({ header, rows: rows(false) }), tree({ header, rows: rows(true) })],
      "collection:program-failed",
    );
    assert.deepEqual(clicks, [{ generation: 21, ref: "f2e3d" }], header);
    assert.equal(collection.groupOpened, false);
    assert.equal(collection.summary.browse, browse);
    assert.equal(collection.summary.failed, header.endsWith("2 failed") ? 2 : 1);
    assert.deepEqual(collection.program, { succeededCalls: calls, cause });
  }
  // Collapsed failure header (not auto-opened): opened from its fresh ref.
  const header = `${SUCCESS} · 1 failed`;
  const { clicks, collection } = await failure(
    [
      tree({ header, open: false }),
      tree({ header }),
      tree({ header, codeOpen: true, body: failedAfter(1, "page words") }),
    ],
    "collection:program-failed",
  );
  assert.deepEqual(clicks, [
    { generation: 21, ref: "f2e1092" },
    { generation: 22, ref: "f2e3d" },
  ]);
  assert.deepEqual(collection.program, { succeededCalls: 1, cause: "unlisted" });
});

test("unrelated or in-flight headers are never taken for this script's group", () => {
  for (const header of [
    "Read 2 files, used 1 tool",
    "Browsed 127.0.0.1:54947, used 2 tools",
    "Browsed 127.0.0.1:54947, read 1 file, used 1 tool",
    "Browsing 127.0.0.1:54947, using 1 tool",
    "1 not run",
    "Browsed 127.0.0.1:54947",
  ]) {
    assert.equal(activityGroup(tree({ header })), null, header);
  }
  assert.equal(
    activityGroup(tree({ header: "Browsed 127.0.0.1:54947 and 127.0.0.1:1, used 1 tool" }))?.ref,
    "f2e1092",
  );
});

test("never falls back to a browse disclosure: every miss fails closed", async () => {
  const browseOnly = [row("f2e2", "Opened", false, "tab card")];
  let result = await failure([tree({ rows: browseOnly })], "collection:codemode-row");
  assert.deepEqual(result.clicks, []);
  assert.equal(result.collection.codemodeRows, 0);

  const two = [row("f2e3", "codemode", false), row("f2e4", "codemode", false)];
  result = await failure([tree({ rows: two })], "collection:codemode-row");
  assert.equal(result.collection.codemodeRows, 2);
  assert.deepEqual(result.clicks, []);

  result = await failure(
    [tree({ browseOpen: true, codeOpen: false })],
    "collection:browse-row-open",
  );
  assert.deepEqual(result.clicks, []);

  // The codemode row opened but holds no fixed record or failure: stop there,
  // with a browse row still closed and untouched.
  result = await failure(
    [tree(), tree({ codeOpen: true, body: "something else" })],
    "collection:codemode-detail",
  );
  assert.deepEqual(result.clicks, [{ generation: 21, ref: "f2e3d" }]);
  assert.equal(result.collection.disclosures, 1);

  await failure([tree(), tree()], "collection:codemode-row-closed");
  await failure(
    [tree(), tree({ browseOpen: true, codeOpen: true, body: OUTPUT })],
    "collection:browse-row-open",
  );
  await failure(["- paragraph: nothing"], "collection:activity-group");
  await failure([RETAINED_COLLAPSED, RETAINED_COLLAPSED], "collection:activity-group-closed");
  await failure([tree(), tree({ open: false })], "collection:activity-group-closed");
});

test("strict scalar and record failures keep the fixed phase and counts", async () => {
  const bad = [
    String.raw`NAVIGATION_METRICS:{\x01}`,
    `NAVIGATION_METRICS:${JSON.stringify({ ...metrics, tabId: "not an id" })}`,
    "NAVIGATION_METRICS:{not json}",
  ];
  for (const body of bad) {
    const { collection } = await failure(
      [tree(), tree({ codeOpen: true, body })],
      "collection:metrics-invalid",
    );
    assert.equal(collection.disclosures, 1);
    assert.equal(collection.codemodeRows, 1);
  }
});

test("the scope stops at the end of the bundle's own block", () => {
  const group = activityGroup(RETAINED_COLLAPSED);
  assert.equal(group.ref, "f2e1092");
  assert.equal(group.expanded, false);
  assert.deepEqual(group.summary, { browse: true, failed: 0, denied: 0, notRun: 0 });
  assert.deepEqual(group.scope, [
    "                        - paragraph [ref=f2e1097]: Navigation picture commands complete",
  ]);
});

test("the generated tool program compiles as Code Mode's async body, and its causes are known", async () => {
  const program = navigationToolProgram("http://127.0.0.1:54947/");
  // Outer `node --check` cannot see inside the template; compile, never run.
  assert.doesNotThrow(() => new Script(`(async () => {\n${program}\n})`));
  assert.ok(program.includes('{ url: "http://127.0.0.1:54947/" }'));
  const causes = [...program.matchAll(/throw new Error\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.equal(causes.length, 3);
  for (const cause of causes) {
    const header = `${SUCCESS} · 1 failed`;
    const { collection } = await failure(
      [tree({ header }), tree({ header, codeOpen: true, body: failedAfter(2, cause) })],
      "collection:program-failed",
    );
    assert.deepEqual(collection.program, { succeededCalls: 2, cause });
  }
});

test("metrics codec permits no raw content or unknown fields", () => {
  assert.deepEqual(
    parseNavigationMetrics(JSON.stringify({ ...metrics, rawPage: "not retained" })),
    metrics,
  );
  assert.throws(() => parseNavigationMetrics(JSON.stringify({ ...metrics, tabId: "not an id" })));
  assert.throws(() => parseNavigationMetrics(JSON.stringify({ ...metrics, screenshotMs: null })));
  assert.throws(() => parseNavigationMetrics("null"));
});
