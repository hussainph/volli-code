import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

import { SHARED_MACHINE_TEST_WORKERS } from "./vitest.workers";

// Root workspace config for the vite-plus quality stack (test / fmt / lint /
// staged). App- and package-level `resolve`/build config lives in each
// package's own vite.config.ts — the root only owns cross-cutting tooling.
const toolingIgnorePatterns = [
  "dist",
  "dist-electron",
  "node_modules",
  "pnpm-lock.yaml",
  "*.tsbuildinfo",
  // Technical reference documents retain their deliberate table formatting.
  "docs",
  "CLAUDE.md",
  // LGPL compliance material that ships inside the packaged app (VC-409).
  // LGPL-LIBVIPS.md is GENERATED, and its `--check` gate compares byte for
  // byte: a formatter that re-indents its lists and pads its table columns
  // makes the generated file permanently "stale" and the gate unpassable.
  // The same reasoning as `docs` above, with a build gate behind it.
  "apps/desktop/licensing",
  // Vendored third-party agent skills (npx skills add) — reformatting would
  // drift them from their skills-lock.json content hashes.
  ".agents",
  // The Document-view markdown corpus keeps the exact variants (`*` vs `_`,
  // Setext underlines, tilde fences) a formatter exists to normalise away.
  "apps/desktop/src/renderer/src/editor/__fixtures__",
  // Written by `convex codegen`; CI regenerates it and fails on any drift, so
  // it must stay byte-for-byte what the pinned CLI emits.
  "convex/functions/_generated",
];

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**", "**/dist-electron/**"],
    // The shared-machine worker cap (VC-339). Spread here for a run started
    // from the repository root; every package spreads the same constant into
    // its own config, because a package config inherits nothing from this one.
    ...SHARED_MACHINE_TEST_WORKERS,
  },
  fmt: {
    ignorePatterns: [
      ...toolingIgnorePatterns,
      // Actual old-peer recordings, kept byte-for-byte with their capture.
      "packages/host-protocol/fixtures/pre-vc722-host-refusal.json",
      "packages/host-protocol/fixtures/pre-vc722-workspace.json",
      "packages/host-protocol/fixtures/pre-vc729-host-models.json",
    ],
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
      // The settings `DataTable` describes each column with a `cell` render
      // prop (`cell: (item) => <Cell>…</Cell>`). The rule's hazard is a
      // component *mounted* from a prop — `<column.cell />` — which React
      // remounts on every parent render, losing state. These are INVOKED as
      // plain functions (`column.cell(item)`), so no element type is ever
      // created from them and there is nothing to remount. `allowAsProps` is
      // the option the rule ships for exactly this shape.
      "react/no-unstable-nested-components": ["error", { allowAsProps: true }],

      // React Compiler rules remain individually disabled pending adoption
      // (VC-216, VC-211). oxlint 1.79 split the inactive compiler rule into
      // ten rules (oxc #25500, #25830, #25840); `globals`, `purity` and
      // `use-memo` are adopted, the seven below are not yet (VC-784). Keep the
      // React plugin and error categories enabled so other rules and newly
      // added rules still enforce. Remove each override only with its
      // corresponding behavior fixes and tests; `vp lint` reports the current
      // findings.
      // Keep the override set scoped to compiler adoption (VC-216); preserve
      // existing error categories for unrelated rules (VC-211). Each enabled
      // rule needs its behavior regression coverage (VC-216). Remove obsolete
      // overrides with those covered fixes, not a broad waiver (VC-216).
      "react/refs": "off",
      "react/set-state-in-effect": "off",
      "react/exhaustive-effect-dependencies": "off",
      "react/hooks": "off",
      "react/immutability": "off",
      "react/memo-dependencies": "off",
      "react/preserve-manual-memoization": "off",
    },
    overrides: [
      {
        // A test's probe component exists to hand render-time values to the
        // assertions around it: `function Probe() { handle = useThing(); }`
        // captures a hook's result, and `renders += 1` counts renders because
        // the render count IS what the test measures. Writing an outer
        // variable during render is the point of those probes, not a hazard,
        // and no test is compiled by React Compiler. Product code keeps the
        // rule at error.
        files: ["**/*.test.ts", "**/*.test.tsx"],
        rules: { "react/globals": "off" },
      },
      {
        // Convex documents carry the system fields `_id` and `_creationTime`,
        // which every backend function reads and patches by. Only those two
        // names are allowed, and only in `convex/`.
        files: ["convex/**/*.ts"],
        rules: { "eslint/no-underscore-dangle": ["error", { allow: ["_id", "_creationTime"] }] },
      },
    ],
  },
  staged: {
    // `vp fmt` (Oxfmt) aborts with "Expected at least one target file" when
    // every path it's handed is unsupported (`.md`) or ignored (the patterns
    // above) — so a commit touching only prose, docs, or the lockfile would
    // fail the hook. Filter the staged set down to what Oxfmt actually formats
    // and skip the command entirely when nothing's left. `vp check` in CI is
    // the full-tree format gate, so nothing slips through unformatted.
    // `--no-error-on-unmatched-pattern` covers what this list misses (dotfiles
    // like `.gitignore`, which Oxfmt has no formatter for) without growing an
    // extension blocklist.
    "*": (files) => {
      const targets = files.filter(
        (f) =>
          !f.toLowerCase().endsWith(".md") &&
          !f.endsWith(".tsbuildinfo") &&
          !f.endsWith("pnpm-lock.yaml") &&
          !/(^|\/)(docs|dist|dist-electron|node_modules)\//.test(f),
      );
      return targets.length
        ? `vp fmt --no-error-on-unmatched-pattern ${targets.map((f) => JSON.stringify(f)).join(" ")}`
        : [];
    },
  },
});
