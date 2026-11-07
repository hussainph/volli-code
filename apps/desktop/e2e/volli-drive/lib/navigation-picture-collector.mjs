/**
 * Private VC-1150 driver helper: reads the discriminator's fixed metrics out
 * of the real transcript through semantic disclosures only. It never issues a
 * Browser command; every click uses a ref from the fresh snapshot before it.
 *
 * The tree is volli-drive's `page.ariaSnapshot({ mode: "ai" })` YAML. Two shape
 * facts drive this module (both in the retained run-EmUg4N gen-0021 tree and
 * Playwright's renderer):
 *  - a settled activity bundle is ONE collapsed header button; its rows, and
 *    so each row's "Show details", are not in the tree until it is opened;
 *  - text holding `{`/`}` is printed as a YAML double-quoted scalar, so the
 *    metrics JSON arrives with every `"` escaped as `\"`.
 *
 * Disclosures prefer the `codemode` row: opening a browse row mounts its tab
 * card, which reads that call's picture through the same host lookup the
 * discriminator measures afterwards. Any other disclosure is counted, never
 * hidden, so the result says when the measurement could have been touched.
 */

/** <=100 readiness reads plus six Browser operations; one disclosure each at most. */
export const MAX_TOOL_DISCLOSURES = 108;

/** The program's own fixed failure sentences. Nothing else leaves the tree. */
const PROGRAM_CAUSES = [
  "navigation provenance missing",
  "cold module not observed in flight",
  "fixture button ref missing",
];

/**
 * The one Code Mode program the fake model sends. It ends in the fixed record
 * the collector reads; its own failures are the PROGRAM_CAUSES sentences.
 */
export function navigationToolProgram(url) {
  return `
const raw = r => typeof r === "string" ? r : r.text;
const opened = raw(await tools.browser_navigate({ url: ${JSON.stringify(url)} }));
const tabId = /Browser Tab (\\S+) at/.exec(opened)?.[1];
const generation = Number(/generation (\\d+)/.exec(opened)?.[1]);
if (!tabId || !Number.isFinite(generation)) throw new Error("navigation provenance missing");
// Bounded readiness observation, no extra wait/capture calls and <=100 reads.
const busyEnd = Date.now() + 2000;
let compiling = false;
for (let reads = 0; reads < 100 && Date.now() < busyEnd; reads++) {
 const tabs = raw(await tools.browser_tabs({}));
 if (tabs.includes("phase=compiling")) { compiling = true; break; }
}
if (!compiling) throw new Error("cold module not observed in flight");
const requestedAt = Date.now();
const shot = await tools.browser_screenshot({ tabId });
const answeredAt = Date.now();
const dimensions = /, (\\d+)×(\\d+)/.exec(raw(shot));
const snap = raw(await tools.browser_snapshot({ tabId }));
const ref = /button[^\\n]*\\[ref=(e\\d+)\\]/.exec(snap)?.[1];
if (!ref) throw new Error("fixture button ref missing");
const current = Number(/generation (\\d+)/.exec(snap)?.[1]);
const clickRequestedAt = Date.now();
await tools.browser_act({ tabId, generation: current, kind: "click", ref });
const clickAnsweredAt = Date.now();
// Titles are carried by browser_tabs, not the action's accessibility envelope.
const clickedTab = raw(await tools.browser_tabs({})).split("\\n").find(line => line.startsWith(tabId + " ")) ?? "";
text("NAVIGATION_METRICS:" + JSON.stringify({
 tabId, generation, requestedAt, answeredAt, screenshotMs: answeredAt-requestedAt,
 width: Number(dimensions?.[1]), height: Number(dimensions?.[2]),
 hasImage: Boolean(shot.images?.length), clickRequestedAt, clickAnsweredAt,
 clickedWhileCompiling: clickedTab.includes("phase=compiling") && clickedTab.includes("clicked=1")
}));
`;
}

const GROUP =
  /^( *)- '?button "Browsed [^"\n]+, used 1 tool"((?: \[(?!ref=)[^\]\n]+\])*) \[ref=([^\]\n]+)\]/;
const DETAIL = /^( *)- '?button "Show details"(?: \[(?!ref=)[^\]\n]+\])* \[ref=([^\]\n]+)\]/;
const DISCLOSURE = /^ *- '?button "(?:Show|Hide) details"/;
const METRICS = /NAVIGATION_METRICS:(\{[^\n}]+\})/;
const FAILED = /Program failed after (\d+) successful calls?\b/;

const indentOf = (line) => /^ */.exec(line)[0].length;

/** Collection evidence: allowlisted phase, counts, and at most a fixed cause. */
export class NavigationCollectionError extends Error {
  constructor(message, fact) {
    super(message);
    this.name = "NavigationCollectionError";
    this.collection = fact;
  }
}

