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
   * touches only its adapter module (spec decision 13).
   */
  detection: { executable: string };
  installActions(home: string, canonicalSkillPath: string): InstallAction[];
}
