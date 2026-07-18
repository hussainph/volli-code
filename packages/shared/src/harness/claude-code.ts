import type { HarnessAdapter } from "./types";

export const claudeCodeAdapter: HarnessAdapter = {
  id: "claude-code",
  command: "claude",
  promptFlag: null,
  installActions(home, canonicalSkillPath) {
    return [
      {
        kind: "symlink",
        path: `${home}/.claude/skills/volli`,
        target: canonicalSkillPath,
        managed: true,
      },
    ];
  },
};
