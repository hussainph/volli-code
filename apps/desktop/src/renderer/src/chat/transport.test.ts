/**
 * The desktop transport, driven over a stubbed preload bridge — the one chat
 * test that legitimately wants a `window`, because the module under test is
 * the one place the chat core touches it.
 */
import { describe, expect, it, vi } from "vite-plus/test";

import { browserChatTransport } from "./transport";

describe("browserChatTransport", () => {
  it("routes product starts and retries without renderer runtime identity", async () => {
    const procedures: string[] = [];
    const inputs: unknown[] = [];
    vi.stubGlobal("window", {
      api: {
        sessionRpc: {
          request: async (request: { procedure: string; input: unknown }) => {
            procedures.push(request.procedure);
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
      title: "Project chat",
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
      title: "Project chat",
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
    vi.unstubAllGlobals();
  });
});
