import { describe, expect, it, vi } from "vite-plus/test";
import {
  mcpProviderToolName,
  type AgentRuntime,
  type McpToolDefinition,
  type RuntimeAttachmentHandle,
  type SessionRuntimeSpec,
} from "@volli/shared";
import {
  createPiNativeAdapter,
  type AttachmentMcpPort,
  type PiAdapterOptions,
  type PiRuntimeContext,
} from "./pi-adapter";

const model = { providerId: "fixture", modelId: "fixture", reasoningLevel: "off" } as const;
const tool = (name: string): McpToolDefinition => ({
  serverId: "fixture",
  toolName: name,
  providerName: mcpProviderToolName("fixture", "Fixture", name),
  description: name,
  inputSchema: { type: "object" },
});
const first = tool("first");
const second = tool("second");
function context(tools: readonly McpToolDefinition[] = [first]): PiRuntimeContext {
  return {
    role: "project",
    projectId: "project",
    ticketId: null,
    rootThreadId: "thread",
    brief: "Fixture",
    model,
    toolSurface: ["read", ...tools.map((entry) => entry.providerName)],
    mcpTools: tools,
    promptResources: [],
  };
}
const request = { trigger: "cold-turn", model } as const;

async function fixture(overrides: Partial<PiAdapterOptions> = {}) {
  let runtimeSpec: SessionRuntimeSpec | undefined;
  const close = vi.fn(async () => undefined);
  const handle: RuntimeAttachmentHandle = {
    submitUserMessage: async () => ({ kind: "delivered", delivery: "prompt" }),
    selectModel: async () => ({ kind: "selected" }),
    retry: async () => ({ kind: "delivered", delivery: "retry" }),
    compact: async () => ({ kind: "compacted" }),
    interrupt: async () => undefined,
    reconcile: async (cursor) => ({ cursor, observations: [] }),
    close,
    recovery: undefined,
  };
  const runtime: AgentRuntime = {
    inspectModelAccess: async () => ({ observedAt: 0, providers: [], models: [] }),
    completeUtility: async () => ({ text: "", usage: null }),
    startSession: async (spec) => {
      runtimeSpec = spec;
      return handle;
    },
  };
  const ports: AttachmentMcpPort[] = [];
  const resolver = vi.fn(() => {
    const port = {
      call: vi.fn(async () => ({ content: [], isError: false })),
      dispose: vi.fn(async () => undefined),
    };
    ports.push(port);
    return port;
  });
  const callback = vi.fn(async () => context([first, second]));
  const adapter = createPiNativeAdapter({
    sessionDataDir: "/unused",
    createRuntime: () => runtime,
    resolveRuntimeContext: async () => context(),
    refreshRuntimeContext: callback,
    resolveMcpPort: resolver,
    readWorkspaceEnvironment: () => ({ dependencies: null, installCommand: null }),
    ...overrides,
  });
  const binding = await adapter.attach(
    {
      sessionId: "session",
      attachmentId: "attachment",
      directory: "/fixture",
      continuity: "fresh",
      native: null,
    },
    { emit: async () => undefined },
  );
  if (runtimeSpec === undefined) throw new Error("Missing spec");
  return { binding, spec: runtimeSpec, close, ports, resolver, callback };
}

