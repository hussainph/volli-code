import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The cached headless browser used by the local UI lab checks. */
export function chromiumPath() {
  const root = join(homedir(), "Library", "Caches", "ms-playwright");
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith("chromium_headless_shell-"))
    .toSorted()
    .toReversed();
  for (const dir of dirs) {
    const candidate = join(root, dir, "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("no playwright chromium headless shell under " + root);
}
