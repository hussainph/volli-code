/**
 * Resolves the `~` the `.volli/worktrees` tree lives under. `deps.home` wins
 * (tests point it at a temp dir); otherwise `os.homedir()`. Isolated here so
 * every entrypoint resolves home identically.
 */
import { homedir } from "node:os";

import type { WorktreeDeps } from "./types";

export function homeDir(deps: Pick<WorktreeDeps, "home">): string {
  return deps.home ?? homedir();
}
