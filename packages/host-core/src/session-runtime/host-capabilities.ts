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
  /**
   * Whether this launch runs Automations at all (VC-952). Absent means yes —
   * every local caller — and only a cloud launch passes `false`, so a surface
   * resolved now never names `automation.run`. A Session already frozen with
   * it keeps the record: this resolver is only read at a new birth or as an
   * additive-refresh candidate, never to rewrite one.
   */
  automationsAvailable?: boolean;
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
  const surface = resolveAgentToolSurface({
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
  // Membership only, and after the canonical order is settled: dropping the
  // one verb that spends an Automation leaves the relative order of every
  // remaining tool untouched, and a local launch's surface byte-for-byte as
  // it was. Code Mode derives its routes from this same surface, so it loses
  // the route with the name. A frozen record is never resolved again through
  // here; the additive refresh keeps names it already holds.
  return capabilities.automationsAvailable === false
    ? surface.filter((tool) => tool !== "automation.run")
    : surface;
}
