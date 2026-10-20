#!/usr/bin/env node
/**
 * Advisory only: a conservative ripgrep inventory, not a reachability proof.
 * TypeScript 7 has no stable compiler/parser API. Avoid a new parser dependency
 * and typechecking the whole repo: read each source once and index identifier
 * spellings. Imports count as references; forwarding exports do not count as
 * callers. Named forwarding aliases are followed by spelling, not module identity.
 * Comments, strings, unrelated same-named identifiers and unused imports can
 * suppress findings. Namespace/dynamic access, computed names, default imports
 * and same-file references need human review. A clean report is NOT wired proof.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IDENTIFIER = String.raw`[$A-Z_a-z][$\w]*`;
const DECLARATION = new RegExp(
  String.raw`\bexport\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum)\s+(${IDENTIFIER})`,
  "g",
);
const EXPORT_LIST = /\bexport\s+(?:type\s+)?\{([^}]+)\}(?:\s*from\s*["'][^"']+["'])?/g;
const FORWARDING =
  /\bexport\s+(?:type\s+)?(?:\*\s*(?:as\s+\w+\s*)?|\{[^}]*\}\s*)from\s*["'][^"']+["']\s*;?/g;

export function isNonProduction(path) {
  return /(?:^|[/.])(?:testing|test-support|lab|__tests__|__fixtures__|e2e)(?:\/|\.)|\.test\./.test(
    path,
  );
}

function inScope(path) {
  return /^(?:packages\/[^/]+\/src\/|apps\/desktop\/src\/)/.test(path);
}

function exportNames(body) {
  return body.split(",").flatMap((item) => {
    const match = item
      .trim()
      .match(new RegExp(`^(?:type\\s+)?(${IDENTIFIER})(?:\\s+as\\s+(${IDENTIFIER}))?$`));
    return match ? [{ local: match[1], name: match[2] ?? match[1] }] : [];
  });
}

/** Inventory source text in memory so tests need neither ripgrep nor a checkout. */
export function findExportedSeams(sources) {
  const candidates = [];
  const references = new Map();
  const aliases = new Map();
  for (const { path, text } of sources) {
    const declarations = [...text.matchAll(DECLARATION)];
    const lists = [...text.matchAll(EXPORT_LIST)];
    for (const list of lists) {
      for (const { local, name } of exportNames(list[1])) {
        if (local !== name) {
          for (const [a, b] of [
            [local, name],
            [name, local],
          ]) {
            if (!aliases.has(a)) aliases.set(a, new Set());
            aliases.get(a).add(b);
          }
        }
      }
    }
    if (inScope(path) && !isNonProduction(path) && !/\.d\.[cm]?ts$/.test(path)) {
      const symbols = new Map(declarations.map((match) => [match[1], match.index]));
      for (const list of lists) {
        // Forwarding is not a new implementation seam; inspect the declaration.
        if (/\bfrom\s*["']/.test(list[0])) continue;
        for (const { name } of exportNames(list[1])) symbols.set(name, list.index);
      }
      for (const [name, index] of symbols) {
        candidates.push({ path, name, line: text.slice(0, index).split("\n").length });
      }
    }
    // Barrel exports alone must not make an uncalled implementation look wired.
    const usage = text.replace(FORWARDING, "").replace(EXPORT_LIST, "");
    for (const name of new Set(usage.match(new RegExp(IDENTIFIER, "g")) ?? [])) {
      if (!references.has(name)) references.set(name, new Set());
      references.get(name).add(path);
    }
  }
  return candidates
    .flatMap((candidate) => {
      const names = new Set([candidate.name]);
      for (const name of names) for (const alias of aliases.get(name) ?? []) names.add(alias);
      const files = new Set();
      for (const name of names) for (const path of references.get(name) ?? []) files.add(path);
      // The declaration's file is not evidence that another production caller exists.
      files.delete(candidate.path);
      if ([...files].some((path) => !isNonProduction(path))) return [];
      return [{ ...candidate, references: [...files].toSorted() }];
    })
    .toSorted(
      (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.name.localeCompare(b.name),
    );
}

export function formatReport(findings, fileCount) {
  const onlyFixtures = findings.filter((finding) => finding.references.length > 0);
  const unreferenced = findings.length - onlyFixtures.length;
  // Group by source root and file to keep the full first inventory small enough
  // to paste into a PR body, without truncating the test/lab-only symbol list.
  const sections = Map.groupBy(
    onlyFixtures,
    ({ path }) => path.match(/^(?:packages\/[^/]+\/src\/|apps\/desktop\/src\/)/)[0],
  );
  const inventory = [];
  for (const [prefix, items] of sections) {
    inventory.push(`### ${prefix}`);
    for (const [path, symbols] of Map.groupBy(items, (item) => item.path)) {
      inventory.push(
        `- ${path.slice(prefix.length)}: ${symbols.map(({ name, line }) => `${name}@${line}`).join(", ")}`,
      );
    }
    inventory.push("");
  }
  return [
    "## Exported seams (advisory)",
    "",
    `Scanned ${fileCount} source files: ${onlyFixtures.length} exports referenced only by tests/lab; ${unreferenced} exports with no external spelling reference.`,
    "Method: conservative ripgrep/name inventory; forwarding exports are not callers. Imports count; aliases are followed by spelling. Not a wiring or dead-code proof.",
    "Scope: packages/*/src and apps/desktop/src; callers searched across packages, apps and scripts. Tests, testing, test-support, lab, e2e and fixture directories are not production callers.",
    "Limitations: comments/strings, name collisions and unused imports can hide gaps; namespace/default/dynamic access and same-file use can produce false positives. Review the named caller manually.",
    "Unreferenced exports are counted, not listed. Below: all test/lab-only names at declaration lines (name@line); file paths are relative to each heading.",
    "",
    ...inventory,
  ].join("\n");
}

/** Errors are printed, never turned into a failing advisory process. */
export function runAdvisory({
  root = ROOT,
  summary = process.env.GITHUB_STEP_SUMMARY,
  print = console.log,
  rgPath,
} = {}) {
  try {
    // CI does not promise a system rg. Reuse host-core's already-installed,
    // platform-specific binary rather than installing tooling in the workflow.
    const binary =
      rgPath ??
      createRequire(new URL("../packages/host-core/package.json", import.meta.url))(
        "@vscode/ripgrep",
      ).rgPath;
    const listing = spawnSync(
      binary,
      [
        "--files",
        "packages",
        "apps",
        "scripts",
        "-g",
        "*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
        "-g",
        "!*.d.ts",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (listing.error || listing.status !== 0)
      throw new Error(listing.error?.message ?? listing.stderr.trim() ?? "ripgrep failed");
    const sources = listing.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .toSorted()
      .map((path) => ({
        path,
        text: readFileSync(resolve(root, path), "utf8"),
      }));
    const report = formatReport(findExportedSeams(sources), sources.length);
    print(report);
    if (summary) appendFileSync(summary, report);
  } catch (error) {
    const diagnostic = `Exported seams advisory unavailable: ${error instanceof Error ? error.message : String(error)}. No gate failed; inspect production callers manually.\n`;
    print(diagnostic);
    if (summary) {
      try {
        appendFileSync(summary, diagnostic);
      } catch {
        // The original error is already in stdout (including summary write
        // failures). A broken summary destination must not fail this advisory.
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runAdvisory();
