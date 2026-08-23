/**
 * The `env` block `volli identify` reports (VC-94): what main can say about
 * the environment a Session will run in, built from the one boot-time
 * adoption outcome rather than re-derived.
 *
 * Main is the only process that can report the provenance — whether the
 * session PATH was adopted from the login shell, was already complete, or
 * fell back after a failed probe — because main ran the probe
 * (`login-shell-path.ts`). Both passes' provenance, since A3: the boot one and
 * the post-window interactive one are separate facts and a report that named
 * only the first would describe a session started before that pass and one
 * started after identically. The tools and the dependency state are resolved
 * here against that PATH, so the report is one consistent answer instead of
 * two environments disagreeing the way the Settings pane and the sessions
 * did for the whole of VC-94's incident.
 *
 * The disk questions are seams with real defaults, so tests can script a
 * filesystem that does not exist.
 */
import { constants, existsSync } from "node:fs";
import { access, stat } from "node:fs/promises";

import {
  memoizedPathExists,
  requiredSessionEnvTools,
  resolveSessionEnvTools,
  workspaceDependenciesStatus,
} from "@volli/shared";
import type {
  SessionEnvInteractiveProvenance,
  SessionEnvProvenance,
  SessionEnvReport,
} from "@volli/shared";

/**
 * Whether a path is executable — the same question a shell asks of PATH,
 * which requires a regular file: `access(X_OK)` alone passes for a
 * directory, and a directory named `git` on a PATH entry is not a tool a
 * session can run. `stat` follows symlinks, so a link to an executable file
 * still counts, exactly as it does for a shell.
 */
export async function executableAt(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface SessionEnvReportDeps {
  /** The session's resolved PATH — post-adoption, bin dir first. */
  path: string;
  /** The boot adoption outcome's kind: how `path` came to be what it is. */
  provenance: SessionEnvProvenance;
  /**
   * The post-window interactive pass's kind, or `pending` while it has yet to
   * answer. Read from the bootstrap at call time, never awaited — see
   * `LoginPathBootstrap.interactiveProvenance`.
   */
  interactiveProvenance: SessionEnvInteractiveProvenance;
  /** The workspace root to inspect, omitted for a host-wide environment read. */
  cwd?: string;
  /** Test seam over the filesystem; defaults to the real one. */
  isExecutable?(path: string): Promise<boolean>;
  /**
   * Test seam over the filesystem; defaults to the real one. Memoized for the
   * life of one report, so a seam counting calls sees each path asked once.
   */
  pathExists?(path: string): boolean;
}

export async function buildSessionEnvReport(deps: SessionEnvReportDeps): Promise<SessionEnvReport> {
  const pathEntries = deps.path.split(":").filter((entry) => entry.length > 0);
  // The two workspace questions below walk the same ancestors over the same
  // markers, so they share one memo: one stat per path, and two answers that
  // cannot describe the workspace at two different moments.
  const pathExists = memoizedPathExists(deps.pathExists ?? existsSync);
  return {
    path: deps.path,
    provenance: deps.provenance,
    interactiveProvenance: deps.interactiveProvenance,
    tools: await resolveSessionEnvTools(pathEntries, {
      isExecutable: deps.isExecutable ?? executableAt,
    }),
    // Which of those measurements is allowed to be a fault, decided by what
    // the scoped workspace is (VC-157). A host-wide read has no project to
    // imply anything, and requires nothing.
    requiredTools: deps.cwd === undefined ? [] : requiredSessionEnvTools(deps.cwd, pathExists),
    dependencies: deps.cwd === undefined ? null : workspaceDependenciesStatus(deps.cwd, pathExists),
  };
}
