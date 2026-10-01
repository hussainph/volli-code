import { describe, expect, it, vi } from "vite-plus/test";
import { mcpProviderToolName, type McpServerDraft, type McpToolDefinition } from "@volli/shared";

import { McpCredentialMissingError, McpSignInRequiredError } from "./credentials";
import { McpTransportFailure, type McpProtocolClient } from "./discovery";
import { McpCallBlocked, McpSessionHost, serversForFrozenMcpTools } from "./session-host";

const server: McpServerDraft = {
  id: "server-1",
  name: "Fixture",
  enabled: true,
  transport: { type: "stdio", command: "fixture", args: [] },
};

function client(callTool: McpProtocolClient["callTool"]): McpProtocolClient {
  return { listTools: async () => [], callTool, close: vi.fn(async () => undefined) };
}

describe("McpSessionHost", () => {
  it("binds only servers required by frozen definitions and refuses a missing server before attach", () => {
    const definition: McpToolDefinition = {
      serverId: server.id,
      toolName: "exact/name",
      providerName: mcpProviderToolName(server.id, server.name, "exact/name"),
      description: "Exact",
      inputSchema: { type: "object" },
    };

    expect(serversForFrozenMcpTools([{ ...server, enabled: false }], [definition])).toEqual([
      server,
    ]);
    expect(() => serversForFrozenMcpTools([], [definition])).toThrow(
      /required MCP server.*restore.*retry/i,
    );
  });

  it("opens one lazy client per server, reuses it for exact calls, and closes it with the attachment", async () => {
    const protocol = client(async ({ name, arguments: arguments_ }) => ({
      content: [{ type: "text", text: `${name}:${String(arguments_.value)}` }],
      isError: false,
    }));
    const open = vi.fn(async () => protocol);
    const host = new McpSessionHost({ workspacePath: "/workspace", servers: [server], open });
    const signal = new AbortController().signal;

    await expect(
      host.port.call(
        {
          serverId: "server-1",
          toolName: "exact/name",
          arguments: { value: 1 },
          toolCallId: "one",
        },
        signal,
      ),
    ).resolves.toEqual({ content: [{ type: "text", text: "exact/name:1" }], isError: false });
    await host.port.call(
      { serverId: "server-1", toolName: "exact/name", arguments: { value: 2 }, toolCallId: "two" },
      signal,
    );

    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(server, "/workspace", expect.any(AbortSignal));
    await host.close();
    expect(protocol.close).toHaveBeenCalledOnce();
    await expect(
      host.port.call(
        { serverId: "server-1", toolName: "exact/name", arguments: {}, toolCallId: "three" },
        signal,
      ),
    ).rejects.toThrow("MCP attachment is closed");
  });

  it("converts text, images, resources, structured output, and error status without retaining blobs", async () => {
    const host = new McpSessionHost({
      workspacePath: "/workspace",
      servers: [server],
      open: async () =>
        client(async () => ({
          content: [
            { type: "text", text: "hello" },
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            { type: "resource_link", uri: "docs://guide", name: "Guide" },
            { type: "resource", resource: { uri: "docs://large", blob: "secret-blob" } },
          ],
          structuredContent: { result: true },
          isError: true,
        })),
    });

    const result = await host.port.call(
      { serverId: "server-1", toolName: "mixed", arguments: {}, toolCallId: "one" },
      new AbortController().signal,
    );
    expect(result).toEqual({
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "unsupported", text: "[resource link: Guide — docs://guide]" },
        { type: "unsupported", text: "[embedded resource: docs://large]" },
      ],
      structuredContent: { result: true },
      isError: true,
    });
    expect(JSON.stringify(result)).not.toContain("secret-blob");
  });

  it("rejects disabled or unknown servers and oversize results using safe errors", async () => {
    const huge = "x".repeat(300_000);
    const open = vi.fn(async () =>
      client(async () => ({ content: [{ type: "text", text: huge }] })),
    );
    const host = new McpSessionHost({
      workspacePath: "/workspace",
      servers: [server, { ...server, id: "disabled", enabled: false }],
      open,
    });

    for (const serverId of ["missing", "disabled"]) {
      await expect(
        host.port.call(
          { serverId, toolName: "one", arguments: {}, toolCallId: "one" },
          new AbortController().signal,
        ),
      ).rejects.toThrow("MCP server is unavailable for this Session");
    }
    await expect(
      host.port.call(
        { serverId: "server-1", toolName: "large", arguments: {}, toolCallId: "one" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("MCP result exceeded the safe size limit");
  });

  it("turns protocol failures into a safe failed result naming only the configured server", async () => {
    const protocol = client(async () => Promise.reject(new Error("token=secret")));
    const open = vi.fn(async () => protocol);
    const host = new McpSessionHost({ workspacePath: "/workspace", servers: [server], open });

    const result = await host.port.call(
      { serverId: server.id, toolName: "one", arguments: {}, toolCallId: "one" },
      new AbortController().signal,
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "MCP server Fixture call failed." }],
      isError: true,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    // The server answered; the connection is fine and stays shared.
    expect(protocol.close).not.toHaveBeenCalled();
    await host.port.call(
      { serverId: server.id, toolName: "one", arguments: {}, toolCallId: "two" },
      new AbortController().signal,
    );
    expect(open).toHaveBeenCalledOnce();
  });

  it("retires and closes a client whose call fails in the transport", async () => {
    const broken = client(async () => Promise.reject(new McpTransportFailure()));
    const healthy = client(async () => ({ content: [{ type: "text", text: "fresh" }] }));
    const clients = [broken, healthy];
    const open = vi.fn(async () => clients.shift()!);
    const host = new McpSessionHost({ workspacePath: "/workspace", servers: [server], open });

    await expect(
      host.port.call(
        { serverId: server.id, toolName: "one", arguments: {}, toolCallId: "one" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      content: [{ type: "text", text: "MCP server Fixture call failed." }],
      isError: true,
    });
    expect(broken.close).toHaveBeenCalledOnce();
    await expect(
      host.port.call(
        { serverId: server.id, toolName: "one", arguments: {}, toolCallId: "two" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ content: [{ type: "text", text: "fresh" }], isError: false });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("aborts an in-flight call when its attachment closes", async () => {
    const seen: AbortSignal[] = [];
    const protocol = client(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          seen.push(signal);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const host = new McpSessionHost({
      workspacePath: "/workspace",
      servers: [server],
      open: async () => protocol,
    });
    const invocation = host.port.call(
      { serverId: "server-1", toolName: "one", arguments: {}, toolCallId: "one" },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    await host.close();

    expect(seen[0]?.aborted).toBe(true);
    await expect(invocation).rejects.toThrow("MCP attachment closed");
  });

  it("keeps a client across a call's own abort and reuses it for the next call", async () => {
    const seen: AbortSignal[] = [];
    let calls = 0;
    const protocol = client(({ signal }) => {
      calls += 1;
      if (calls > 1) return Promise.resolve({ content: [{ type: "text", text: "reused" }] });
      return new Promise((_resolve, reject) => {
        seen.push(signal);
        // The SDK reports a caller's abort as a request timeout; nothing
        // about it says the connection failed.
        signal.addEventListener("abort", () => reject(new Error("token=secret")), {
          once: true,
        });
      });
    });
    const open = vi.fn(async () => protocol);
    const host = new McpSessionHost({ workspacePath: "/workspace", servers: [server], open });
    const controller = new AbortController();
    const invocation = host.port.call(
      { serverId: "server-1", toolName: "one", arguments: {}, toolCallId: "one" },
      controller.signal,
    );
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    controller.abort(new Error("stopped"));

    await expect(invocation).rejects.toThrow("stopped");
    expect(seen[0]?.aborted).toBe(true);
    expect(protocol.close).not.toHaveBeenCalled();
    await expect(
      host.port.call(
        { serverId: "server-1", toolName: "one", arguments: {}, toolCallId: "two" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ content: [{ type: "text", text: "reused" }], isError: false });
    expect(open).toHaveBeenCalledOnce();
    await host.close();
    expect(protocol.close).toHaveBeenCalledOnce();
  });

  it("lets a sibling call finish when another in-flight call to the same server aborts", async () => {
    const pending = new Map<string, { resolve: () => void; signal: AbortSignal }>();
    const protocol = client(
      ({ name, signal }) =>
        new Promise((resolve, reject) => {
          pending.set(name, {
            resolve: () => resolve({ content: [{ type: "text", text: `${name} done` }] }),
            signal,
          });
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const open = vi.fn(async () => protocol);
    const host = new McpSessionHost({ workspacePath: "/workspace", servers: [server], open });
    const aborted = new AbortController();
    const first = host.port.call(
      { serverId: "server-1", toolName: "first", arguments: {}, toolCallId: "one" },
      aborted.signal,
    );
    const second = host.port.call(
      { serverId: "server-1", toolName: "second", arguments: {}, toolCallId: "two" },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(pending.size).toBe(2));

    aborted.abort(new Error("first withdrawn"));
    await expect(first).rejects.toThrow("first withdrawn");
    expect(pending.get("second")?.signal.aborted).toBe(false);
    pending.get("second")?.resolve();

    await expect(second).resolves.toEqual({
      content: [{ type: "text", text: "second done" }],
      isError: false,
    });
    expect(open).toHaveBeenCalledOnce();
    expect(protocol.close).not.toHaveBeenCalled();
    await host.close();
  });

  it("opens a shared client under the attachment, not under the first caller's signal", async () => {
    let finishOpen!: (value: McpProtocolClient) => void;
    const openSignals: AbortSignal[] = [];
    const open = vi.fn(
      (_server: McpServerDraft, _workspace: string, signal: AbortSignal) =>
        new Promise<McpProtocolClient>((resolve) => {
          openSignals.push(signal);
          finishOpen = resolve;
        }),
    );
    const host = new McpSessionHost({ workspacePath: "/workspace", servers: [server], open });
    const first = new AbortController();
    const firstCall = host.port.call(
      { serverId: "server-1", toolName: "one", arguments: {}, toolCallId: "one" },
      first.signal,
    );
    const secondCall = host.port.call(
      { serverId: "server-1", toolName: "two", arguments: {}, toolCallId: "two" },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());

    first.abort(new Error("first gave up"));
    await expect(firstCall).rejects.toThrow("first gave up");
    expect(openSignals[0]?.aborted).toBe(false);
    const protocol = client(async ({ name }) => ({ content: [{ type: "text", text: name }] }));
    finishOpen(protocol);

    await expect(secondCall).resolves.toEqual({
      content: [{ type: "text", text: "two" }],
      isError: false,
    });
    expect(open).toHaveBeenCalledOnce();
    await host.close();
    expect(openSignals[0]?.aborted).toBe(true);
    expect(protocol.close).toHaveBeenCalledOnce();
  });

  it("retires a client on transport failure only after its last call settles, and only its own entry", async () => {
    const settle = new Map<string, (outcome: "ok" | "transport") => void>();
    const firstClient = client(
      ({ name }) =>
        new Promise((resolve, reject) => {
          settle.set(name, (outcome) =>
            outcome === "ok"
              ? resolve({ content: [{ type: "text", text: `${name} ok` }] })
              : reject(new McpTransportFailure({ cause: new Error("token=secret") })),
          );
        }),
    );
    const secondClient = client(async ({ name }) => ({
      content: [{ type: "text", text: `${name} on second` }],
    }));
    const clients = [firstClient, secondClient];
    const open = vi.fn(async () => clients.shift()!);
    const host = new McpSessionHost({ workspacePath: "/workspace", servers: [server], open });
    const call = (toolName: string) =>
      host.port.call(
        { serverId: "server-1", toolName, arguments: {}, toolCallId: toolName },
        new AbortController().signal,
      );
    const a = call("a");
    const b = call("b");
    const c = call("c");
    await vi.waitFor(() => expect(settle.size).toBe(3));

    // `a` loses the transport: the client stops being handed out, but `b`
    // and `c` are still running on it, so it is not closed under them.
    settle.get("a")?.("transport");
    await expect(a).resolves.toEqual({
      content: [{ type: "text", text: "MCP server Fixture call failed." }],
      isError: true,
    });
    expect(firstClient.close).not.toHaveBeenCalled();
    await expect(call("d")).resolves.toEqual({
      content: [{ type: "text", text: "d on second" }],
      isError: false,
    });
    expect(open).toHaveBeenCalledTimes(2);

    // `b` fails the same way after the replacement is cached: the identity
    // check keeps it from evicting a client it never used.
    settle.get("b")?.("transport");
    await expect(b).resolves.toMatchObject({ isError: true });
    settle.get("c")?.("ok");
    await expect(c).resolves.toEqual({ content: [{ type: "text", text: "c ok" }], isError: false });
    expect(firstClient.close).toHaveBeenCalledOnce();
    await expect(call("e")).resolves.toMatchObject({ isError: false });
    expect(open).toHaveBeenCalledTimes(2);
    expect(secondClient.close).not.toHaveBeenCalled();

    await host.close();
    expect(firstClient.close).toHaveBeenCalledOnce();
    expect(secondClient.close).toHaveBeenCalledOnce();
  });

  it("closes a retired client that is still draining when the attachment closes", async () => {
    let failFirst!: () => void;
    const seen: AbortSignal[] = [];
    const protocol = client(({ name, signal }) => {
      seen.push(signal);
      return new Promise((_resolve, reject) => {
        if (name === "fails") failFirst = () => reject(new McpTransportFailure());
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const host = new McpSessionHost({
      workspacePath: "/workspace",
      servers: [server],
      open: async () => protocol,
    });
    const failing = host.port.call(
      { serverId: "server-1", toolName: "fails", arguments: {}, toolCallId: "one" },
      new AbortController().signal,
    );
    const draining = host.port.call(
      { serverId: "server-1", toolName: "drains", arguments: {}, toolCallId: "two" },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    failFirst();
    await expect(failing).resolves.toMatchObject({ isError: true });
    expect(protocol.close).not.toHaveBeenCalled();

    await host.close();

    await expect(draining).rejects.toThrow("MCP attachment closed");
    expect(protocol.close).toHaveBeenCalledOnce();
  });

  it("closes a connection that finishes opening after the attachment closed", async () => {
    let finishOpen!: (value: McpProtocolClient) => void;
    const host = new McpSessionHost({
      workspacePath: "/workspace",
      servers: [server],
      // An opener that ignores its signal: the late connection must still be
      // closed rather than leaked.
      open: () =>
        new Promise<McpProtocolClient>((resolve) => {
          finishOpen = resolve;
        }),
    });
    const call = host.port.call(
      { serverId: "server-1", toolName: "one", arguments: {}, toolCallId: "one" },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(finishOpen).toBeDefined());

    const closing = host.close();
    await expect(call).rejects.toThrow("MCP attachment closed");
    const late = client(async () => ({ content: [] }));
    finishOpen(late);
    await closing;

    expect(late.close).toHaveBeenCalledOnce();
  });

  it("answers a call whose transport failed without waiting on the goodbye", async () => {
    let finishClose!: () => void;
    const broken: McpProtocolClient = {
      listTools: async () => [],
      callTool: async () => Promise.reject(new McpTransportFailure()),
      close: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishClose = resolve;
          }),
      ),
    };
    const host = new McpSessionHost({
      workspacePath: "/workspace",
      servers: [server],
      open: async () => broken,
    });

    await expect(
      host.port.call(
        { serverId: server.id, toolName: "one", arguments: {}, toolCallId: "one" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true });
    expect(broken.close).toHaveBeenCalledOnce();

    // The attachment's own close waits for the goodbye still in flight.
    let closed = false;
    const closing = host.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finishClose();
    await closing;
    expect(closed).toBe(true);
    expect(broken.close).toHaveBeenCalledOnce();
  });

  it("reports a failed open as a safe result and opens afresh for the next call", async () => {
    const recovered = client(async () => ({ content: [{ type: "text", text: "recovered" }] }));
    const open = vi
      .fn<(server: McpServerDraft) => Promise<McpProtocolClient>>()
      .mockRejectedValueOnce(new Error("spawn failed token=secret"))
      .mockResolvedValueOnce(recovered);
    const host = new McpSessionHost({ workspacePath: "/workspace", servers: [server], open });

    const failed = await host.port.call(
      { serverId: "server-1", toolName: "one", arguments: {}, toolCallId: "one" },
      new AbortController().signal,
    );
    expect(failed).toEqual({
      content: [{ type: "text", text: "MCP server Fixture call failed." }],
      isError: true,
    });
    await expect(
      host.port.call(
        { serverId: "server-1", toolName: "one", arguments: {}, toolCallId: "two" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ content: [{ type: "text", text: "recovered" }], isError: false });
    expect(open).toHaveBeenCalledTimes(2);
    await host.close();
  });
});

describe("McpSessionHost — calls blocked on a person (VC-470)", () => {
  const call = { serverId: "server-1", toolName: "lookup", arguments: {}, toolCallId: "c1" };

  it("throws the block from the raw port, so a bound around it never waits on a person", async () => {
    const host = new McpSessionHost({
      workspacePath: "/workspace",
      servers: [server],
      open: async () =>
        client(async () => {
          throw new McpSignInRequiredError("Fixture", false);
        }),
    });

    const blocked = await host.rawPort
      .call(call, new AbortController().signal)
      .catch((error) => error);
    expect(blocked).toBeInstanceOf(McpCallBlocked);
    expect((blocked as McpCallBlocked).block).toEqual({
      kind: "sign-in",
      insufficientScope: false,
    });
    await host.close();
  });

  it("routes a bound call: asks outside the bound, signs in, and retries through the bound", async () => {
    let signedIn = false;
    const open = vi.fn(async () =>
      client(async () => {
        if (!signedIn) throw new McpSignInRequiredError("Fixture", false);
        return { content: [{ type: "text", text: "lookup ok" }], isError: false };
      }),
    );
    const signIn = vi.fn(async () => {
      signedIn = true;
      return { ok: true as const, message: "Signed in to Fixture." };
    });
    const host = new McpSessionHost({
      workspacePath: "/workspace",
      servers: [server],
      open,
      signIn,
    });
    const held: string[] = [];
    // A stand-in for the per-server budget: records when a slot is held.
    const bound = async (request: typeof call, signal: AbortSignal) => {
      held.push("acquire");
      try {
        return await host.rawPort.call(request, signal);
      } finally {
        held.push("release");
      }
    };
    const ask = vi.fn(async () => {
      held.push("asked");
      return "allow" as const;
    });

    await expect(host.routed(bound).call(call, new AbortController().signal, ask)).resolves.toEqual(
      {
        content: [{ type: "text", text: "lookup ok" }],
        isError: false,
      },
    );
    // The person was asked with no slot held.
    expect(held).toEqual(["acquire", "release", "asked", "acquire", "release"]);
    expect(signIn).toHaveBeenCalledOnce();
    // The connection was kept: a refusal for a sign-in is not a transport failure.
    expect(open).toHaveBeenCalledOnce();
    await host.close();
  });

  it("says so when the sign-in did not complete, without retrying", async () => {
    const host = new McpSessionHost({
      workspacePath: "/workspace",
      servers: [server],
      open: async () =>
        client(async () => {
          throw new McpSignInRequiredError("Fixture", true);
        }),
      signIn: async () => ({
        ok: false,
        cancelled: false,
        message: "Could not sign in to Fixture.",
      }),
    });
    const ask = vi.fn(async () => "allow" as const);

    await expect(host.port.call(call, new AbortController().signal, ask)).resolves.toEqual({
      content: [{ type: "text", text: "Could not sign in to Fixture. lookup was not called." }],
      isError: true,
    });
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: "confirm.mcp-sign-in",
        reason: expect.stringMatching(/more access/),
      }),
      expect.any(AbortSignal),
    );
    await host.close();
  });

  it("reports a question nobody could be shown, and a missing credential asked for and declined", async () => {
    const host = new McpSessionHost({
      workspacePath: "/workspace",
      servers: [server],
      open: async () => {
        throw new McpCredentialMissingError("Fixture", ["env API_KEY"]);
      },
    });

    await expect(
      host.port.call(call, new AbortController().signal, async () => {
        throw new Error("no host");
      }),
    ).resolves.toMatchObject({
      content: [{ text: "Volli could not put this in front of anyone, so lookup was not called." }],
    });
    await expect(
      host.port.call(call, new AbortController().signal, async () => "refuse"),
    ).resolves.toMatchObject({
      content: [
        {
          text: "The person driving declined to add env API_KEY for Fixture, so lookup was not called.",
        },
      ],
    });
    // A sign-in block with no sign-in wired reads as nobody able to ask.
    const noSignIn = new McpSessionHost({
      workspacePath: "/workspace",
      servers: [server],
      open: async () => {
        throw new McpSignInRequiredError("Fixture", false);
      },
    });
    await expect(
      noSignIn.port.call(call, new AbortController().signal, async () => "allow"),
    ).resolves.toMatchObject({ isError: true });
    await Promise.all([host.close(), noSignIn.close()]);
  });

  it("retires an idle client opened before a person replaced a stored value", async () => {
    let revision = 0;
    const clients: McpProtocolClient[] = [];
    const open = vi.fn(async () => {
      const opened = client(async () => ({ content: [], isError: false }));
      clients.push(opened);
      return opened;
    });
    const host = new McpSessionHost({
      workspacePath: "/workspace",
      servers: [server],
      open,
      credentialsRevision: () => revision,
    });

    await host.port.call(call, new AbortController().signal);
    revision = 1;
    await host.port.call(call, new AbortController().signal);

    expect(open).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(clients[0]!.close).toHaveBeenCalledOnce());
    expect(clients[1]!.close).not.toHaveBeenCalled();
    await host.close();
    expect(clients[1]!.close).toHaveBeenCalledOnce();
  });
});