describe("Pi adapter refresh lifecycle", () => {
  it("returns the identical cached desired spec for runtime announcement/build retries without rebinding", async () => {
    const desired = context([first, second]);
    const h = await fixture({ refreshRuntimeContext: async () => desired });
    const firstSpec = await h.spec.refreshTools!(request);
    const resolutions = h.resolver.mock.calls.length;
    expect(await h.spec.refreshTools!({ ...request, trigger: "code-mode" })).toBe(firstSpec);
    expect(h.resolver).toHaveBeenCalledTimes(resolutions);
    await h.binding.release("requested");
  });
  it.each(["resume", "throw"])(
    "drains a suspended host callback on release (%s), without adopting its late MCP tool",
    async (outcome) => {
      const entered = Promise.withResolvers<void>();
      const resumed = Promise.withResolvers<void>();
      const callback = vi.fn(async () => {
        entered.resolve();
        await resumed.promise;
        if (outcome === "throw") throw new Error("callback failed");
        return context([first, second]);
      });
      const releasedContext = vi.fn();
      const h = await fixture({
        refreshRuntimeContext: callback,
        releaseRuntimeContext: releasedContext,
      });
      const refreshing = h.spec.refreshTools!(request);
      // Attach the rejection observer before releasing the callback.
      const result = refreshing.then(
        (value) => value,
        (error: unknown) => error,
      );
      await entered.promise;
      const queued = h.spec.refreshTools!(request);
      let released = false;
      const releasing = h.binding.release("requested").then(() => {
        released = true;
      });
      await expect(h.spec.refreshTools!(request)).resolves.toBeNull();
      await Promise.resolve();
      expect(released).toBe(false);
      expect(releasedContext).not.toHaveBeenCalled();
      expect(h.ports[0].dispose).not.toHaveBeenCalled();
      expect(h.close).not.toHaveBeenCalled();
      resumed.resolve();
      expect(await result).toEqual(outcome === "throw" ? new Error("callback failed") : null);
      await expect(queued).resolves.toBeNull();
      await releasing;
      await h.binding.release("shutdown");
      await expect(h.spec.refreshTools!(request)).resolves.toBeNull();
      expect(releasedContext).toHaveBeenCalledExactlyOnceWith("session");
      expect(callback).toHaveBeenCalledOnce();
      expect(h.resolver).toHaveBeenCalledOnce();
      expect(h.ports).toHaveLength(1);
      expect(h.ports[0].dispose).toHaveBeenCalledOnce();
      expect(h.close).toHaveBeenCalledOnce();
    },
  );

  it("refuses late MCP adoption after asynchronous binding work resumes", async () => {
    const entered = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    const dispose = vi.fn(async () => {
      entered.resolve();
      await resumed.promise;
    });
    const secretResolver = vi.fn(() => ({
      request: async () => "declined" as const,
      redact: (text: string) => text,
      dispose,
    }));
    const h = await fixture({
      resolveSecretPort: secretResolver,
      refreshRuntimeContext: async () => ({
        ...context([first, second]),
        toolSurface: ["read", "request_secret", first.providerName, second.providerName],
      }),
    });
    const refreshing = h.spec.refreshTools!(request);
    await entered.promise;
    const releasing = h.binding.release("requested");
    await Promise.resolve();
    expect(h.ports[0].dispose).not.toHaveBeenCalled();
    resumed.resolve();
    await expect(refreshing).resolves.toBeNull();
    await releasing;
    expect(secretResolver).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(h.resolver).toHaveBeenCalledOnce();
    expect(h.ports[0].dispose).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledOnce();
  });

  it("does not poison the refresh queue when a host callback throws", async () => {
    const callback = vi.fn(async () => context([first, second]));
    callback.mockRejectedValueOnce(new Error("refresh failed"));
    const h = await fixture({ refreshRuntimeContext: callback });
    await expect(h.spec.refreshTools!(request)).rejects.toThrow("refresh failed");
    await expect(h.spec.refreshTools!(request)).resolves.toMatchObject({
      tools: { mcp: [first, second] },
    });
    await h.binding.release("requested");
    for (const port of h.ports) expect(port.dispose).toHaveBeenCalledOnce();
  });

  it("disposes every adopted port exactly once, even with concurrent release calls", async () => {
    const h = await fixture();
    const next = await h.spec.refreshTools!(request);
    expect(next?.tools.mcp).toEqual([first, second]);
    expect(h.ports).toHaveLength(2);
    await Promise.all([h.binding.release("requested"), h.binding.release("shutdown")]);
    for (const port of h.ports) expect(port.dispose).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.callback).toHaveBeenCalledOnce();
  });

  it.each(["resolver", "validation"])(
    "cleans a created port when later %s throws, and retains the earlier binding",
    async (failure) => {
      let webReads = 0;
      const h = await fixture({
        refreshRuntimeContext: async () =>
          failure === "validation"
            ? { ...context([first, second]), toolSurface: ["read", first.providerName] }
            : context([first, second]),
        resolveWebPorts: () => {
          if (++webReads > 1 && failure === "resolver") throw new Error("web failed");
          return {};
        },
      });
      await expect(h.spec.refreshTools!(request)).rejects.toThrow();
      expect(h.ports).toHaveLength(2);
      expect(h.ports[1].dispose).toHaveBeenCalledOnce();
      expect(h.ports[0].dispose).not.toHaveBeenCalled();
      await h.spec.mcp!.call(
        { serverId: "fixture", toolName: "first", arguments: {}, toolCallId: "call" },
        new AbortController().signal,
      );
      expect(h.ports[0].call).toHaveBeenCalledOnce();
      expect(h.ports[1].call).not.toHaveBeenCalled();
      await h.binding.release("requested");
      for (const port of h.ports) expect(port.dispose).toHaveBeenCalledOnce();
    },
  );

  it("drains failed-adoption cleanup before release snapshots ports, even when disposal throws", async () => {
    const entered = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    const disposed = [
      vi.fn(async () => undefined),
      vi.fn(async () => {
        entered.resolve();
        await resumed.promise;
        throw new Error("dispose failed");
      }),
    ];
    let resolved = 0;
    const h = await fixture({
      refreshRuntimeContext: async () => ({
        ...context([first, second]),
        toolSurface: ["read", first.providerName],
      }),
      resolveMcpPort: () => ({
        call: async () => ({ content: [], isError: false }),
        dispose: disposed[resolved++],
      }),
    });
    const refreshing = h.spec.refreshTools!(request);
    const result = refreshing.catch((error: unknown) => error);
    await entered.promise;
    const releasing = h.binding.release("requested");
    await Promise.resolve();
    expect(disposed[0]).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    resumed.resolve();
    expect(await result).toBeInstanceOf(AggregateError);
    await releasing;
    for (const dispose of disposed) expect(dispose).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledOnce();
  });

  it("attempts all port cleanup and closes the runtime even if a disposer throws", async () => {
    const disposers = [
      vi.fn(() => {
        throw new Error("sync failure");
      }),
      vi.fn(async () => undefined),
    ];
    let resolved = 0;
    const h = await fixture({
      resolveMcpPort: () => ({
        call: async () => ({ content: [], isError: false }),
        dispose: disposers[resolved++],
      }),
    });
    await h.spec.refreshTools!(request);
    await expect(h.binding.release("requested")).rejects.toThrow("Attachment cleanup failed.");
    await expect(h.binding.release("shutdown")).rejects.toThrow("Attachment cleanup failed.");
    for (const dispose of disposers) expect(dispose).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledOnce();
  });

  it("forwards keyed notices outside both executable and declaration bundles", async () => {
    const declaration = {
      kind: "tool-surface",
      tools: context().toolSurface,
      mcpTools: [first],
    } as const;
    const notices = [{ id: "refresh-event", namespaces: [{ name: "mcp:fixture", count: 1 }] }];
    const h = await fixture({
      resolveRuntimeContext: async () => ({
        ...context([first, second]),
        declarationSurface: declaration,
        toolRefreshAnnouncements: notices,
      }),
    });
    expect(h.spec.toolRefreshAnnouncements).toBe(notices);
    expect(h.spec.tools).toEqual({ tools: ["read"], mcp: [first, second] });
    expect(h.spec.declarationTools).toEqual({ tools: ["read"], mcp: [first] });
    await h.binding.release("requested");
    const historical = await fixture();
    expect(historical.spec).not.toHaveProperty("toolRefreshAnnouncements");
    await historical.binding.release("requested");
  });
});
