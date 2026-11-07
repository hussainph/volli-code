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
 * Exactly ONE row disclosure may ever be opened: the `codemode` row's. Opening
 * any browse row mounts its BrowserTabCard, which reads that call's picture
 * through the same host lookup the discriminator measures afterwards. So there
 * is no fallback: no unique codemode row, or no fixed record/failure behind
 * it, fails closed with counts and an allowlisted phase.
 */

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

/*
 * The bundle header this one script can produce, from the production rules
 * (`bundleSummary` in session-presentation/src/activity.ts, joined by `Summary`
 * in activity-ui.tsx): per-kind phrases joined by ", " with the first letter
 * capitalised, then " · N failed", " · N denied", " · N not run" in that order.
 * The script's only non-browse tool is `codemode` ("used 1 tool"); its browse
 * phrase names <=3 pages, else counts pages, else counts calls ("1 time").
 * A Code Mode program that throws adds "1 failed"; a nested call that failed
 * as well adds to it. A bundle with no browse row is "Used 1 tool …".
 */
const PAGE = String.raw`[^\s",]+`;
const BROWSE = String.raw`Browsed (?:\d+ (?:times?|pages)|${PAGE}(?:, ${PAGE})*(?: and ${PAGE})?), used`;
const SUFFIX = String.raw`(?: · ([1-9]\d*) failed)?(?: · ([1-9]\d*) denied)?(?: · ([1-9]\d*) not run)?`;
const GROUP = new RegExp(
  String.raw`^( *)- '?button "(?:(${BROWSE})|Used) 1 tool${SUFFIX}"((?: \[(?!ref=)[^\]\n]+\])*) \[ref=([^\]\n]+)\]`,
);
const DETAIL = /^( *)- '?button "(Show|Hide) details"(?: \[(?!ref=)[^\]\n]+\])* \[ref=([^\]\n]+)\]/;
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

/**
 * The LAST settled bundle header this script can produce, how many such
 * headers the tree holds, the counts its summary states, and the lines of the
 * activity block under it. Refs are NOT identity: React remounts the header's
 * wrapper and a row's disclosure when they open (retained run-2uJsc9
 * gen-0023 -> gen-0024), so each fresh tree is matched by meaning.
 */
export function activityGroup(text) {
  const lines = text.split("\n");
  const index = lines.findLastIndex((line) => GROUP.test(line));
  if (index < 0) return null;
  const headers = lines.filter((line) => GROUP.test(line)).length;
  const [, indent, browse, failed, denied, notRun, states, ref] = GROUP.exec(lines[index]);
  const scope = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() !== "" && indentOf(line) < indent.length) break;
    scope.push(line);
  }
  return {
    ref,
    headers,
    expanded: states.includes("[expanded]"),
    summary: {
      browse: browse !== undefined,
      failed: Number(failed ?? 0),
      denied: Number(denied ?? 0),
      notRun: Number(notRun ?? 0),
    },
    scope,
  };
}

/**
 * Every row disclosure in the bundle, each marked by whether its own row is
 * the codemode call. A row's own words are the lines between its parent and
 * its button, never a sibling row's.
 */
export function rowDisclosures(scope) {
  const rows = [];
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
      if (priorDepth === depth && DETAIL.test(prior)) break;
      codemode ||= /\bcodemode\b/.test(prior);
    }
    rows.push({ ref: match[3], open: match[2] === "Hide", codemode });
  });
  return rows;
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
  const fact = {
    groupOpened: false,
    summary: null,
    rows: 0,
    codemodeRows: 0,
    disclosures: 0,
    headerRefChanged: null,
    codemodeRefChanged: null,
  };
  const fail = (phase, message, extra = {}) => {
    checkpoint(phase);
    throw new NavigationCollectionError(message, { phase, ...fact, ...extra });
  };
  /** This fresh tree's one group, by meaning; never by a ref an older tree minted. */
  const groupOf = (snap, closedPhase) => {
    const group = activityGroup(snap.text);
    if (!group) fail(closedPhase ?? "collection:activity-group", "activity group missing");
    if (group.headers !== 1) fail("collection:activity-group-ambiguous", "several activity groups");
    if (closedPhase && !group.expanded) fail(closedPhase, "activity group not open");
    return group;
  };
  /** The unique codemode row and every other row closed, in this fresh tree. */
  const codemodeOf = (group, phase) => {
    const rows = rowDisclosures(group.scope);
    const codemode = rows.filter((row) => row.codemode);
    if (phase === "collection:codemode-row") {
      fact.rows = rows.length;
      fact.codemodeRows = codemode.length;
    }
    // An open browse row would have mounted its card: never proceed past one.
    if (rows.some((row) => row.open && !row.codemode)) {
      fail("collection:browse-row-open", "a browse disclosure is open");
    }
    if (codemode.length !== 1)
      fail(phase, "no unique codemode row", { seenCodemodeRows: codemode.length });
    return { rows, row: codemode[0] };
  };
  checkpoint("collection:activity-snapshot");
  let snap = await snapshot();
  let group = groupOf(snap);
  fact.summary = group.summary;
  if (!group.expanded) {
    checkpoint("collection:open-activity-group");
    const clicked = group.ref;
    snap = await click(snap.generation, clicked);
    group = groupOf(snap, "collection:activity-group-closed");
    fact.groupOpened = true;
    fact.headerRefChanged = group.ref !== clicked;
  }
  checkpoint("collection:codemode-row");
  let { rows, row } = codemodeOf(group, "collection:codemode-row");
  if (!row.open) {
    checkpoint("collection:open-codemode-row");
    const clicked = row.ref;
    snap = await click(snap.generation, clicked);
    fact.disclosures = 1;
    group = groupOf(snap, "collection:activity-group-closed");
    ({ rows, row } = codemodeOf(group, "collection:codemode-row-ambiguous"));
    if (rows.length !== fact.rows) {
      fail("collection:codemode-row-ambiguous", "row set changed", { seenRows: rows.length });
    }
    if (!row.open) fail("collection:codemode-row-closed", "codemode disclosure did not open");
    fact.codemodeRefChanged = row.ref !== clicked;
  }
  checkpoint("collection:metrics-parse");
  let metrics;
  try {
    const text = metricsText(group.scope);
    if (text !== null) metrics = parseNavigationMetrics(text);
  } catch {
    fail("collection:metrics-invalid", "fixed tool metrics invalid");
  }
  if (metrics) return { metrics, collection: fact };
  const failure = programFailure(group.scope);
  if (failure) fail("collection:program-failed", "tool program failed", { program: failure });
  fail("collection:codemode-detail", "codemode detail holds no fixed record");
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
