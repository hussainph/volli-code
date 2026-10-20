#!/usr/bin/env node
/**
 * R8 (VC-727): inspect the shipped artifact, not electron-builder's whitelist.
 * Run after packaging, without launching Electron:
 *   node apps/desktop/scripts/check-packaged-e2e.mjs --app "apps/desktop/release/mac-arm64/Volli Code.app"
 * Checks archive entries AND the loose bundle tree (including app.asar.unpacked
 * and extraResources). Missing artifacts and unreadable archives fail closed.
 */
import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
// Use the same asar reader as the installed packager. Resolve through its
// declared dependency chain so this also works with pnpm's isolated layout;
// no new production dependency, hoisting assumption or Electron runtime.
const builderRequire = createRequire(require.resolve("electron-builder"));
const packagingRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const { listPackage } = packagingRequire("@electron/asar");

const defaultApp = resolve(import.meta.dirname, "../release/mac-arm64/Volli Code.app");

/** @param {string} path */
function hasE2eSegment(path) {
  return path.split(/[\\/]+/).some((segment) => segment.toLowerCase() === "e2e");
}

/**
 * @param {string} appPath An unpacked macOS .app bundle produced by electron-builder.
 * @returns {{ appPath: string, archives: number, archiveEntries: number, looseEntries: number }}
 */
export function checkPackagedE2e(appPath) {
  const app = resolve(appPath);
  if (!lstatSync(app).isDirectory()) throw new Error(`Packaged app is not a directory: ${app}`);
  const mainArchive = join(app, "Contents/Resources/app.asar");
  if (!lstatSync(mainArchive).isFile()) {
    throw new Error(`Packaged app archive is not a file: ${mainArchive}`);
  }

  const violations = [];
  let archives = 0;
  let archiveEntries = 0;
  let looseEntries = 0;

  /** @param {string} directory @param {string} prefix */
  function walk(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      looseEntries += 1;
      if (hasE2eSegment(name)) violations.push(name);
      if (entry.isDirectory()) {
        walk(path, name);
      } else if (entry.isSymbolicLink()) {
        // Framework links can form cycles; their actual bundle trees are
        // walked separately. Inspect the link spelling as well as its name.
        const target = readlinkSync(path);
        if (hasE2eSegment(target)) violations.push(`${name} -> ${target}`);
      } else if (entry.isFile() && entry.name.endsWith(".asar")) {
        archives += 1;
        for (const archivedPath of listPackage(path)) {
          archiveEntries += 1;
          if (hasE2eSegment(archivedPath)) violations.push(`${name}:${archivedPath}`);
        }
      }
    }
  }

  walk(app, "");
  if (violations.length > 0) {
    throw new Error(`Packaged app contains forbidden e2e paths:\n${violations.join("\n")}`);
  }
  return { appPath: app, archives, archiveEntries, looseEntries };
}

/** @param {string[]} args */
function parseApp(args) {
  if (args.length === 0) return defaultApp;
  if (args.length === 2 && args[0] === "--app" && args[1] && !args[1].startsWith("--")) {
    return args[1];
  }
  throw new Error("Usage: node check-packaged-e2e.mjs [--app <packaged .app directory>]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = checkPackagedE2e(parseApp(process.argv.slice(2)));
    console.log(
      `check-packaged-e2e: OK — ${result.appPath}; ${result.archives} archive(s), ` +
        `${result.archiveEntries} archive entries and ${result.looseEntries} loose entries checked.`,
    );
  } catch (error) {
    console.error(`check-packaged-e2e: ${error.message}`);
    process.exitCode = 1;
  }
}
