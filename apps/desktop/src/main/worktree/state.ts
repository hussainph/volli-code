/**
 * `listBranches` backs the Details-rail base-branch picker.
 */
import { getProjectById } from "../db/projects-repo";
import { err, ok, type WorktreeDeps, type WorktreeResult } from "./types";

/**
 * Local branch names for a project (`git for-each-ref refs/heads`), for the
 * base-branch picker. Synchronous — a cheap ref read, no network.
 */
export function listBranches(deps: WorktreeDeps, projectId: string): WorktreeResult<string[]> {
  const project = getProjectById(deps.db, projectId);
  if (!project) return err("Unknown project");
  try {
    const output = deps.git(
      ["for-each-ref", "refs/heads", "--format=%(refname:short)"],
      project.path,
    );
    const branches = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return ok(branches);
  } catch (caught) {
    return err(caught instanceof Error ? caught.message : String(caught));
  }
}
