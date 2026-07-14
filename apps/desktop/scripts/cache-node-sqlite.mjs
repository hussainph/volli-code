/**
 * Caches a plain-Node-ABI `better_sqlite3.node` alongside the Electron-ABI
 * build that `rebuild:native` bakes into `build/Release`.
 *
 * Why: the app loads better-sqlite3 inside Electron (Electron ABI), but the
 * repo/integration tests run under plain Node via `vp test` (Node ABI). One
 * installed binary can't serve both, and rebuilding back and forth per run is
 * not a dev loop. Instead the tests pass better-sqlite3's `nativeBinding`
 * option pointing at the binary cached here (see `src/main/db/test-helpers.ts`),
 * and the default binding stays Electron-ABI for the app.
 *
 * The binary lands at `<pkg>/prebuilds/better_sqlite3-v<ver>-node-v<abi>.node`:
 * resolvable from any cwd via module resolution, keyed by version+ABI so stale
 * copies are never picked up, and out of `build/`'s blast radius when
 * electron-rebuild wipes it. prebuild-install keeps its own download cache in
 * `~/.npm/_prebuilds`, so re-installs are offline-fast.
 *
 * A fetch failure warns and exits 0 (postinstall must not brick installs on a
 * network hiccup); the test helper throws a pointed error if the binding is
 * missing when a test actually needs it.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

const pkgJsonPath = require.resolve("better-sqlite3/package.json");
const pkgDir = dirname(pkgJsonPath);
const { version } = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
const abi = process.versions.modules;
const target = join(pkgDir, "prebuilds", `better_sqlite3-v${version}-node-v${abi}.node`);

if (existsSync(target)) {
  console.log(`[cache-node-sqlite] up to date: ${target}`);
  process.exit(0);
}

// prebuild-install is better-sqlite3's own dependency, so it is always present
// and version-matched; resolve it from the package's context (pnpm isolation).
const prebuildInstallBin = require.resolve("prebuild-install/bin.js", { paths: [pkgDir] });

// Run prebuild-install against a bare copy of the package manifest in a temp
// dir so the download never touches the real (Electron-ABI) build output.
const temp = mkdtempSync(join(tmpdir(), "bsq3-node-abi-"));
try {
  copyFileSync(pkgJsonPath, join(temp, "package.json"));
  const result = spawnSync(
    process.execPath,
    [prebuildInstallBin, "--runtime", "node", "--target", process.versions.node],
    { cwd: temp, stdio: "inherit" },
  );
  const built = join(temp, "build", "Release", "better_sqlite3.node");
  if (result.status !== 0 || !existsSync(built)) {
    console.warn(
      "[cache-node-sqlite] WARN: could not fetch the Node-ABI better-sqlite3 prebuild. " +
        "db tests under plain Node will fail until `pnpm -C apps/desktop run cache:node-sqlite` " +
        "succeeds with network access.",
    );
    process.exit(0);
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(built, target);
  console.log(`[cache-node-sqlite] cached ${target}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
