/**
 * Reading a workspace's repository instruction file off disk (VC-1054) — the
 * one disk read behind the `repository instructions` resource a structured
 * Session is born with. Selection, cap and truncation are `@volli/shared`'s
 * `repoInstructionsResource`; this module only fetches the candidates.
 *
 * The failure policy is the skills index's: nobody asked for this file, so a
 * missing one is the normal case and an unreadable one costs the resource,
 * never the Session. A read that fails for any reason but absence is logged
 * and skipped.
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import {
  errorMessage,
  REPO_INSTRUCTIONS_FILES,
  repoInstructionsResource,
  type PromptResource,
  type RepoInstructionsSource,
} from "@volli/shared";

import { hostLogger } from "./log/root";

const log = hostLogger("repo-instructions");

async function readCandidate(path: string): Promise<string | null> {
  try {
    return await fsp.readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      log.warn("repository instructions unreadable", { path, reason: errorMessage(error) });
    }
    return null;
  }
}

/**
 * The repository instructions at `workspaceDir`'s root, as the resource a
 * Session records at birth, or `null` when there are none to send.
 */
export async function readRepoInstructions(workspaceDir: string): Promise<PromptResource | null> {
  const sources: RepoInstructionsSource[] = [];
  for (const file of REPO_INSTRUCTIONS_FILES) {
    const text = await readCandidate(join(workspaceDir, file));
    if (text !== null) sources.push({ file, text });
  }
  return repoInstructionsResource(sources);
}
