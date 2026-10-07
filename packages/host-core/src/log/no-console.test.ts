/**
 * Keeps host-core's production code on the structured log (VC-699): a bare
 * `console.*` line skips the host's destination, its redaction and its
 * correlation, so a new one fails here instead of reaching a support log as
 * unattributed text.
 *
 * Out of scope on purpose: tests and their support files, `src/testing/**`
 * (test support shipped to other packages) and `src/log/**`, whose console
 * sink writes to the console by design.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const BARE_CONSOLE = /\bconsole\.(?:log|info|warn|error|debug)\(/u;

function excluded(path: string): boolean {
  const parts = path.split(sep);
  return (
    path.endsWith(".test.ts") ||
    path.endsWith(".test-support.ts") ||
    parts.includes("test-support") ||
    parts[0] === "testing" ||
    parts[0] === "log"
  );
}

function productionSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...productionSources(path));
    else if (entry.isFile() && path.endsWith(".ts") && !excluded(relative(SRC, path))) {
      found.push(path);
    }
  }
  return found;
}

describe("host-core production code logs through hostLogger", () => {
  it("scans a real tree", () => {
    // A path mistake would make the guard below pass over nothing.
    expect(productionSources(SRC).length).toBeGreaterThan(100);
  });

  it("calls no console method directly", () => {
    const offenders = productionSources(SRC).flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          BARE_CONSOLE.test(line) ? [`src/${relative(SRC, path)}:${index + 1}`] : [],
        ),
    );
    expect(offenders, 'use hostLogger("<component>") from src/log/root').toEqual([]);
  });
});
