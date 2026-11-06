/**
 * The BYO lane's legs and how they report (VC-1043).
 *
 * A leg is one acceptance claim from the sprint plan (BYO-14). It names the
 * merged work it needs (`needs`: files whose presence means that ticket has
 * landed on this tree) and the legs it builds on (`after`). A run reports
 * each leg as exactly one of:
 *
 * - `passed` / `failed`: it ran;
 * - `pending`: work it needs has not merged (the missing files and tickets
 *   are named), or the leg is declared but not wired yet;
 * - `blocked`: a leg it builds on did not pass.
 *
 * A failed leg always fails the run. Pending and blocked legs fail it only
 * under `requireAll`, which the final lane sets once every leg is wired: the
 * scaffold's job is to stay green and honest while the sprint lands, never
 * to pass on a claim it did not test. The summary says which is which.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Whether a prerequisite holds on the tree at `root`: the file exists and,
 * when `contains` is given, includes that text.
 */
export function prerequisiteMet(root, need) {
  const path = join(root, need.path);
  if (!existsSync(path)) return false;
  if (need.contains === undefined) return true;
  try {
    return readFileSync(path, "utf8").includes(need.contains);
  } catch {
    return false;
  }
}

export function missingPrerequisites(root, leg) {
  return (leg.needs ?? []).filter((need) => !prerequisiteMet(root, need));
}

/** One line naming what a pending leg waits on. */
export function describeMissing(missing) {
  return missing
    .map(
      (need) => `${need.ticket}: ${need.path}${need.contains ? ` (with "${need.contains}")` : ""}`,
    )
    .join("; ");
}

/**
 * Run `legs` in order against `context`. A leg's `run(context, log)` may
 * return a detail string; a throw fails it. Never throws itself.
 */
export async function runLegs(legs, context, { root, log = () => {}, now = Date.now } = {}) {
  const results = [];
  const outcome = new Map();
  for (const leg of legs) {
    const started = now();
    const base = { id: leg.id, title: leg.title };
    const unmet = (leg.after ?? []).filter((id) => outcome.get(id) !== "passed");
    const missing = missingPrerequisites(root, leg);
    // A leg that needs the box cannot run on a plain shell (`--host-shell`).
    if (leg.needsBox && context.box?.hostShell) {
      const result = { ...base, status: "pending", detail: "host shell: not a box", missing: [] };
      results.push(result);
      outcome.set(leg.id, result.status);
      log(`[${leg.id}] pending: host shell: not a box`);
      continue;
    }
    if (unmet.length > 0) {
      const waiting = missing.length > 0 ? `; also waiting on ${describeMissing(missing)}` : "";
      const result = {
        ...base,
        status: "blocked",
        detail: `needs ${unmet.join(", ")} to pass first${waiting}`,
        missing,
      };
      results.push(result);
      outcome.set(leg.id, result.status);
      log(`[${leg.id}] blocked: ${result.detail}`);
      continue;
    }
    if (missing.length > 0 || typeof leg.run !== "function") {
      const detail =
        missing.length > 0
          ? `waiting on ${describeMissing(missing)}`
          : "prerequisites merged; the leg is not wired yet (VC-1043 final)";
      const result = { ...base, status: "pending", detail, missing };
      results.push(result);
      outcome.set(leg.id, result.status);
      log(`[${leg.id}] pending: ${detail}`);
      continue;
    }
    log(`[${leg.id}] running: ${leg.title}`);
    try {
      const detail = (await leg.run(context, (line) => log(`[${leg.id}] ${line}`))) ?? "";
      results.push({ ...base, status: "passed", detail: String(detail), ms: now() - started });
      outcome.set(leg.id, "passed");
      log(`[${leg.id}] passed`);
    } catch (error) {
      const detail = String(error?.stack ?? error);
      results.push({ ...base, status: "failed", detail, ms: now() - started });
      outcome.set(leg.id, "failed");
      log(`[${leg.id}] FAILED: ${detail}`);
    }
  }
  return results;
}

/** The run's exit code: any failure is red; pending/blocked are red only under `requireAll`. */
export function exitCodeFor(results, { requireAll = false } = {}) {
  if (results.some((result) => result.status === "failed")) return 1;
  if (requireAll && results.some((result) => result.status !== "passed")) return 1;
  return 0;
}

const MARK = { passed: "PASS", failed: "FAIL", pending: "PENDING", blocked: "BLOCKED" };

/** One Markdown table cell: backslashes first, so an escaped pipe stays escaped. */
function cell(text) {
  return String(text)
    .replace(/\\/gu, "\\\\")
    .replace(/\|/gu, "\\|")
    .replace(/\s*\n\s*/gu, " ")
    .slice(0, 400);
}

/** A Markdown summary for the job page; each leg's first detail line only. */
export function renderSummary(results, { requireAll = false, headSha = null } = {}) {
  const lines = [
    "### BYO runner acceptance",
    "",
    requireAll
      ? "Every leg must pass (final lane)."
      : "Scaffold: a failed leg is red; a pending or blocked leg is reported, not passed.",
    ...(headSha ? ["", `Head: \`${headSha}\``] : []),
    "",
    "| Leg | Result | Detail |",
    "|---|---|---|",
  ];
  for (const result of results) {
    const first = String(result.detail ?? "").split("\n")[0];
    lines.push(`| ${cell(result.title)} | ${MARK[result.status]} | ${cell(first)} |`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Secret shapes redacted wherever they appear, known or not: runner install
 * tokens, credentials and poll secrets (`RUNNER_SECRET_PREFIXES`), GitHub
 * user, refresh and installation tokens, and anything JWT-shaped.
 */
const SECRET_SHAPES = [
  /\b(vr[tcp]|gh[usroa])_[A-Za-z0-9_-]{8,}/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
];

/**
 * Remove every occurrence of each secret from `text` (evidence and logs),
 * then every secret-shaped token. Short values are left alone: they cannot
 * be secrets and would shred the text.
 */
export function redact(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8)
      out = out.split(secret).join("[redacted]");
  }
  for (const shape of SECRET_SHAPES) {
    out = out.replace(shape, (_match, prefix) =>
      typeof prefix === "string" ? `${prefix}_[redacted]` : "[redacted-jwt]",
    );
  }
  return out;
}
