import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { RunTool } from "./tools";

/** Do not follow symlinks, or descend through a working copy into its dependencies. */
export function workAtRisk(dataDir: string, run: RunTool): string[] {
  if (!existsSync(dataDir)) return [];
  const pending = [dataDir];
  const unsafe: string[] = [];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (existsSync(join(path, ".git"))) {
      const dirty = run("git", ["-C", path, "status", "--porcelain"]);
      const unpushed = run("git", ["-C", path, "rev-list", "--count", "@{upstream}..HEAD"]);
      if (
        dirty.status !== 0 ||
        dirty.stdout.trim() !== "" ||
        unpushed.status !== 0 ||
        unpushed.stdout.trim() !== "0"
      )
        unsafe.push(path);
    } else {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory() && !["node_modules", ".git"].includes(entry.name))
          pending.push(join(path, entry.name));
      }
    }
  }
  return unsafe;
}
