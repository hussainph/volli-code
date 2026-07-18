import type { HarnessAdapter } from "./types";

export const claudeCodeAdapter: HarnessAdapter = {
  id: "claude-code",
  command: "claude",
  promptFlag: null,
  detection: { executable: "claude" },
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