/** The LAST settled bundle header and the lines of the activity block under it. */
export function activityGroup(text) {
  const lines = text.split("\n");
  const index = lines.findLastIndex((line) => GROUP.test(line));
  if (index < 0) return null;
  const [, indent, states, ref] = GROUP.exec(lines[index]);
  const scope = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() !== "" && indentOf(line) < indent.length) break;
    scope.push(line);
  }
  return { ref, expanded: states.includes("[expanded]"), scope };
}

/**
 * A closed row disclosure inside the bundle, codemode row first. A row's own
 * words are the lines between its parent and its button, never a sibling row.
 */
export function nextDisclosure(scope) {
  const candidates = [];
  scope.forEach((line, index) => {
    const match = DETAIL.exec(line);
    if (!match) return;
    const depth = match[1].length;
    let codemode = false;
    for (let back = index - 1; back >= 0; back--) {
      const prior = scope[back];
      if (prior.trim() === "") continue;
      const priorDepth = indentOf(prior);
      if (priorDepth < depth) {
        codemode ||= /\bcodemode\b/.test(prior);
        break;
      }
      if (priorDepth === depth && DISCLOSURE.test(prior)) break;
      codemode ||= /\bcodemode\b/.test(prior);
    }
    candidates.push({ ref: match[2], codemode });
  });
  return candidates.find((one) => one.codemode) ?? candidates[0] ?? null;
}

/** Decode the metrics scalar Playwright printed, plain or double-quoted. */
export function metricsText(scope) {
  const match = METRICS.exec(scope.join("\n"));
  if (!match) return null;
  // The record is ids, numbers and booleans: the only escape YAML can have
  // added is `\"`. Anything else left over is not this record.
  const decoded = match[1].replace(/\\(["\\])/g, "$1");
  if (decoded.includes("\\")) throw new Error("unexpected metrics escape");
  return decoded;
}

function programFailure(scope) {
  const text = scope.join("\n");
  const match = FAILED.exec(text);
  if (!match) return null;
  return {
    succeededCalls: Number(match[1]),
    cause: PROGRAM_CAUSES.find((cause) => text.includes(cause)) ?? "unlisted",
  };
}

export async function collectNavigationMetrics({ snapshot, click, checkpoint }) {
  const fact = { disclosures: 0, codemodeDisclosures: 0, otherDisclosures: 0, groupOpened: false };
  const fail = (phase, message, extra = {}) => {
    checkpoint(phase);
    throw new NavigationCollectionError(message, { phase, ...fact, ...extra });
  };
  checkpoint("collection:activity-snapshot");
  let snap = await snapshot();
  let group = activityGroup(snap.text);
  if (!group) fail("collection:activity-group", "activity group missing");
  if (!group.expanded) {
    checkpoint("collection:open-activity-group");
    const ref = group.ref;
    snap = await click(snap.generation, ref);
    group = activityGroup(snap.text);
    if (!group?.expanded || group.ref !== ref) {
      fail("collection:activity-group-closed", "activity group did not open");
    }
    fact.groupOpened = true;
  }
  const clicked = new Set();
  for (;;) {
    checkpoint("collection:metrics-parse");
    const metrics = metricsText(group.scope);
    if (metrics !== null) return { metrics: parseNavigationMetrics(metrics), collection: fact };
    const failure = programFailure(group.scope);
    if (failure) fail("collection:program-failed", "tool program failed", { program: failure });
    checkpoint("collection:tool-details");
    const next = nextDisclosure(group.scope);
    if (!next) fail("collection:tool-details", "tool details missing");
    if (clicked.has(next.ref))
      fail("collection:tool-details-stuck", "tool disclosure did not open");
    if (fact.disclosures >= MAX_TOOL_DISCLOSURES) {
      fail("collection:disclosure-bound", "tool disclosure bound");
    }
    clicked.add(next.ref);
    fact.disclosures++;
    if (next.codemode) fact.codemodeDisclosures++;
    else fact.otherDisclosures++;
    snap = await click(snap.generation, next.ref);
    group = activityGroup(snap.text);
    if (!group?.expanded) fail("collection:activity-group-closed", "activity group closed");
  }
}

/** Only the script's fixed numeric/boolean/opaque-id record leaves collection. */
export function parseNavigationMetrics(text) {
  const value = JSON.parse(text);
  const numeric = [
    "generation",
    "requestedAt",
    "answeredAt",
    "screenshotMs",
    "width",
    "height",
    "clickRequestedAt",
    "clickAnsweredAt",
  ];
  if (
    typeof value !== "object" ||
    value === null ||
    !/^[a-f0-9-]{36}$/i.test(value.tabId) ||
    numeric.some((key) => !Number.isFinite(value[key])) ||
    typeof value.hasImage !== "boolean" ||
    typeof value.clickedWhileCompiling !== "boolean"
  ) {
    throw new Error("invalid fixed tool metrics");
  }
  return Object.fromEntries(
    ["tabId", ...numeric, "hasImage", "clickedWhileCompiling"].map((key) => [key, value[key]]),
  );
}
