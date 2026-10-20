/** Birth membership, derived from the same capabilities attachment assembly binds. */
import {
  resolveAgentToolSurface,
  type CodeModeBirth,
  type McpToolDefinition,
  type SessionRole,
  type SessionToolId,
} from "@volli/shared";
import { PI_TOOLS } from "./pi-adapter";
import type { SessionWebPorts } from "../web/ports";

export interface HostToolCapabilities {
  askUser: boolean;
  requestSecret: boolean;
  browser: boolean;
  shells: boolean;
}

/**
 * Membership, not order. The caller lists which ports exist, in whatever order
 * it pleases; the shared resolver emits them in `NON_CODING_TOOL_IDS` order —
 * the canonical bytes the Cache Prefix is taken over — so membership is what
 * survives this call, never the passed order.
 */
export function resolveHostToolSurface(input: {
  capabilities: HostToolCapabilities;
  web: SessionWebPorts;
  role: SessionRole;
  grants: readonly string[];
  within?: readonly SessionToolId[];
  mcpTools: readonly McpToolDefinition[];
  codeModeBirth?: CodeModeBirth;
  classify: boolean;
}): readonly SessionToolId[] {
  const { capabilities, web, role, grants, within, mcpTools, codeModeBirth, classify } = input;
  return resolveAgentToolSurface({
    role,
    ...(within === undefined ? {} : { within }),
    capabilities: {
      coding: PI_TOOLS.tools,
      interaction: [
        ...(capabilities.askUser ? (["ask_user"] as const) : []),
        ...(web.webFetch === undefined ? [] : (["web_fetch"] as const)),
        ...(web.webSearch === undefined ? [] : (["web_search"] as const)),
        ...(capabilities.browser
          ? ([
              "browser_tabs",
              "browser_navigate",
              "browser_snapshot",
              "browser_act",
              "browser_screenshot",
              "browser_console",
              "browser_acquire",
              "browser_release",
            ] as const)
          : []),
        "todo_write",
        ...(capabilities.shells ? (["shell_start", "shell_output", "shell_kill"] as const) : []),
        ...(capabilities.browser ? (["browser_find"] as const) : []),
        ...(classify ? (["classify"] as const) : []),
        ...(capabilities.requestSecret ? (["request_secret"] as const) : []),
        ...(codeModeBirth?.offered === true ? (["codemode"] as const) : []),
      ],
    },
    grants,
    mcpTools,
  });
}
