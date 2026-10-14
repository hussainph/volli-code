import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_CODE_MODE_LIMITS,
  type SessionInput,
  type SessionEvent,
  type McpToolDefinition,
} from "@volli/shared";
import { additiveToolRefresh, effectiveToolSurface, declarationToolSurface } from "./tool-refresh";

const event = (payload: unknown) => ({ payload }) as SessionEvent;

type Surface = Extract<SessionInput, { kind: "tool-surface" }>;
const mcp: McpToolDefinition = {
  serverId: "paper",
  toolName: "lookup",
  providerName: "mcp__paper__lookup__12345678",
  description: "Lookup",
  inputSchema: { type: "object", properties: {} },
};
const birth: Surface = {
  kind: "tool-surface",
  tools: ["read", "ask_user", "codemode", "session.delegate"],
  codeMode: {
    routes: { read: "both", ask_user: "direct", "session.delegate": "both" },
    limits: DEFAULT_CODE_MODE_LIMITS,
  },
};
const candidate: Surface = {
  kind: "tool-surface",
  tools: ["read", "edit", "ask_user", "codemode", "session.delegate", "watch", mcp.providerName],
  askUserQuestions: true,
  mcpTools: [mcp],
  codeMode: {
    descriptionVersion: 2,
    routes: {
      read: "code",
      edit: "both",
      ask_user: "direct",
      "session.delegate": "both",
      watch: "code",
      [mcp.providerName]: "deferred",
    },
    limits: DEFAULT_CODE_MODE_LIMITS,
    mode: "only",
  },
};

