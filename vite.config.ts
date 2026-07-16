import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// Root workspace config for the vite-plus quality stack (test / fmt / lint /
// staged). App- and package-level `resolve`/build config lives in each
// package's own vite.config.ts — the root only owns cross-cutting tooling.
const toolingIgnorePatterns = [
  "dist",
  "dist-electron",
  "node_modules",
  "pnpm-lock.yaml",
  "*.tsbuildinfo",
  // Curated prose — mechanical reflow of the decision-log tables is noise.
  "docs",
  "CLAUDE.md",
  // Vendored third-party agent skills (npx skills add) — reformatting would
  // drift them from their skills-lock.json content hashes.
  ".agents",
];

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**", "**/dist-electron/**"],
  },
  fmt: {
    ignorePatterns: toolingIgnorePatterns,
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: toolingIgnorePatterns,
    plugins: ["eslint", "oxc", "react", "typescript", "unicorn"],
    options: {
      typeAware: false,
      typeCheck: false,
    },
    // "error", not "warn": warnings never fail `vp lint`/`vp check`, so a
    // warn-level gate can't actually block CI or the pre-commit hook.
    categories: {
      correctness: "error",
      suspicious: "error",
      perf: "error",
    },
    rules: {
      // React 17+ automatic JSX runtime — no `import React` needed in scope.
      "react-in-jsx-scope": "off",
      // Sequential dev-resource polling in scripts/wait-for-resources.mjs is
      // deliberate; Promise.all would defeat the interval backoff.
      "eslint/no-await-in-loop": "off",
    },
  },
  staged: {
    // `vp fmt` (Oxfmt) aborts with "Expected at least one target file" when
    // every path it's handed is unsupported (`.md`) or ignored (the patterns
    // above) — so a commit touching only prose, docs, or the lockfile would
    // fail the hook. Filter the staged set down to what Oxfmt actually formats
    // and skip the command entirely when nothing's left. `vp check` in CI is
    // the full-tree format gate, so nothing slips through unformatted.
    "*": (files) => {
      const targets = files.filter(
        (f) =>
          !f.toLowerCase().endsWith(".md") &&
          !f.endsWith(".tsbuildinfo") &&
          !f.endsWith("pnpm-lock.yaml") &&
          !/(^|\/)(docs|dist|dist-electron|node_modules)\//.test(f),
      );
      return targets.length ? `vp fmt ${targets.map((f) => JSON.stringify(f)).join(" ")}` : [];
    },
  },
});
