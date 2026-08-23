import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import {
  REQUIRED_NODE_RANGE,
  dbOpenFailureLogLine,
  describeDbOpenFailure,
  isNativeModuleFailure,
} from "./db-open-failure";

// The exact text better-sqlite3 surfaces when its addon was built for a
// different Node ABI — the failure Adrian's onboarding reduced to (VC-76).
const ABI_MISMATCH =
  "The module '/repo/node_modules/better-sqlite3/build/Release/better_sqlite3.node' " +
  "was compiled against a different Node.js version using NODE_MODULE_VERSION 127. " +
  "This version of Node.js requires NODE_MODULE_VERSION 137.";

describe("describeDbOpenFailure", () => {
  it("names the Node incompatibility and the dev-loop fix in a development build", () => {
    const described = describeDbOpenFailure(new Error(ABI_MISMATCH), { dev: true });
    expect(described).toContain(ABI_MISMATCH);
    expect(described).toContain("Node version incompatibility");
    expect(described).toContain(REQUIRED_NODE_RANGE);
    expect(described).toContain("pnpm install");
  });

  it("tells a packaged-app user what they can actually do, in their own vocabulary", () => {
    // The audience test (VC-160): a packaged user has no repo, no .nvmrc, no
    // nvm and no pnpm, so every word of the dev remedy is advice about
    // somebody else's machine — and the ABI numbers are not theirs to read.
    const described = describeDbOpenFailure(new Error(ABI_MISMATCH));
    expect(described).toContain("reopen Volli");
    expect(described).toContain("reinstall");
    for (const devVocabulary of [
      "nvm",
      "pnpm",
      "NODE_MODULE_VERSION",
      "better-sqlite3",
      "node_modules",
    ]) {
      expect(described).not.toContain(devVocabulary);
    }
  });

  it("classifies a dlopen failure (the wrapped form Node 18+ throws) the same way", () => {
    const error = Object.assign(new Error(`ERR_DLOPEN_FAILED: ${ABI_MISMATCH}`), {
      code: "ERR_DLOPEN_FAILED",
    });
    expect(describeDbOpenFailure(error, { dev: true })).toContain("Node version incompatibility");
  });

  it("classifies a build that never happened — the module file simply missing", () => {
    const described = describeDbOpenFailure(
      new Error(
        "Cannot find module '/repo/node_modules/better-sqlite3/build/Release/better_sqlite3.node'",
      ),
      { dev: true },
    );
    expect(described).toContain("Node version incompatibility");
  });

  it("leaves a plain I/O failure untouched for either audience — no invented Node story", () => {
    const message = "SQLITE_CANTOPEN: unable to open database file";
    expect(describeDbOpenFailure(new Error(message))).toBe(message);
    expect(describeDbOpenFailure(new Error(message), { dev: true })).toBe(message);
    expect(isNativeModuleFailure(message)).toBe(false);
  });

  it("survives a non-Error throw", () => {
    expect(describeDbOpenFailure("disk full")).toBe("disk full");
  });
});

describe("dbOpenFailureLogLine", () => {
  it("keeps the raw message and the dev-loop remedy, whatever the build", () => {
    // The log is where a developer looks, including when diagnosing a packaged
    // user's report of the plain-language message.
    const logged = dbOpenFailureLogLine(new Error(ABI_MISMATCH));
    expect(logged).toContain(ABI_MISMATCH);
    expect(logged).toContain(".nvmrc");
    expect(logged).toContain("pnpm install");
  });

  it("passes a plain I/O failure through untouched", () => {
    expect(dbOpenFailureLogLine(new Error("SQLITE_CANTOPEN: unable to open database file"))).toBe(
      "SQLITE_CANTOPEN: unable to open database file",
    );
  });
});

describe("REQUIRED_NODE_RANGE", () => {
  // Main cannot read the root manifest at runtime (it is not packaged), so
  // this assertion is the sync between the printed range and the real pin.
  it("matches the root package.json engines.node", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
    ) as { engines?: { node?: string } };
    expect(REQUIRED_NODE_RANGE).toBe(manifest.engines?.node);
  });
});
