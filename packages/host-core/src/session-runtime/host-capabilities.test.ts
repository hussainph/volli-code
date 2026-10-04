import { describe, expect, it } from "vite-plus/test";
import type { CodeModeBirth, SessionRole, SessionToolId } from "@volli/shared";
import { resolveHostToolSurface } from "./host-capabilities";
import { MAIN_SURFACE_BASELINE } from "./fixtures/main-surface-baseline";
import type { SessionWebPorts } from "../web/ports";

const desktop = { askUser: true, requestSecret: true, browser: true, shells: true };
// Membership only: the resolver reads which ports exist, never calls them.
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

// The a1 verifier's exact combination matrix, in its enumeration order
// (fixtures/main-surface-baseline.ts records one entry per combination). The
// default-argument call shape the backfill path uses — `resolve(role, [])` —
// is the (grants=[], within=undefined, mcpTools=[], birth=undefined,
// classify=false) entry of this matrix.
const roles: SessionRole[] = ["project", "ticket", "subagent"];
const grantsFor = (role: SessionRole): readonly (readonly string[])[] =>
  role === "subagent" ? [[]] : [[], ["session.start"], ["ticket.create", "session.start"]];
const withins: readonly (undefined | readonly SessionToolId[])[] = [
  undefined,
  ["read", "todo_write", "session.start", "browser_tabs", "codemode", "shell_start", "web_fetch"],
];
// Deliberately not a valid definition: the frozen baseline records what the
// resolver refuses, so the malformed shape is part of the matrix.
const mcp = [
  { server: "srv", name: "lookup", description: "d", inputSchema: { type: "object" } },
] as never;
const births: readonly (CodeModeBirth | undefined)[] = [
  undefined,
  { ...codeModeBirth, offered: false },
  codeModeBirth,
];

interface Combo {
  hasWeb: boolean;
  role: SessionRole;
  grants: readonly string[];
  within: undefined | readonly SessionToolId[];
  withMcp: boolean;
  birth: CodeModeBirth | undefined;
  classify: boolean;
}
const combos: Combo[] = [];
for (const hasWeb of [false, true]) {
  for (const role of roles) {
    for (const grants of grantsFor(role)) {
      for (const within of withins) {
        for (const withMcp of [false, true]) {
          for (const birth of births) {
            for (const classify of [false, true]) {
              combos.push({ hasWeb, role, grants, within, withMcp, birth, classify });
            }
          }
        }
      }
    }
  }
}

describe("host capabilities at Session birth", () => {
  it.each<SessionRole>(roles)(
    "freezes main's shipped %s surface across every verified birth combination",
    (role) => {
      expect(combos).toHaveLength(MAIN_SURFACE_BASELINE.table.length);
      combos.forEach((combo, index) => {
        if (combo.role !== role) return;
        let actual: string;
        try {
          actual = JSON.stringify(
            resolveHostToolSurface({
              capabilities: desktop,
              web: combo.hasWeb ? web : {},
              role: combo.role,
              grants: combo.grants,
              ...(combo.within === undefined ? {} : { within: combo.within }),
              mcpTools: combo.withMcp ? mcp : [],
              classify: combo.classify,
              ...(combo.birth === undefined ? {} : { codeModeBirth: combo.birth }),
            }),
          );
        } catch (error) {
          actual = `THROW:${(error as Error).message}`;
        }
        const slot = MAIN_SURFACE_BASELINE.table[index];
        const expected =
          slot < 0
            ? `THROW:${MAIN_SURFACE_BASELINE.errors[-slot - 1]}`
            : JSON.stringify(MAIN_SURFACE_BASELINE.surfaces[slot].split(","));
        expect(actual, JSON.stringify({ index, ...combo })).toBe(expected);
      });
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
