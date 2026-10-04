import { describe, expect, it } from "vite-plus/test";
import { resolveAgentToolSurface, type CodeModeBirth, type SessionRole } from "@volli/shared";
import { resolveHostToolSurface } from "./host-capabilities";
import { PI_TOOLS } from "./pi-adapter";
import type { SessionWebPorts } from "../web/ports";

const desktop = { askUser: true, requestSecret: true, browser: true, shells: true };
// The shipped index.ts order, not derived from the new helper being tested.
const desktopInteraction = [
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
  "request_secret",
  "codemode",
] as const;
const web: SessionWebPorts = {
  webFetch: async () => {
    throw new Error("membership only");
  },
  webSearch: async () => {
    throw new Error("membership only");
  },
};
const codeModeBirth: CodeModeBirth = {
  offered: true,
  mode: "both",
  nudge: false,
  largeServers: new Set(),
};

describe("host capabilities at Session birth", () => {
  it.each<SessionRole>(["project", "ticket", "subagent"])(
    "keeps the desktop's %s surface byte-identical, including Role filtering",
    (role) => {
      for (const hasWeb of [false, true]) {
        for (const classify of [false, true]) {
          for (const offered of [false, true]) {
            const interaction = desktopInteraction.filter(
              (tool) =>
                !((tool === "web_fetch" || tool === "web_search") && !hasWeb) &&
                !(tool === "classify" && !classify) &&
                !(tool === "codemode" && !offered),
            );
            expect(
              JSON.stringify(
                resolveHostToolSurface({
                  capabilities: desktop,
                  web: hasWeb ? web : {},
                  role,
                  grants: [],
                  mcpTools: [],
                  classify,
                  codeModeBirth: { ...codeModeBirth, offered },
                }),
              ),
            ).toBe(
              JSON.stringify(
                resolveAgentToolSurface({
                  role,
                  grants: [],
                  mcpTools: [],
                  capabilities: { coding: PI_TOOLS.tools, interaction },
                }),
              ),
            );
          }
        }
      }
    },
  );

  it("does not freeze ports an absent capability cannot bind", () => {
    const tools = resolveHostToolSurface({
      capabilities: { askUser: false, requestSecret: false, browser: false, shells: false },
      web: {},
      role: "subagent",
      grants: [],
      mcpTools: [],
      classify: false,
    });
    expect(tools).toEqual(["read", "edit", "write", "execute"]);
  });

  it("preserves the parent's frozen bound and canonical grants", () => {
    const tools = resolveHostToolSurface({
      capabilities: desktop,
      web: { webFetch: web.webFetch },
      role: "ticket",
      grants: ["session.start"],
      within: ["read", "todo_write", "session.start"],
      mcpTools: [],
      classify: false,
      codeModeBirth: { ...codeModeBirth, offered: false },
    });
    expect(tools).toEqual(["read", "todo_write", "session.start", "session.delegate", "watch"]);
  });

  it("offers shell and browser capabilities independently", () => {
    const tools = resolveHostToolSurface({
      capabilities: { ...desktop, browser: false },
      web: { webSearch: web.webSearch },
      role: "project",
      grants: [],
      mcpTools: [],
      classify: false,
    });
    expect(tools).toContain("shell_start");
    expect(tools).toContain("web_search");
    expect(tools.some((tool) => tool.startsWith("browser_"))).toBe(false);
  });
});
