import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Replace SQLite's preferred platform prebuild with a build on the ABI baseline. */
export function rebuildSqlite(moduleRoot, arch, execute = execFileSync) {
  if (!["x64", "arm64"].includes(arch)) throw new Error(`Unsupported SQLite arch: ${arch}`);
  // v13's implicit node-gyp install is a no-op when a prebuild exists. Its
  // explicit release script passes --force_build=1, so it really compiles.
  // npm supplies its bundled node-gyp to lifecycle scripts; no dev dependency
  // or globally installed node-gyp is needed in this production deploy tree.
  execute("npm", ["run", "build-release"], { cwd: moduleRoot, stdio: "inherit" });
  const build = join(moduleRoot, "build");
  const temp = mkdtempSync(join(moduleRoot, ".runner-sqlite-"));
  try {
    const rebuilt = join(temp, "sqlite.node");
    copyFileSync(join(build, "Release", "better_sqlite3.node"), rebuilt);
    // Rename, not overwrite: pnpm may have hardlinked the original prebuild
    // from its immutable store. Other links must keep their original bytes.
    renameSync(rebuilt, join(moduleRoot, "prebuilds", `linux-${arch}.node`));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  // The runtime prefers prebuilds/, including platform-specific entrypoints.
  // Do not ship unused compiler objects or a second copy of the same binary.
  rmSync(build, { recursive: true, force: true });
}
