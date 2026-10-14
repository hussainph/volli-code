import { assertAdditiveToolRefresh } from "../../../session-engine/src/tool-refresh";
import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_CODE_MODE_LIMITS,
  createToolRefreshDelta,
  type SessionInput,
  type SessionEvent,
  type McpToolDefinition,
} from "@volli/shared";
import {
  additiveToolRefresh,
  effectiveToolSurface,
  declarationToolSurface,
  foldToolRefreshes,
} from "./tool-refresh";

const event = (payload: unknown) => ({ id: "refresh-id", payload }) as SessionEvent;
function refreshFact(current: Surface, next: Surface, trigger: string) {
  return event({
    kind: "session.tools.refreshed",
    trigger,
    added: next.tools.filter((tool) => !current.tools.includes(tool)),
    changed: [],
    delta: createToolRefreshDelta(current, next),
  });
}

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
  it("pins planner/transaction guard agreement for retained MCP definitions and all paid/warm triggers", () => {
    const retained: Surface = {
      ...birth,
      tools: [...birth.tools, mcp.providerName],
      mcpTools: [mcp],
      codeMode: {
        ...birth.codeMode!,
        routes: { ...birth.codeMode!.routes, [mcp.providerName]: "both" },
      },
    };
    for (const trigger of [
      "cold-turn",
      "compaction",
      "model-switch",
      "warm-turn",
      "code-mode",
    ] as const) {
      for (const current of [
        birth,
        retained,
        { kind: "tool-surface", tools: ["read"] } as Surface,
      ]) {
        const result = additiveToolRefresh(
          current,
          { ...candidate, mcpTools: [{ ...mcp, description: "new catalog copy" }] },
          trigger,
        );
        expect(() => assertAdditiveToolRefresh(current, { trigger, ...result })).not.toThrow();
        if (current.mcpTools) expect(result.surface.mcpTools).toEqual([mcp]);
      }
    }
  });
  it("replays durable warm discovery IDs and stops binding after future additions without dropping facts", () => {
    const warm = additiveToolRefresh(birth, candidate, "code-mode");
    const events = [
      event({ kind: "session.tools.refreshed", added: [], delta: {}, trigger: "cold-turn" }),
      event({ kind: "session.input.recorded", input: birth }),
      refreshFact(birth, warm.surface, "code-mode"),
    ];
    expect(foldToolRefreshes(events).announcements).toEqual([
      {
        id: "refresh-id",
        namespaces: [
          { name: "volli", count: 1 },
          { name: "mcp:paper", count: 1 },
        ],
      },
    ]);
    events.push(
      event({ kind: "session.tools.refreshed", trigger: "future-trigger", added: [], delta: {} }),
    );
    expect(declarationToolSurface(events)).toBe(birth);
    events.push(
      event({
        kind: "session.tools.refreshed",
        trigger: "warm-turn",
        added: ["future_tool"],
        delta: { routes: { future_tool: "code" } },
      }),
    );
    events.push(
      event({
        kind: "session.tools.refreshed",
        trigger: "cold-turn",
        added: ["future_tool_two"],
        delta: { routes: { future_tool_two: "code" } },
      }),
    );
    expect(foldToolRefreshes(events)).toMatchObject({
      effective: warm.surface,
      declared: birth,
      future: true,
    });
  });
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
      refreshFact(birth, warm.surface, "warm-turn"),
      event({ kind: "turn.completed" }),
    ];
    expect(declarationToolSurface([])).toBeNull();
    expect(declarationToolSurface(events)).toBe(birth);
    const cold = additiveToolRefresh(warm.surface, warm.surface, "cold-turn", birth);
    expect(cold.added).toEqual([]);
    expect(cold.changed).toEqual(["codemode", "session.delegate"]);
    events.push(refreshFact(warm.surface, cold.surface, "cold-turn"));
    expect(declarationToolSurface(events)).toEqual(cold.surface);
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
        added: ["future_tool"],
        delta: { routes: { future_tool: "both" } },
        trigger: "model-switch",
      }),
    );
    expect(declarationToolSurface(events)).toEqual(cold.surface);
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
        refreshFact(birth, refreshed.surface, "cold-turn"),
      ]),
    ).toEqual(refreshed.surface);
    const future = {
      ...refreshed.surface,
      tools: [...refreshed.surface.tools, "future_builtin_from_next_release"],
      codeMode: {
        ...refreshed.surface.codeMode!,
        routes: {
          ...refreshed.surface.codeMode!.routes,
          future_builtin_from_next_release: "both" as const,
        },
      },
    };
    expect(
      effectiveToolSurface([
        event({ kind: "session.input.recorded", input: birth }),
        refreshFact(birth, refreshed.surface, "cold-turn"),
        refreshFact(refreshed.surface, future as Surface, "cold-turn"),
      ]),
    ).toEqual(refreshed.surface);
  });
});
