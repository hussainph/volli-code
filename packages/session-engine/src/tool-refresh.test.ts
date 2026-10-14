import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_CODE_MODE_LIMITS,
  createToolRefreshDelta,
  decodeSessionEventPayload,
  type SessionEvent,
  type SessionInput,
} from "@volli/shared";
import { createSessionEngine, SessionEngineNotFoundError } from "./session-engine";
import { createInMemorySessionLedger } from "./in-memory-ledger";
import { assertAdditiveToolRefresh, type ToolRefreshRequest } from "./tool-refresh";

type Surface = Extract<SessionInput, { kind: "tool-surface" }>;
type Refresh = ToolRefreshRequest & { kind: "session.tools.refreshed" };
function fact(
  current: Surface,
  update: Refresh,
): Extract<SessionEvent["payload"], { kind: "session.tools.refreshed" }> {
  const { surface, ...notice } = update;
  return { ...notice, delta: createToolRefreshDelta(current, surface) };
}
const provenance = { source: { kind: "system" as const, id: "host", detail: null }, venue: null };
const birth: Surface = { kind: "tool-surface", tools: ["read"] };
const code: Surface = {
  kind: "tool-surface",
  tools: ["read", "codemode"],
  codeMode: { routes: { read: "both" }, limits: DEFAULT_CODE_MODE_LIMITS },
};
const mcp = {
  serverId: "server",
  toolName: "read",
  providerName: "mcp__server__read" as const,
  description: "Read",
  inputSchema: { type: "object" },
};
const dynamic: Surface = { kind: "tool-surface", tools: [mcp.providerName], mcpTools: [mcp] };
function refresh(
  surface: Surface,
  added: readonly string[] = [],
  changed: readonly string[] = [],
  trigger: Refresh["trigger"] = "cold-turn",
): Refresh {
  return { kind: "session.tools.refreshed", surface, added, changed, trigger };
}
async function fixture(input?: Surface) {
  let n = 0;
  const ledger = createInMemorySessionLedger();
  const engine = createSessionEngine({
    ledger,
    clock: { now: () => ++n },
    ids: { next: (kind) => `${kind}-${++n}` },
  });
  const { session } = await engine.createSession({
    commandId: "create",
    projectId: "project",
    ticketId: null,
    parentSessionId: null,
    role: "project",
    title: null,
    provenance,
  });
  if (input) await engine.getOrRecordSessionInput({ sessionId: session.id, input, provenance });
  const record = (payload: Refresh) =>
    engine.recordToolRefresh({ sessionId: session.id, provenance, ...payload });
  return { engine, ledger, session, record };
}

