/**
 * The `env` block `volli identify` reports (VC-94): what main can say about
 * the environment a Session will run in, built from the one boot-time
 * adoption outcome rather than re-derived.
 *
 * Main is the only process that can report the provenance — whether the
 * session PATH was adopted from the login shell, was already complete, or
 * fell back after a failed probe — because main ran the probe
 * (`login-shell-path.ts`). The tools and the dependency state are resolved
 * here against that PATH, so the report is one consistent answer instead of
 * two environments disagreeing the way the Settings pane and the sessions
 * did for the whole of VC-94's incident.
 *
 * The disk questions are seams with real defaults, so tests can script a
 * filesystem that does not exist.
 */
import { constants, existsSync } from "node:fs";
import { access } from "node:fs/promises";

import { resolveSessionEnvTools, workspaceDependenciesStatus } from "@volli/shared";
import type { SessionEnvProvenance, SessionEnvReport } from "@volli/shared";

/** Whether a path is executable — the same question a shell asks of PATH. */
export async function executableAt(path: string): Promise<boolean> {
  try {
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
  /** Where the asking session stands, for the workspace dependency walk. */
  cwd: string;
  /** Test seam over the filesystem; defaults to the real one. */
  isExecutable?(path: string): Promise<boolean>;
  pathExists?(path: string): boolean;
}

export async function buildSessionEnvReport(deps: SessionEnvReportDeps): Promise<SessionEnvReport> {
  const pathEntries = deps.path.split(":").filter((entry) => entry.length > 0);
  return {
    path: deps.path,
    provenance: deps.provenance,
    tools: await resolveSessionEnvTools(pathEntries, {
      isExecutable: deps.isExecutable ?? executableAt,
    }),
    dependencies: workspaceDependenciesStatus(deps.cwd, deps.pathExists ?? existsSync),
  };
}
