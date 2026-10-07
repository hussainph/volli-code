// @vitest-environment node
/**
 * Keeps Electron main on the structured log (VC-699): a bare `console.*` line
 * skips the desktop's log files, their redaction and their correlation, so a
 * new one fails here instead of reaching a support log as unattributed text.
 *
 * Out of scope on purpose: tests and their support files, and `src/main/log/**`,
 * which owns the destinations themselves.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const MAIN = fileURLToPath(new URL("..", import.meta.url));
const BARE_CONSOLE = /\bconsole\.(?:log|info|warn|error|debug)\(/u;

function excluded(path: string): boolean {
  const parts = path.split(sep);
  return (
    path.endsWith(".test.ts") ||
    path.endsWith(".test-support.ts") ||
    parts.includes("test-support") ||
    parts[0] === "log"
  );
}

function productionSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...productionSources(path));
    else if (entry.isFile() && path.endsWith(".ts") && !excluded(relative(MAIN, path))) {
      found.push(path);
    }
  }
  return found;
}

describe("Electron main logs through hostLogger", () => {
  it("scans a real tree", () => {
    // A path mistake would make the guard below pass over nothing.
    expect(productionSources(MAIN).length).toBeGreaterThan(50);
  });

  it("calls no console method directly", () => {
    const offenders = productionSources(MAIN).flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          BARE_CONSOLE.test(line) ? [`src/main/${relative(MAIN, path)}:${index + 1}`] : [],
        ),
    );
    expect(offenders, 'use hostLogger("<component>") from @volli/host-core/log').toEqual([]);
  });
});