describe("durable effective tool refresh", () => {
  it("transactionally dedupes concurrent refreshes against the latest fact and keeps birth immutable", async () => {
    const { engine, session, record } = await fixture(birth);
    expect(await engine.getBaseSession({ sessionId: session.id })).toEqual(session);
    expect(await engine.getBaseSession({ sessionId: "missing" })).toBeNull();
    const payload = refresh({ kind: "tool-surface", tools: ["read", "write"] }, ["write"]);
    const results = await Promise.all([record(payload), record(payload)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results[1]).toBeNull();
    expect(await record(refresh(payload.surface))).toBeNull();
    const latest = await record(
      refresh(
        { kind: "tool-surface", tools: ["read", "edit", "write"] },
        ["edit"],
        [],
        "compaction",
      ),
    );
    expect(latest?.payload).toMatchObject({
      kind: "session.tools.refreshed",
      added: ["edit"],
      trigger: "compaction",
    });
    const events = await engine.listEvents({ sessionId: session.id });
    expect(events.filter((event) => event.payload.kind === "session.input.recorded")).toHaveLength(
      1,
    );
    expect(
      await engine.getOrRecordSessionInput({
        sessionId: session.id,
        input: payload.surface,
        provenance,
      }),
    ).toEqual(birth);
    for (const event of events)
      expect(
        decodeSessionEventPayload(JSON.parse(JSON.stringify(event.payload)), "payload"),
      ).toEqual(event.payload);
    expect((await engine.getSession({ sessionId: session.id }))?.lastActivityAt).not.toBe(
      latest?.occurredAt,
    );
    await expect(
      record(refresh({ kind: "tool-surface", tools: ["read", "edit"] }, ["edit"])),
    ).rejects.toThrow("preserve");
    expect(await engine.listEvents({ sessionId: session.id })).toEqual(events);
  });
  it("rejects a missing Session or birth surface", async () => {
    const { engine, ledger, session, record } = await fixture();
    await expect(record(refresh(birth))).rejects.toThrow("birth surface");
    await ledger.transaction((transaction) =>
      transaction.appendEvent({
        id: "orphan-refresh",
        sessionId: session.id,
        sequence: transaction.latestEventSequence(session.id) + 1,
        occurredAt: 50,
        recordedAt: 50,
        provenance,
        payload: fact(birth, refresh(birth, [], [], "warm-turn")),
      }),
    );
    await expect(record(refresh(birth))).rejects.toThrow("birth surface");
    await expect(
      engine.recordToolRefresh({ sessionId: "missing", provenance, ...refresh(birth) }),
    ).rejects.toBeInstanceOf(SessionEngineNotFoundError);
  });
  it("permits Code Mode deferred additions at a warm boundary without modifying the declaration", async () => {
    const { record, ledger, session } = await fixture(code);
    const surface: Surface = {
      ...code,
      tools: ["read", "write", "codemode"],
      codeMode: { ...code.codeMode!, routes: { read: "both", write: "deferred" } },
    };
    expect((await record(refresh(surface, ["write"], [], "warm-turn")))?.payload).toEqual(
      fact(code, refresh(surface, ["write"], [], "warm-turn")),
    );
    // Unknown future triggers remain facts, not proof of declaration publication.
    await ledger.transaction((transaction) =>
      transaction.appendEvent({
        id: "future-trigger",
        sessionId: session.id,
        sequence: transaction.latestEventSequence(session.id) + 1,
        occurredAt: 50,
        recordedAt: 50,
        provenance,
        payload: fact(surface, refresh(surface, [], [], "future-trigger" as Refresh["trigger"])),
      }),
    );
    // The next cold boundary republishes a description with the new count,
    // even though no executable capability is new at that point.
    expect(
      await record(refresh(surface, [], ["codemode"], "future-trigger" as Refresh["trigger"])),
    ).toBeNull();
    const cold = refresh(surface, [], ["codemode"]);
    expect((await record(cold))?.payload).toEqual(fact(surface, cold));
    expect(await record(cold)).toBeNull();
  });
  it("persists only new MCP schemas, new routes and marker flips across multiple epochs", async () => {
    const { record, engine, session } = await fixture(dynamic);
    const added = { ...mcp, toolName: "write", providerName: "mcp__server__write" as const };
    const first: Surface = {
      ...dynamic,
      tools: [mcp.providerName, added.providerName],
      mcpTools: [mcp, added],
    };
    const event = await record(refresh(first, [added.providerName]));
    expect(event?.payload).toEqual({
      kind: "session.tools.refreshed",
      trigger: "cold-turn",
      added: [added.providerName],
      changed: [],
      delta: { mcpTools: [added] },
    });
    expect(JSON.stringify(event?.payload)).not.toContain(mcp.providerName);
    const marked = { ...first, refreshDescriptions: true as const };
    expect((await record(refresh(marked)))?.payload).toMatchObject({
      delta: { refreshDescriptions: true },
    });
    expect(await record(refresh(marked))).toBeNull();
    const events = await engine.listEvents({ sessionId: session.id });
    expect(events.filter((row) => row.payload.kind === "session.tools.refreshed")).toHaveLength(2);
  });
  it("folds first Code Mode acquisition and upgrades without persisting retained routes or limits", async () => {
    const { record } = await fixture(birth);
    const acquired: Surface = {
      ...code,
      codeMode: { ...code.codeMode!, routes: { read: "direct" }, mode: "only", nudge: true },
    };
    expect((await record(refresh(acquired, ["codemode"])))?.payload).toMatchObject({
      delta: {
        codeMode: { limits: DEFAULT_CODE_MODE_LIMITS, mode: "only", nudge: true },
        routes: { read: "direct" },
      },
    });
    const versioned: Surface = {
      ...acquired,
      codeMode: { ...acquired.codeMode!, descriptionVersion: 2 },
    };
    expect((await record(refresh(versioned, [], ["codemode"])))?.payload).toMatchObject({
      delta: { descriptionVersion: 2 },
    });
    expect(await record(refresh(versioned))).toBeNull();
  });
  it("rejects noncanonical full surfaces or unrepresented extras instead of silently dropping edits", async () => {
    const { record } = await fixture(birth);
    await expect(
      record(refresh({ ...birth, tools: ["write", "read"] }, ["write"])),
    ).rejects.toThrow("canonical surface");
    await expect(
      record(refresh({ ...birth, tools: ["read", "write"], mcpTools: [mcp] }, ["write"])),
    ).rejects.toThrow("delta");
  });
  it("adds questions only for a new tool, permits Code Mode images and rejects MCP description edits", () => {
    expect(() =>
      assertAdditiveToolRefresh(
        { ...birth, tools: ["ask_user"] },
        refresh({ ...birth, tools: ["ask_user"], askUserQuestions: true }, [], ["ask_user"]),
      ),
    ).toThrow("preserve");
    assertAdditiveToolRefresh(
      birth,
      refresh({ ...birth, tools: ["read", "ask_user"], askUserQuestions: true }, ["ask_user"]),
    );
    assertAdditiveToolRefresh(
      code,
      refresh(
        { ...code, codeMode: { ...code.codeMode!, descriptionVersion: 2 } },
        [],
        ["codemode"],
        "model-switch",
      ),
    );
    expect(() =>
      assertAdditiveToolRefresh(
        dynamic,
        refresh(
          { ...dynamic, mcpTools: [{ ...mcp, description: "Read safely" }] },
          [],
          [mcp.providerName],
        ),
      ),
    ).toThrow("preserve");
    assertAdditiveToolRefresh(
      birth,
      refresh(
        {
          ...birth,
          tools: ["read", "codemode"],
          codeMode: { routes: { read: "direct" }, limits: DEFAULT_CODE_MODE_LIMITS },
        },
        ["codemode"],
      ),
    );
    assertAdditiveToolRefresh(code, refresh(code));
    assertAdditiveToolRefresh(dynamic, refresh(dynamic));
  });
  it("permits versioned copy only at cold boundaries with each changed existing name recorded", () => {
    const old: Surface = { kind: "tool-surface", tools: ["session.delegate"] };
    const modern: Surface = { ...old, refreshDescriptions: true };
    assertAdditiveToolRefresh(old, refresh(modern, [], ["session.delegate"]));
    assertAdditiveToolRefresh(modern, refresh(modern));
    expect(() =>
      assertAdditiveToolRefresh(old, refresh(modern, [], ["session.delegate"], "warm-turn")),
    ).toThrow("preserve");
    expect(() => assertAdditiveToolRefresh(modern, refresh(old))).toThrow("preserve");
    expect(() =>
      assertAdditiveToolRefresh(
        old,
        refresh({ ...old, refreshDescriptions: false } as unknown as Surface),
      ),
    ).toThrow("preserve");
    assertAdditiveToolRefresh(birth, refresh({ ...birth, refreshDescriptions: true }));
  });
  it.each([
    [
      birth,
      refresh({ ...birth, tools: ["read", "future_builtin"] } as unknown as Surface, [
        "future_builtin",
      ]),
    ],
    [birth, refresh({ ...birth, tools: ["write"] }, ["write"])],
    [birth, refresh({ ...birth, tools: ["read", "read"] })],
    [birth, refresh({ ...birth, tools: ["read", "write"] })],
    [birth, refresh({ ...birth, mcpManagementNames: "server" })],
    [code, refresh({ ...code, codeMode: { ...code.codeMode!, routes: { read: "code" } } })],
    [
      code,
      refresh(
        {
          ...code,
          tools: [...code.tools, "write"],
          codeMode: { ...code.codeMode!, routes: { read: "both", write: "both" } },
        },
        ["write"],
        [],
        "code-mode",
      ),
    ],
    [birth, refresh({ ...birth, askUserQuestions: true })],
    [
      { ...birth, tools: ["ask_user"], askUserQuestions: true },
      refresh({ ...birth, tools: ["ask_user"] }),
    ],
    [
      { ...birth, tools: ["ask_user"] },
      refresh(
        { ...birth, tools: ["ask_user"], askUserQuestions: true },
        [],
        ["ask_user"],
        "warm-turn",
      ),
    ],
    [dynamic, refresh({ ...dynamic, mcpTools: undefined })],
    [dynamic, refresh({ ...dynamic, mcpTools: [{ ...mcp, toolName: "renamed" }] })],
    [
      dynamic,
      refresh({
        ...dynamic,
        mcpTools: [{ ...mcp, inputSchema: { type: "object", required: ["new"] } }],
      }),
    ],
    [
      dynamic,
      refresh(
        { ...dynamic, mcpTools: [{ ...mcp, description: "Updated" }] },
        [],
        [mcp.providerName],
        "warm-turn",
      ),
    ],
    [code, refresh({ ...code, codeMode: undefined })],
    [
      { ...code, codeMode: { ...code.codeMode!, routes: { read: "direct" } } },
      refresh({ ...code, codeMode: undefined }),
    ],
    [
      code,
      refresh(
        { ...code, codeMode: { ...code.codeMode!, descriptionVersion: 2 } },
        [],
        ["codemode"],
        "warm-turn",
      ),
    ],
    [{ ...code, codeMode: { ...code.codeMode!, descriptionVersion: 2 } }, refresh(code)],
    [
      code,
      refresh(
        {
          ...code,
          codeMode: {
            ...code.codeMode!,
            limits: { ...DEFAULT_CODE_MODE_LIMITS, maxNestedCalls: 1 },
          },
        },
        [],
        ["codemode"],
      ),
    ],
    [{ ...birth, tools: ["read", "codemode"] }, refresh(code)],
    [
      { ...birth, tools: ["read", "codemode"] },
      refresh({ ...code, codeMode: { ...code.codeMode!, routes: { read: "direct" } } }),
    ],
    [birth, refresh(birth, [], ["nonexistent"])],
    [code, refresh(code, [], ["codemode"])],
  ] satisfies [Surface, Refresh][])(
    "rejects destructive or unproven changes %#",
    (current, update) => {
      expect(() => assertAdditiveToolRefresh(current, update)).toThrow("preserve");
    },
  );
});
