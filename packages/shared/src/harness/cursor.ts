import type { HarnessAdapter } from "./types";

/**
 * Cursor's CLI ships as `cursor-agent`, not `cursor` (that name belongs to the
 * editor's shell command). Flags verified against the installed binary's
 * `--help`: positional prompt, `--resume [chatId]`, `--continue`.
 */
export const cursorAdapter: HarnessAdapter = {
  id: "cursor",
  command: "cursor-agent",
  promptFlag: null,
  detection: { executable: "cursor-agent" },
  resumeIdArgs: ["--resume"],
  resumeLatestArgs: ["--continue"],
  installActions: () => [],
};
