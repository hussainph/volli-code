/**
 * Product tool names to Pi's built-in tool names.
 *
 * Volli names the seven coding tools it is willing to load; Pi's spellings stay
 * behind this map so nothing above the runtime dispatches on them.
 */

import type { CodingToolId, RuntimeToolBundle } from "../contracts";

const PI_TOOL_NAME: Record<CodingToolId, string> = {
  read: "read",
  edit: "edit",
  write: "write",
  execute: "bash",
  grep: "grep",
  find: "find",
  list: "ls",
};

/** Explicit Pi allowlist for one bundle, in the order the product declared it. */
export function toPiToolNames(bundle: RuntimeToolBundle): string[] {
  return bundle.tools.map((tool) => PI_TOOL_NAME[tool]);
}
