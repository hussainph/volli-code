/** Shared by the copy and Glass gates. File/rule ceilings can only shrink. */
import { readFileSync } from "node:fs";

const KNOWN_RULES = new Set([
  "colour-literal",
  "type-literal-size",
  "icon-duotone",
  "icon-set-import",
  "material-hand-rolled-blur",
  "radius-off-scale",
  "motion-literal",
  "motion-reduced-hook",
  "eyebrow-uppercase",
  "copy-loading-ellipsis",
  "copy-banned-word",
  "copy-url-in-ui",
  "markup-native-select",
  "markup-settings-description",
]);

export function checkAllowlist(findings, entries, rules) {
  const keys = new Set();
  for (const entry of entries) {
    const key = `${entry.path}:${entry.rule}`;
    if (
      !KNOWN_RULES.has(entry.rule) ||
      typeof entry.path !== "string" ||
      !entry.path.startsWith("apps/desktop/src/renderer/") ||
      typeof entry.reason !== "string" ||
      !entry.reason.trim() ||
      !Number.isSafeInteger(entry.maxCount) ||
      entry.maxCount < 1 ||
      keys.has(key)
    )
      throw new Error(`Malformed or duplicate shrinking allowlist entry: ${key}`);
    keys.add(key);
  }
  const relevant = entries.filter((entry) => rules.includes(entry.rule));
  const counts = new Map();
  for (const finding of findings) {
    const key = `${finding.path}:${finding.rule}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const unexcused = findings.filter((finding) => {
    const entry = relevant.find((item) => item.path === finding.path && item.rule === finding.rule);
    return !entry || counts.get(`${finding.path}:${finding.rule}`) > entry.maxCount;
  });
  // Lower counts fail too: reduce the ceiling as part of every repair.
  const stale = relevant.filter(
    (entry) => (counts.get(`${entry.path}:${entry.rule}`) ?? 0) < entry.maxCount,
  );
  return { unexcused, stale };
}

export function reportFindings(findings, rules, allowlist) {
  const entries = JSON.parse(readFileSync(allowlist, "utf8")).entries;
  const { unexcused, stale } = checkAllowlist(findings, entries, rules);
  for (const { path, line, rule, text, excerpt } of unexcused) {
    console.error(`${path}:${line} ${rule}: ${excerpt ?? text}`);
  }
  for (const { path, rule, maxCount } of stale) {
    console.error(`${path} ${rule}: stale ceiling ${maxCount}; shrink/remove this allowlist entry`);
  }
  if (process.argv.includes("--counts")) {
    for (const rule of rules)
      console.log(`${rule}: ${findings.filter((item) => item.rule === rule).length}`);
  }
  if (unexcused.length || stale.length) process.exitCode = 1;
  else console.log(`Design guardrails: PASS (${findings.length} inventoried occurrences).`);
}
