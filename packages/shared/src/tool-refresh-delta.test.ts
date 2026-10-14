import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_CODE_MODE_LIMITS } from "./code-mode";
import type { SessionInput } from "./session-ledger";
import {
  applyToolRefreshDelta,
  createToolRefreshDelta,
  type SessionToolRefreshDelta,
} from "./tool-refresh-delta";

type Surface = Extract<SessionInput, { kind: "tool-surface" }>;
const birth: Surface = { kind: "tool-surface", tools: ["read", "session.start"] };
const mcp = {
  serverId: "paper",
  toolName: "read",
  providerName: "mcp__paper__read" as const,
  description: "Read",
  inputSchema: { type: "object" },
};
const other = { ...mcp, toolName: "write", providerName: "mcp__paper__write" as const };
const declaration = {
  limits: DEFAULT_CODE_MODE_LIMITS,
  mode: "only" as const,
  nudge: true as const,
  descriptionVersion: 2 as const,
};
const code: Surface = {
  ...birth,
  tools: ["read", "codemode", "session.start"],
  codeMode: {
    routes: { read: "direct", "session.start": "direct" },
    limits: DEFAULT_CODE_MODE_LIMITS,
  },
};
const dynamic: Surface = {
  ...code,
  tools: [...code.tools, mcp.providerName],
  mcpTools: [mcp],
  codeMode: {
    ...code.codeMode!,
    routes: { ...code.codeMode!.routes, [mcp.providerName]: "deferred" },
  },
};

