import { VOLLI_OPENCODE_COMMAND } from "./skill-content";
import type { HarnessAdapter } from "./types";

export const opencodeAdapter: HarnessAdapter = {
  id: "opencode",
  command: "opencode",
  promptFlag: "--prompt",
  installActions(home) {
    return [
      {
        kind: "write",
        path: `${home}/.config/opencode/command/volli.md`,
        content: VOLLI_OPENCODE_COMMAND,
        managed: true,
      },
    ];
  },
};
