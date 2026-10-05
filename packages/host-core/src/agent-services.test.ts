import { expect, expectTypeOf, it, vi } from "vite-plus/test";
import type { AgentRequest } from "@volli/shared";
import { createHostAgentServices, createHostAgentSocket } from "./agent-services";
import { HEADLESS_ATTENTION } from "./ports";
import { openTestDb, testProject, testSession } from "./db/test-helpers";
import { insertProject } from "./db/projects-repo";
import { createTestSessionEngine } from "./testing/session-engine";
import { insertSession } from "./session-control/test-support";
import { createSessionTokenRegistry } from "./session-tokens";

it("uses the same event bus and attention delivery for socket commands without a client", async () => {
  const ctx = openTestDb();
  try {
    const project = testProject({ path: "/repo/headless" });
    insertProject(ctx.db, project);
    const session = testSession(project.id, null);
    insertSession(ctx.db, session);
    const tokens = createSessionTokenRegistry();
    const token = tokens.mint({ sessionId: session.id, attachmentId: "attachment" });
    const publish = vi.fn();
    const deliver = vi.fn(HEADLESS_ATTENTION.deliver);
    const services = createHostAgentServices({
      events: { publish },
      attention: { ...HEADLESS_ATTENTION, deliver },
    });
    const commands = services.createCommands({
      busyWorktreeSites: async () => [],
      db: ctx.db,
      sessionEngine: createTestSessionEngine(ctx.db),
      appVersion: "0.2.1",
      verifySessionToken: tokens.verify,
    });
    const context: AgentRequest["ctx"] = {
      cwd: project.path,
      env: { session: session.id, token },
    };
    await expect(
      commands.execute({
        v: 1,
        cmd: "ticket.create",
        args: { title: "Headless ticket" },
        ctx: context,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(publish).toHaveBeenCalledWith("data-changed", {
      projectId: project.id,
      ticketId: expect.any(String),
      kind: "ticket",
    });
    await expect(
      commands.execute({
        v: 1,
        cmd: "notify",
        args: { title: "Agent", message: "Needs input" },
        ctx: context,
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(deliver).toHaveBeenCalledExactlyOnceWith({
      producer: "agent-notify",
      title: "Agent",
      body: "Needs input",
      target: null,
    });
  } finally {
    ctx.cleanup();
  }
});

it("requires a busy-worktree supplier at both the typed and JavaScript doors", () => {
  type Options = Parameters<ReturnType<typeof createHostAgentServices>["createCommands"]>[0];
  expectTypeOf<undefined>().not.toExtend<Options["busyWorktreeSites"]>();
  const services = createHostAgentServices({
    events: { publish: vi.fn() },
    attention: HEADLESS_ATTENTION,
  });
  expect(() => services.createCommands({} as Options)).toThrow(
    "busy-worktree supplier is required",
  );
});

it("owns the socket before database construction and tolerates shutdown before start", async () => {
  const socket = createHostAgentSocket();
  expect(socket.live()).toBe(false);
  await socket.shutdown();
  expect(socket.live()).toBe(false);
});
