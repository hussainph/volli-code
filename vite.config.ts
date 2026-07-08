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
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
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
    "*": "vp fmt",
  },
});
