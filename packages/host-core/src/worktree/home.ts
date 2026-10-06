/**
 * Resolves the `~` the `.volli/worktrees` tree lives under. `deps.home` wins
 * (tests point it at a temp dir); otherwise `os.homedir()`. Isolated here so
 * every entrypoint resolves home identically.
 */
import { homedir } from "node:os";

import type { WorktreePorts } from "./types";

export function homeDir(deps: Pick<WorktreePorts, "home">): string {
  return deps.home ?? homedir();
}