describe("minimal durable tool refresh deltas", () => {
  it("folds first acquisition with every declaration field and retained/new routes", () => {
    const next: Surface = {
      ...birth,
      tools: ["read", "write", "ask_user", "codemode", "session.start", "watch", mcp.providerName],
      askUserQuestions: true,
      refreshDescriptions: true,
      mcpTools: [mcp],
      codeMode: {
        ...declaration,
        routes: {
          read: "direct",
          write: "code",
          ask_user: "direct",
          "session.start": "direct",
          watch: "both",
          [mcp.providerName]: "deferred",
        },
      },
    };
    const delta = createToolRefreshDelta(birth, next);
    expect(delta).toEqual({
      codeMode: declaration,
      routes: next.codeMode!.routes,
      mcpTools: [mcp],
      askUserQuestions: true,
      refreshDescriptions: true,
    });
    expect(
      applyToolRefreshDelta(birth, {
        added: ["write", "ask_user", "codemode", "watch", mcp.providerName],
        delta,
      }),
    ).toEqual(next);
    expect(birth).toEqual({ kind: "tool-surface", tools: ["read", "session.start"] });
    expect(createToolRefreshDelta(next, next)).toEqual({});
  });
  it("retains old schemas/routes and persists only new definitions/routes plus version flips", () => {
    const next: Surface = {
      ...dynamic,
      tools: [
        "read",
        "edit",
        "codemode",
        "session.start",
        "watch",
        mcp.providerName,
        other.providerName,
      ],
      mcpTools: [mcp, other],
      codeMode: {
        ...dynamic.codeMode!,
        descriptionVersion: 2,
        routes: {
          ...dynamic.codeMode!.routes,
          edit: "code",
          watch: "code",
          [other.providerName]: "deferred",
        },
      },
    };
    const delta = createToolRefreshDelta(dynamic, next);
    expect(delta).toEqual({
      mcpTools: [other],
      routes: { edit: "code", watch: "code", [other.providerName]: "deferred" },
      descriptionVersion: 2,
    });
    expect(JSON.stringify(delta)).not.toContain(mcp.providerName);
    const folded = applyToolRefreshDelta(dynamic, {
      added: ["watch", other.providerName, "edit"],
      delta,
    });
    expect(folded).toEqual(next);
    expect(folded.mcpTools![0]).toBe(mcp);
    expect(createToolRefreshDelta(folded, folded)).toEqual({});
  });
  it("folds marker-only and empty declaration republication without repeating schemas", () => {
    const next: Surface = { ...dynamic, refreshDescriptions: true };
    expect(createToolRefreshDelta(dynamic, next)).toEqual({ refreshDescriptions: true });
    expect(
      applyToolRefreshDelta(dynamic, { added: [], delta: { refreshDescriptions: true } }),
    ).toEqual(next);
    expect(applyToolRefreshDelta(next, { added: [], delta: {} })).toEqual(next);
    expect(createToolRefreshDelta(birth, birth)).toEqual({});
    expect(createToolRefreshDelta(code, birth)).toEqual({});
    const withEmpty: Surface = { ...birth, mcpTools: [] };
    expect(applyToolRefreshDelta(withEmpty, { added: [], delta: {} })).toEqual(withEmpty);
    const solo: Surface = { kind: "tool-surface", tools: [] };
    const acquired: Surface = {
      ...solo,
      tools: ["codemode"],
      codeMode: { ...declaration, routes: {} },
    };
    expect(createToolRefreshDelta(solo, acquired)).toEqual({ codeMode: declaration });
    expect(
      applyToolRefreshDelta(solo, { added: ["codemode"], delta: { codeMode: declaration } }),
    ).toEqual(acquired);
  });
  it("keeps unknown future names in both routed and unrouted epochs", () => {
    const unknown = "future_tool";
    expect(applyToolRefreshDelta(birth, { added: [unknown], delta: {} }).tools).toEqual([
      ...birth.tools,
      unknown,
    ]);
    const next = applyToolRefreshDelta(dynamic, {
      added: [unknown],
      delta: { routes: { [unknown]: "deferred" } },
    });
    expect(next.tools).toEqual([...code.tools, unknown, mcp.providerName]);
    expect(next.codeMode!.routes[unknown]).toBe("deferred");
    expect(createToolRefreshDelta(dynamic, next)).toEqual({ routes: { [unknown]: "deferred" } });
  });
  it.each([
    [birth, ["read"], {}],
    [birth, ["edit", "edit"], {}],
    [birth, [mcp.providerName], {}],
    [birth, [], { mcpTools: [mcp] }],
    [birth, [mcp.providerName], { mcpTools: [other] }],
    [birth, [], { askUserQuestions: true }],
    [birth, ["ask_user"], { askUserQuestions: false }],
    [
      { ...birth, tools: ["read", "ask_user"], askUserQuestions: true },
      [],
      { askUserQuestions: true },
    ],
    [birth, [], { refreshDescriptions: false }],
    [{ ...birth, refreshDescriptions: true }, [], { refreshDescriptions: true }],
    [birth, [], { descriptionVersion: 2 }],
    [code, [], { descriptionVersion: 1 }],
    [
      { ...code, codeMode: { ...code.codeMode!, descriptionVersion: 2 } },
      [],
      { descriptionVersion: 2 },
    ],
    [code, [], { codeMode: declaration }],
    [birth, [], { codeMode: declaration }],
    [birth, ["codemode"], { codeMode: { ...declaration, routes: {} } }],
    [birth, ["codemode"], {}],
    [birth, [], { routes: { read: "direct" } }],
    [code, [], { routes: { codemode: "direct" } }],
    [code, [], { routes: { read: "code" } }],
    [code, ["write"], {}],
    [code, ["write"], { routes: { write: "wrong" } }],
    [birth, ["codemode"], { codeMode: declaration, routes: { read: "direct" } }],
    [
      birth,
      ["codemode"],
      {
        codeMode: declaration,
        routes: { read: "direct", "session.start": "direct", extra: "code" },
      },
    ],
  ] as [Surface, string[], SessionToolRefreshDelta][])(
    "rejects malformed folds %#",
    (current, added, delta) => {
      expect(() => applyToolRefreshDelta(current, { added, delta })).toThrow();
    },
  );
});
