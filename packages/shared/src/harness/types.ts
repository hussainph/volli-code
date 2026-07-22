import type { HarnessId } from "../ticket";

export type InstallAction =
  | { kind: "write"; path: string; content: string; managed: true }
  | { kind: "symlink"; path: string; target: string; managed: true }
  | { kind: "fenced"; path: string; content: string; version: number; managed: true };

export interface HarnessAdapter {
  id: HarnessId;
  command: string;
  promptFlag: string | null;
  /**
   * How to detect this harness on the host. `executable` is the binary name to
   * probe on PATH — kept here (not in a parallel table) so adding a harness
   * touches only its adapter module.
   */
  detection: { executable: string };
  installActions(home: string, canonicalSkillPath: string): InstallAction[];
  /**
   * Argv fragment (goes between {@link command} and the quoted session id)
   * that resumes a specific prior session by id, or `null` when this harness
   * has no known by-id resume flag (interrupt/resume, issue #78).
   */
  resumeIdArgs: string[] | null;
  /**
   * Argv fragment that resumes the most recently active session in the
   * current working directory, or `null` when this harness has no known
   * "resume latest" flag. Used when no harness session id was recorded.
   */
  resumeLatestArgs: string[] | null;
}
