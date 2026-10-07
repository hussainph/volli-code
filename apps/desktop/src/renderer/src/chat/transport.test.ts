/**
 * The desktop transport, driven over a stubbed preload bridge — the one chat
 * test that legitimately wants a `window`, because the module under test is
 * the one place the chat core touches it.
 */
import { describe, expect, it, vi } from "vite-plus/test";

import type { ChatSessionTransport } from "@volli/session-presentation";

import { browserChatTransport, chatTransportFor, setRemoteChatTransports } from "./transport";

describe("browserChatTransport", () => {
  it("routes product starts and retries without renderer runtime identity", async () => {
    const procedures: string[] = [];
    const inputs: unknown[] = [];
    vi.stubGlobal("window", {
      api: {
        sessionRpc: {
          request: async (request: { path: string; input: unknown }) => {
            procedures.push(request.path);
            inputs.push(request.input);
            return { ok: true, data: null };
          },
          onEvent: () => () => undefined,
          cancel: () => undefined,
        },
      },
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => undefined,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    });

    const transport = browserChatTransport();

    expect(typeof transport.rpc.session.snapshot.query).toBe("function");
    expect(transport.newCommandId()).not.toBe(transport.newCommandId());
    expect(typeof transport.scheduler.schedule(() => undefined)).toBe("function");
    await transport.createSession({
      operationId: "project-create",
      projectId: "project-1",
      ticketId: null,
      title: "Board chat",
    });
    await transport.createSession({
      operationId: "ticket-create",
      projectId: "project-1",
      ticketId: "ticket-1",
      title: "VC-1",
    });
    // Named skills ride the same two CREATE procedures — slugs only, never
    // bodies: main resolves and records the bytes. Create rather than start
    // because VC-16 made minting the durable Session the optimistic half, and
    // that is the half the record has to be written in.
    await transport.createSession({
      operationId: "project-skill-create",
      projectId: "project-1",
      ticketId: null,
      title: "Board chat",
      skills: ["svg-logo-designer"],
    });
    await transport.createSession({
      operationId: "ticket-skill-create",
      projectId: "project-1",
      ticketId: "ticket-1",
      title: "VC-1",
      skills: ["svg-logo-designer"],
    });
    // A picked model becomes the wire's `modelOverride` — the same parameter
    // `volli session start --model` carries, split into its two halves here
    // (VC-56). The composer states both; nobody else states either.
    await transport.createSession({
      operationId: "ticket-kickoff-create",
      projectId: "project-1",
      ticketId: "ticket-1",
      title: "Work on VC-1",
      model: { providerId: "anthropic", modelId: "sonnet-4.5", reasoningLevel: "high" },
    });
    // A promoted Draft names the id it has carried since `+ Chat` (VC-358);
    // every other create leaves the ledger's own mint alone, which is why the
    // key is absent rather than null above.
    await transport.createSession({
      operationId: "promotion-create",
      projectId: "project-1",
      ticketId: "ticket-1",
      title: null,
      requestedSessionId: "550e8400-e29b-41d4-a716-446655440000",
    });
    // A chat promoted with the default offers its first message to the
    // automatic model choice (VC-432); every other create leaves it off.
    await transport.createSession({
      operationId: "auto-create",
      projectId: "project-1",
      ticketId: null,
      title: null,
      autoSelect: { request: "rename the helper" },
    });
    await transport.attachSession({
      operationId: "project-retry",
      sessionId: "session-1",
    });
    await transport.attachSession({
      operationId: "ticket-retry",
      sessionId: "session-2",
    });
    // One procedure per verb, whatever the Role: the nullable ticketId rides
    // the create input, and the attach carries no Role at all.
    expect(procedures).toEqual([
      "sessions.create",
      "sessions.create",
      "sessions.create",
      "sessions.create",
      "sessions.create",
      "sessions.create",
      "sessions.create",
      "sessions.attach",
      "sessions.attach",
    ]);
    expect(inputs[0]).toMatchObject({ ticketId: null });
    expect(inputs[1]).toMatchObject({ ticketId: "ticket-1" });
    expect(inputs[0]).not.toHaveProperty("skills");
    expect(inputs[1]).not.toHaveProperty("skills");
    expect(inputs[2]).toMatchObject({ skills: ["svg-logo-designer"] });
    expect(inputs[3]).toMatchObject({ skills: ["svg-logo-designer"] });
    expect(inputs[0]).not.toHaveProperty("modelOverride");
    expect(inputs[0]).not.toHaveProperty("autoSelect");
    expect(inputs[6]).toMatchObject({ autoSelect: { request: "rename the helper" } });
    expect(inputs[4]).toMatchObject({
      modelOverride: {
        model: { providerId: "anthropic", modelId: "sonnet-4.5" },
        reasoningLevel: "high",
      },
    });
    // The selection is SPLIT, never forwarded whole: the wire's override names
    // a model and a level, and a `model` key holding a reasoning level too
    // would be a second spelling of the same policy.
    expect(inputs[4]).not.toHaveProperty("model");
    expect(inputs[0]).not.toHaveProperty("requestedSessionId");
    expect(inputs[5]).toMatchObject({
      requestedSessionId: "550e8400-e29b-41d4-a716-446655440000",
    });
    vi.unstubAllGlobals();
  });
});

describe("chatTransportFor (VC-713)", () => {
  it("answers a remote project's registered transport, and IPC for every other", () => {
    vi.stubGlobal("window", {
      api: { sessionRpc: { request: vi.fn(), onEvent: () => () => undefined, cancel: vi.fn() } },
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => undefined,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    });
    const remote = { streamRecovery: "host-link" } as ChatSessionTransport;
    const unregister = setRemoteChatTransports({
      forProject: (projectId) => (projectId === "remote" ? remote : null),
    });
    const stale = setRemoteChatTransports({ forProject: () => null });
    stale();
    // Removing a registration that was replaced leaves the newer one alone.
    expect(chatTransportFor("remote")).not.toBe(remote);
    const again = setRemoteChatTransports({
      forProject: (projectId) => (projectId === "remote" ? remote : null),
    });
    unregister();
    expect(chatTransportFor("remote")).toBe(remote);
    expect(chatTransportFor("local").streamRecovery).toBeUndefined();
    expect(chatTransportFor(null).streamRecovery).toBeUndefined();
    again();
    expect(chatTransportFor("remote")).not.toBe(remote);
    vi.unstubAllGlobals();
  });
});
