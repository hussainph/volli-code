import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");

function packageVersion(path: string): string {
  return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
}

function git(args: readonly string[]): string | null {
  try {
    return execFileSync("git", [...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function sourceRevision(): string {
  const revision = process.env["VOLLI_SOURCE_REVISION"] ?? git(["rev-parse", "--short=12", "HEAD"]);
  if (revision === null) return "unknown-source";
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]);
  return dirty === null || dirty.length === 0 ? revision : `${revision}+dirty`;
}

const revision = sourceRevision();
const buildId =
  process.env["VOLLI_BUILD_ID"] ?? `${revision}@${new Date().toISOString().replaceAll(":", "-")}`;

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      // Sources, not fixtures: `src/__snapshots__` holds the captured CLI
      // reference, which is text to compare against rather than code to run.
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/build-identity.ts"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
  pack: {
    define: {
      __VOLLI_CLI_VERSION__: JSON.stringify(packageVersion(resolve(packageRoot, "package.json"))),
      __VOLLI_RELEASE_VERSION__: JSON.stringify(
        packageVersion(resolve(repositoryRoot, "package.json")),
      ),
      __VOLLI_SOURCE_REVISION__: JSON.stringify(revision),
      __VOLLI_BUILD_ID__: JSON.stringify(buildId),
    },
    entry: { volli: "src/index.ts" },
    format: "cjs",
    outDir: "dist",
    outExtensions: () => ({ js: ".cjs" }),
    clean: true,
    deps: { alwaysBundle: (id: string) => id.startsWith("@volli/") },
  },
});
