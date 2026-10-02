/** Canonical Agent Tool Surface names and independent budget/confirmation causes. */
import type { McpToolId } from "./mcp";
import type { VerbToolKey } from "./verb-registry";

/** Which working tree a Session executes in. */
export type WorkLocationKind = "worktree" | "main-checkout";

export const CODING_TOOL_IDS = ["read", "edit", "write", "execute"] as const;
export type CodingToolId = (typeof CODING_TOOL_IDS)[number];

/** Registration order is part of the Cache Prefix; new names append, never reorder. */
export const NON_CODING_TOOL_IDS = [
  "ask_user",
  "web_fetch",
  "web_search",
  "browser_tabs",
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "browser_screenshot",
  "browser_console",
  "browser_acquire",
  "browser_release",
  "todo_write",
  "shell_start",
  "shell_output",
  "shell_kill",
  "browser_find",
  "classify",
  "codemode",
  "request_secret",
] as const;

export type NonCodingToolId = (typeof NON_CODING_TOOL_IDS)[number];

export const CAPABILITY_TOOL_IDS = [...CODING_TOOL_IDS, ...NON_CODING_TOOL_IDS] as const;

export type SessionToolId = CodingToolId | NonCodingToolId | VerbToolKey | McpToolId;

/** Allowances a person may extend, independent of per-call review. */
export const BUDGET_CAUSE_IDS = ["budget.delegation-children"] as const;
export type BudgetCauseId = (typeof BUDGET_CAUSE_IDS)[number];
export function isBudgetCause(cause: string): cause is BudgetCauseId {
  return (BUDGET_CAUSE_IDS as readonly string[]).includes(cause);
}

/** Existing operations that ask before acting. */
export const CONFIRM_CAUSE_IDS = [
  "confirm.mcp-install",
  "confirm.mcp-remove",
  "confirm.mcp-sign-in",
  "confirm.mcp-credential",
] as const;
export type ConfirmCauseId = (typeof CONFIRM_CAUSE_IDS)[number];
export function isConfirmCause(cause: string): cause is ConfirmCauseId {
  return (CONFIRM_CAUSE_IDS as readonly string[]).includes(cause);
}
export function isCredentialConfirmCause(
  cause: string,
): cause is "confirm.mcp-sign-in" | "confirm.mcp-credential" {
  return cause === "confirm.mcp-sign-in" || cause === "confirm.mcp-credential";
}
