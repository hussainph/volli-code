import { describe, it, expect } from "vite-plus/test";
import { actorHarnessId, agentActor, isAgentActor, USER_ACTOR } from "./ticket-comment";
import type { TicketComment } from "./ticket-comment";

describe("USER_ACTOR", () => {
  it("is the literal string 'user'", () => {
    expect(USER_ACTOR).toBe("user");
  });
});

describe("agentActor", () => {
  it("builds an 'agent:<harnessId>' actor string", () => {
    expect(agentActor("claude-code")).toBe("agent:claude-code");
    expect(agentActor("codex")).toBe("agent:codex");
    expect(agentActor("opencode")).toBe("agent:opencode");
  });
});

describe("isAgentActor", () => {
  it("is true for agentActor-built strings", () => {
    expect(isAgentActor(agentActor("claude-code"))).toBe(true);
  });

  it("is false for the user actor", () => {
    expect(isAgentActor(USER_ACTOR)).toBe(false);
  });

  it("is false for an unrelated string", () => {
    expect(isAgentActor("automation")).toBe(false);
    expect(isAgentActor("")).toBe(false);
  });
});

describe("actorHarnessId", () => {
  it("extracts the harness id from an agentActor string", () => {
    expect(actorHarnessId(agentActor("codex"))).toBe("codex");
  });

  it("returns null for the user actor", () => {
    expect(actorHarnessId(USER_ACTOR)).toBeNull();
  });

  it("returns null for an unrelated string", () => {
    expect(actorHarnessId("automation")).toBeNull();
  });

  it("returns null when the agent: prefix is followed by an unknown harness id", () => {
    expect(actorHarnessId("agent:not-a-real-harness")).toBeNull();
  });
});

describe("TicketComment", () => {
  it("builds a well-formed comment shape", () => {
    const comment: TicketComment = {
      id: "comment-1",
      ticketId: "ticket-1",
      sessionId: null,
      actor: USER_ACTOR,
      body: "Looks good.",
      createdAt: 100,
      updatedAt: 100,
    };
    expect(comment.sessionId).toBeNull();
  });

  it("links an agent-posted summary back to its session", () => {
    const comment: TicketComment = {
      id: "comment-2",
      ticketId: "ticket-1",
      sessionId: "session-1",
      actor: agentActor("claude-code"),
      body: "Session summary.",
      createdAt: 100,
      updatedAt: 100,
    };
    expect(comment.sessionId).toBe("session-1");
  });
});
