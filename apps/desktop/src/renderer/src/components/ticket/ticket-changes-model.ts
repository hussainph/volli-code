/**
 * Pure presentation for the Changes navigator (decision #53 / monaco-migration §9).
 *
 * The Changes rail is a compact flat list: filename leads, parent path stays muted
 * and secondary, status + line counts trail. Deep repository structure belongs to
 * the project-level Files surface — not here. All formatting and sort rules live
 * in this module so the React panel stays a thin shell.
 */

import { baseNameOf, dirNameOf } from "@volli/shared";

/** Filename + parent directory for a worktree-relative Change Set path. */
export function splitChangePath(path: string): { filename: string; parentPath: string } {
  return { filename: baseNameOf(path), parentPath: dirNameOf(path) };
}
