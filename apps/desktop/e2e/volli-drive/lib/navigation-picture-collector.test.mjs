import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { Script } from "node:vm";
import {
  MAX_TOOL_DISCLOSURES,
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
const HEADER = "Browsed 127.0.0.1:54947, used 1 tool";

// Verbatim minimal excerpt of retained run-EmUg4N gen-0021 (the failed run):
// the settled bundle is one collapsed header; no row disclosure exists yet. The
// worktree control and the rail toggle are look-alike "details" buttons.
const RETAINED_COLLAPSED = [
  '      - button "Hide details rail" [ref=f2e494]',
  "                    - generic [ref=f2e1013]:",
  "                      - generic [ref=f2e1015]:",
  `                        - button "${HEADER}" [ref=f2e1092]`,
  "                        - paragraph [ref=f2e1097]: Navigation picture commands complete",
  '                      - button "Copy" [ref=f2e1099]',
  `              - 'button "Worktree: No commits. Show details" [ref=f2e1057]':`,
  "                - generic [ref=f2e1058]: No commits",
].join("\n");

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

/** The expanded bundle through Playwright's own YAML renderer. */
function expanded({ browseOpen = false, codeOpen = false, output } = {}) {
  return iso.renderAriaSnapshotAsYaml([
    { role: "button", name: "Hide details rail", ref: "f2e494" },
    {
      role: "generic",
      ref: "f2e1015",
      children: [
        { role: "button", name: HEADER, expanded: true, ref: "f2e1092" },
        row("f2e2", "Opened", browseOpen, "tab card"),
        row("f2e3", "codemode", codeOpen, output),
        { role: "paragraph", ref: "f2e1097", children: ["Navigation picture commands complete"] },
      ],
    },
    { role: "button", name: "Worktree: No commits. Show details", ref: "f2e1057" },
  ]);
}
const OUTPUT = `Code Mode: 9 calls.\nNAVIGATION_METRICS:${JSON.stringify(metrics)}`;

function driver(states) {
  const clicks = [];
  const phases = [];
  let position = 0;
  return {
    clicks,
    phases,
    snapshot: async () => ({ generation: 21, text: states[0] }),
    click: async (generation, ref) => {
      clicks.push({ generation, ref });
      position++;
      return { generation: 21 + position, text: states[position] };
    },
    checkpoint: (phase) => phases.push(phase),
  };
}

test("the real renderer double-quotes the metrics record and escapes its quotes", () => {
  const text = expanded({ codeOpen: true, output: OUTPUT });
  assert.ok(text.includes('NAVIGATION_METRICS:{\\"tabId\\":'), "codec shape changed");
  assert.equal(metricsText(text.split("\n")), JSON.stringify(metrics));
  assert.equal(
    metricsText([`- generic: NAVIGATION_METRICS:${JSON.stringify(metrics)}`]),
    JSON.stringify(metrics),
  );
  assert.throws(() => metricsText(['- generic: "NAVIGATION_METRICS:{\\x01}"']), /escape/);
});

test("retained collapsed shape: fresh header ref, fresh tree, codemode row, then parse", async () => {
  const drive = driver([
    RETAINED_COLLAPSED,
    expanded(),
    expanded({ codeOpen: true, output: OUTPUT }),
  ]);
  const value = await collectNavigationMetrics(drive);
  assert.deepEqual(value.metrics, metrics);
  assert.deepEqual(value.collection, {
    disclosures: 1,
    codemodeDisclosures: 1,
    otherDisclosures: 0,
    groupOpened: true,
  });
  // The header ref from the collapsed tree, then the codemode row's ref from
  // the expanded tree; never the browse row, the worktree or the rail.
  assert.deepEqual(drive.clicks, [
    { generation: 21, ref: "f2e1092" },
    { generation: 22, ref: "f2e3d" },
  ]);
  assert.deepEqual(drive.phases, [
    "collection:activity-snapshot",
    "collection:open-activity-group",
    "collection:metrics-parse",
    "collection:tool-details",
    "collection:metrics-parse",
  ]);
});

test("an already-open group is not toggled shut, and other disclosures are counted", async () => {
  const unnamed = (open, body) =>
    expanded({ codeOpen: open, output: body }).replaceAll(/\bcodemode\b/g, "tool");
  const drive = driver([unnamed(false), unnamed(true, OUTPUT)]);
  const value = await collectNavigationMetrics(drive);
  assert.deepEqual(value.metrics, metrics);
  assert.equal(value.collection.groupOpened, false);
  assert.equal(value.collection.otherDisclosures, 1);
  assert.deepEqual(drive.clicks, [{ generation: 21, ref: "f2e2d" }]);
});

test("allowlisted failure facts: missing group, unopened group, stuck row, program cause", async () => {
  const fails = async (states, phase) => {
    const drive = driver(states);
    const error = await collectNavigationMetrics(drive).catch((caught) => caught);
    assert.ok(error instanceof NavigationCollectionError);
    assert.equal(error.collection.phase, phase);
    assert.equal(drive.phases.at(-1), phase);
    return error.collection;
  };
  await fails(["- paragraph: nothing"], "collection:activity-group");
  await fails([RETAINED_COLLAPSED, RETAINED_COLLAPSED], "collection:activity-group-closed");
  await fails([expanded(), expanded(), expanded()], "collection:tool-details-stuck");
  const failed = await fails(
    [
      expanded(),
      expanded({
        codeOpen: true,
        output:
          "Program failed after 3 successful calls. Error: cold module not observed in flight",
      }),
    ],
    "collection:program-failed",
  );
  assert.deepEqual(failed.program, {
    succeededCalls: 3,
    cause: "cold module not observed in flight",
  });
  const other = await fails(
    [
      expanded(),
      expanded({ codeOpen: true, output: "Program failed after 1 successful call. page words" }),
    ],
    "collection:program-failed",
  );
  assert.deepEqual(other.program, { succeededCalls: 1, cause: "unlisted" });
  await fails(
    [expanded(), expanded({ codeOpen: true, browseOpen: true, output: "no record" })],
    "collection:tool-details",
  );
});

test("the disclosure walk is bounded", async () => {
  const rows = Array.from({ length: MAX_TOOL_DISCLOSURES + 1 }, (_, index) => index);
  const tree = (open) =>
    iso.renderAriaSnapshotAsYaml([
      {
        role: "generic",
        ref: "g",
        children: [
          { role: "button", name: HEADER, expanded: true, ref: "h" },
          ...rows.map((index) => row(`r${index}`, "Opened", index < open, "card")),
        ],
      },
    ]);
  const states = rows.map((open) => tree(open));
  const drive = driver(states);
  const error = await collectNavigationMetrics(drive).catch((caught) => caught);
  assert.equal(error.collection.phase, "collection:disclosure-bound");
  assert.equal(drive.clicks.length, MAX_TOOL_DISCLOSURES);
});

test("the scope stops at the end of the bundle's own block", () => {
  const group = activityGroup(RETAINED_COLLAPSED);
  assert.equal(group.ref, "f2e1092");
  assert.equal(group.expanded, false);
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
    const drive = driver([
      expanded(),
      expanded({
        codeOpen: true,
        output: `Program failed after 2 successful calls. Error: ${cause}`,
      }),
    ]);
    const error = await collectNavigationMetrics(drive).catch((caught) => caught);
    assert.deepEqual(error.collection.program, { succeededCalls: 2, cause });
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
