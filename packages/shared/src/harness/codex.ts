import type { HarnessAdapter } from "./types";

export const codexAdapter: HarnessAdapter = {
  id: "codex",
  command: "codex",
  promptFlag: null,
  installActions: () => [],
};
