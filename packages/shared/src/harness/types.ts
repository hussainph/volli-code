import type { HarnessId } from "../ticket";

export type InstallAction =
  | { kind: "write"; path: string; content: string; managed: true }
  | { kind: "symlink"; path: string; target: string; managed: true }
  | { kind: "fenced"; path: string; content: string; version: number; managed: true };

export interface HarnessAdapter {
  id: HarnessId;
  command: string;
  promptFlag: string | null;
  installActions(home: string, canonicalSkillPath: string): InstallAction[];
}
