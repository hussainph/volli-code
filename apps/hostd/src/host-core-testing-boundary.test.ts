/**
 * hostd never builds what only tests may build (VC-632).
 *
 * `@volli/host-core/testing` serves fixtures and the Session writer's
 * standalone constructors (`createSqliteSessionLedger`, a test engine). A
 * second writer built by hand never wakes the host's watches, so in
 * production the one writer comes from `createHostCore`. This scan names any
 * non-test source under `src/` that imports `./testing`, or that builds an
 * engine itself with `@volli/session-engine`'s `createSessionEngine`.
 * Desktop holds the same guard over its own sources.
 */
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const HOSTD_SRC = fileURLToPath(new URL(".", import.meta.url));
const TESTING = ["@volli", "host-core", "testing"].join("/");
const ENGINE_FACTORY = ["create", "SessionEngine"].join("");

const isTest = (file: string) => /\.test\.tsx?$/.test(file);

describe("host-core's testing entry", () => {
  it("is imported by tests only, and production builds no Session engine of its own", () => {
    const offenders = globSync("**/*.{ts,tsx,mts}", { cwd: HOSTD_SRC })
      .filter((file) => !isTest(file))
      .flatMap((file) => {
        const source = readFileSync(`${HOSTD_SRC}${file}`, "utf8");
        const found: string[] = [];
        if (source.includes(`"${TESTING}"`)) found.push(`${file}: imports ${TESTING}`);
        if (new RegExp(`\\b${ENGINE_FACTORY}\\b`).test(source))
          found.push(`${file}: names ${ENGINE_FACTORY}`);
        return found;
      });
    expect(offenders).toEqual([]);
  });
});
