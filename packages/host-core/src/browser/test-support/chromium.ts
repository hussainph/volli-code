/**
 * Which Chromium the tests drive (VC-619), resolved the way a host would:
 * `VOLLI_CHROMIUM_PATH` first, then the Chrome for Testing build the
 * lockfile's `playwright-core` pins (`playwright-core install chromium
 * --no-shell`). Tests only: host-core's production code never imports
 * `playwright-core`; a host states `executablePath` itself.
 *
 * Absent, the Chromium suites skip — unless `VOLLI_REQUIRE_CHROMIUM=1`, which
 * CI's "Test (packages)" lane sets so a missing browser fails rather than
 * passing quietly.
 */
import { existsSync } from "node:fs";

import { chromium } from "playwright-core";

export interface TestChromium {
  executablePath: string;
  /** `VOLLI_CHROMIUM_NO_SANDBOX=1`: a container that cannot provide namespaces. CI never sets it. */
  noSandbox: boolean;
}

function resolve(): TestChromium | null {
  const explicit = process.env["VOLLI_CHROMIUM_PATH"];
  const executablePath =
    explicit !== undefined && explicit !== "" ? explicit : chromium.executablePath();
  if (!existsSync(executablePath)) return null;
  return { executablePath, noSandbox: process.env["VOLLI_CHROMIUM_NO_SANDBOX"] === "1" };
}

/** The browser to drive, or null to skip; throws when a browser is required and missing. */
export function testChromium(): TestChromium | null {
  const found = resolve();
  if (found === null && process.env["VOLLI_REQUIRE_CHROMIUM"] === "1") {
    throw new Error(
      "VOLLI_REQUIRE_CHROMIUM=1 but no Chromium was found: run `pnpm exec playwright-core install chromium --no-shell` or set VOLLI_CHROMIUM_PATH",
    );
  }
  return found;
}
