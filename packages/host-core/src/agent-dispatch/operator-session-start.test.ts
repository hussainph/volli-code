import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { AgentRequest } from "@volli/shared";
import { createAgentCommandService } from "../agent-commands";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertProject } from "../db/projects-repo";
import { insertTicket } from "../db/tickets-repo";
import { createTestSessionEngine } from "../testing/session-engine";
import { createSessionTokenRegistry } from "../session-tokens";
import { StructuredSessionsError } from "../session-runtime/sessions";

let db: TestDb;
afterEach(() => db?.cleanup());
const request = (
  env: AgentRequest["ctx"]["env"],
  args: AgentRequest["args"] = { id: "VC-1", title: "Permanent", message: "hello" },
): AgentRequest => ({ v: 1, cmd: "session.start", args, ctx: { cwd: "/repo", env } });
function fixture() {
  db = openTestDb();
  insertProject(db.db, testProject({ id: "p", ticketPrefix: "VC" }));
  insertTicket(db.db, testTicket("p", { id: "t", ticketNumber: 1 }));
  const tokens = createSessionTokenRegistry();
  const start = vi.fn(async () => ({
    sessionId: "abcdef12-session",
    state: "ready" as const,
    receipt: null,
    throughSequence: 0,
    model: { providerId: "test", modelId: "m", reasoningLevel: "off" as const },
  }));
  const kickoff = vi.fn(async () => {});
  const audit = vi.fn();
  const service = createAgentCommandService({
    db: db.db,
    sessionEngine: createTestSessionEngine(db.db),
    appVersion: "test",
    busyWorktreeSites: async () => [],
    verifySessionToken: tokens.verify,
    verifyOperatorToken: (token) => (token === "op" ? { login: "ops" } : null),
    sessions: { start },
    submitSessionMessage: kickoff,
    onOperatorWrite: audit,
  });
  return { service, tokens, start, kickoff, audit, request };
}

describe("operator Session start admission", () => {
  it("starts as the person, through the shared operation, and audits", async () => {
    const f = fixture();
    expect(await f.service.execute(f.request({ operatorToken: "op" }))).toMatchObject({
      ok: true,
      data: { sessionId: "abcdef12-session", state: "ready", ticket: "VC-1", title: "Permanent" },
    });
    expect(f.start).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "ticket",
        projectId: "p",
        ticketId: "t",
        actor: { kind: "user" },
      }),
    );
    expect(f.kickoff).toHaveBeenCalledWith(
      expect.objectContaining({ text: "hello", sessionId: "abcdef12-session" }),
    );
    expect(f.audit).toHaveBeenCalledWith({
      login: "ops",
      cmd: "session.start",
      ok: true,
      code: null,
    });
  });
  it("refuses anonymous, forged, and authenticated Session callers even beside a valid operator token", async () => {
    const f = fixture();
    const token = f.tokens.mint({ sessionId: "s", attachmentId: "a" });
    for (const env of [
      {},
      { operatorToken: "forged" },
      { session: "s", token, operatorToken: "op" },
      { token: "invalid", operatorToken: "op" },
      { session: "s", operatorToken: "op" },
    ]) {
      expect(await f.service.execute(f.request(env))).toMatchObject({
        ok: false,
        error: { code: "WRONG_DOOR" },
      });
    }
    expect(f.start).not.toHaveBeenCalled();
    expect(f.kickoff).not.toHaveBeenCalled();
  });
  it.each([
    { model: "test/m", tier: "fast" },
    { model: "bad" },
    { model: 42 },
    { tier: "unknown" },
    { reasoning: "no" },
    { title: 42 },
    { message: false },
    { title: "" },
    { title: "   " },
    { message: "" },
    { message: " \n " },
  ])("rejects malformed input before birth: %j", async (args) => {
    const f = fixture();
    expect(
      await f.service.execute(f.request({ operatorToken: "op" }, { id: "VC-1", ...args })),
    ).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(f.start).not.toHaveBeenCalled();
  });
  it("passes exact model/tier/reasoning choices and typed credential refusals", async () => {
    const f = fixture();
    await f.service.execute(
      f.request(
        { operatorToken: "op" },
        { id: "VC-1", model: "test/m", reasoning: "off", title: "Explicit" },
      ),
    );
    expect(f.start).toHaveBeenLastCalledWith(
      expect.objectContaining({
        modelOverride: { model: { providerId: "test", modelId: "m" }, reasoningLevel: "off" },
      }),
    );
    await f.service.execute(
      f.request({ operatorToken: "op" }, { id: "VC-1", tier: "fast", title: "Explicit" }),
    );
    expect(f.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelOverride: { tier: "fast" } }),
    );
    f.start.mockRejectedValue(new StructuredSessionsError("MODEL_UNAVAILABLE", "Sign in required"));
    expect(await f.service.execute(f.request({ operatorToken: "op" }))).toMatchObject({
      ok: false,
      error: { code: "MODEL_UNAVAILABLE", message: "Sign in required" },
    });
  });
});