describe("additions-only tool refresh", () => {
  it.each(["cold-turn", "compaction", "model-switch"] as const)(
    "adds the current surface on %s without replacing old routes, schemas or spellings",
    (trigger) => {
      const result = additiveToolRefresh(birth, candidate, trigger);
      expect(result.added).toEqual(["edit", "watch", mcp.providerName]);
      expect(result.changed).toEqual(["codemode", "session.delegate"]);
      expect(result.surface.codeMode).toMatchObject({
        descriptionVersion: 2,
        routes: { read: "both", watch: "code" },
      });
      expect(result.surface.askUserQuestions).toBeUndefined();
      expect(result.surface.mcpManagementNames).toBeUndefined();
      expect(result.surface.tools).toEqual([
        "read",
        "edit",
        "ask_user",
        "codemode",
        "session.delegate",
        "watch",
        mcp.providerName,
      ]);
    },
  );

  it.each(["warm-turn", "code-mode"] as const)(
    "adds only code-only names at %s and retains declaration markers",
    (trigger) => {
      const result = additiveToolRefresh(birth, candidate, trigger);
      expect(result.added).toEqual(["watch", mcp.providerName]);
      expect(result.changed).toEqual([]);
      expect(result.surface.codeMode?.descriptionVersion).toBeUndefined();
      expect(result.surface.codeMode?.routes.read).toBe("both");
    },
  );

  it("does not offer Code Mode or a direct MCP tool during a warm turn", () => {
    const direct = {
      ...candidate,
      codeMode: {
        ...candidate.codeMode!,
        routes: {
          ...candidate.codeMode!.routes,
          watch: "direct" as const,
          [mcp.providerName]: "both" as const,
        },
      },
    };
    expect(additiveToolRefresh(birth, direct, "warm-turn").added).toEqual([]);
    expect(
      additiveToolRefresh({ kind: "tool-surface", tools: ["read"] }, candidate, "warm-turn").added,
    ).toEqual([]);
  });

  it("keeps an upstream-removed tool, MCP definition and existing ask form", () => {
    const current = additiveToolRefresh(birth, candidate, "cold-turn").surface;
    const removed = additiveToolRefresh(
      current,
      { kind: "tool-surface", tools: ["read"] },
      "cold-turn",
    );
    expect(removed.surface).toEqual(current);
    expect(removed.added).toEqual([]);
    expect(removed.changed).toEqual([]);
    const changedMcp = {
      ...candidate,
      mcpTools: [
        { ...mcp, description: "New", inputSchema: { type: "object", required: ["new"] } },
      ],
    };
    expect(additiveToolRefresh(current, changedMcp, "cold-turn").surface.mcpTools).toEqual([mcp]);
  });

  it("can add Code Mode and ask_user at a cold boundary, not invent routes", () => {
    const result = additiveToolRefresh(
      { kind: "tool-surface", tools: ["read"] },
      candidate,
      "cold-turn",
    );
    expect(result.surface.askUserQuestions).toBe(true);
    expect(result.surface.codeMode?.descriptionVersion).toBe(2);
    expect(result.surface.codeMode?.routes.read).toBe("direct");
    expect(() =>
      additiveToolRefresh(
        { kind: "tool-surface", tools: ["read"] },
        { kind: "tool-surface", tools: ["read", "codemode"] },
        "cold-turn",
      ),
    ).toThrow("recorded routes");
  });

  it("keeps the declaration epoch behind warm additions and advances it at the next paid boundary", () => {
    const warm = additiveToolRefresh(birth, candidate, "warm-turn");
    const events = [
      event({ kind: "session.input.recorded", input: birth }),
      event({ kind: "session.input.recorded", input: candidate }),
      event({ kind: "session.tools.refreshed", ...warm, trigger: "warm-turn" }),
      event({ kind: "turn.completed" }),
    ];
    expect(declarationToolSurface([])).toBeNull();
    expect(declarationToolSurface(events)).toBe(birth);
    const cold = additiveToolRefresh(warm.surface, warm.surface, "cold-turn", birth);
    expect(cold.added).toEqual([]);
    expect(cold.changed).toEqual(["codemode", "session.delegate"]);
    events.push(event({ kind: "session.tools.refreshed", ...cold, trigger: "cold-turn" }));
    expect(declarationToolSurface(events)).toBe(cold.surface);
    const modernBirth: Surface = {
      ...birth,
      refreshDescriptions: true,
      codeMode: { ...birth.codeMode!, descriptionVersion: 2 },
    };
    const modernWarm = additiveToolRefresh(modernBirth, candidate, "warm-turn");
    const publish = additiveToolRefresh(
      modernWarm.surface,
      modernWarm.surface,
      "compaction",
      modernBirth,
    );
    expect(publish.added).toEqual([]);
    expect(publish.changed).toEqual(["codemode"]);
    events.push(
      event({
        kind: "session.tools.refreshed",
        surface: { ...cold.surface, tools: [...cold.surface.tools, "future_tool"] },
        trigger: "model-switch",
      }),
    );
    expect(declarationToolSurface(events)).toBe(cold.surface);
  });

  it("reads effective refresh facts while retaining the first immutable birth", () => {
    const refreshed = additiveToolRefresh(birth, candidate, "cold-turn");
    expect(effectiveToolSurface([])).toBeNull();
    expect(effectiveToolSurface([event({ kind: "turn.started" })])).toBeNull();
    expect(
      effectiveToolSurface([
        event({ kind: "session.input.recorded", input: birth }),
        event({ kind: "session.input.recorded", input: { kind: "runtime-brief", text: "brief" } }),
        event({ kind: "session.input.recorded", input: candidate }),
      ]),
    ).toBe(birth);
    expect(
      effectiveToolSurface([
        event({ kind: "session.input.recorded", input: birth }),
        event({ kind: "session.tools.refreshed", ...refreshed, trigger: "cold-turn" }),
      ]),
    ).toBe(refreshed.surface);
    const future = {
      ...refreshed.surface,
      tools: [...refreshed.surface.tools, "future_builtin_from_next_release"],
    };
    expect(
      effectiveToolSurface([
        event({ kind: "session.input.recorded", input: birth }),
        event({ kind: "session.tools.refreshed", ...refreshed, trigger: "cold-turn" }),
        event({ kind: "session.tools.refreshed", surface: future, trigger: "cold-turn" }),
      ]),
    ).toBe(refreshed.surface);
  });
});
