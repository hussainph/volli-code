import { describe, expect, test } from "vite-plus/test";

import {
  AGENT_TOKEN_AUDIENCE,
  AGENT_TOKEN_ISSUER,
  agentSubject,
  parseAgentTokenGrant,
  readAgentTokenClaims,
  sessionIdFromAgentSubject,
} from "./agent-tokens";
import { newId } from "./ids";
import { RUNNER_TOKEN_AUDIENCE, RUNNER_TOKEN_ISSUER } from "./runners";

describe("agent tokens", () => {
  test("have their own issuer and audience, never a runner's", () => {
    expect(AGENT_TOKEN_ISSUER).not.toBe(RUNNER_TOKEN_ISSUER);
    expect(AGENT_TOKEN_AUDIENCE).not.toBe(RUNNER_TOKEN_AUDIENCE);
  });

  test("name one Session in their subject", () => {
    const sessionId = newId("session");
    expect(agentSubject(sessionId)).toBe(`agent:${sessionId}`);
    expect(sessionIdFromAgentSubject(agentSubject(sessionId))).toBe(sessionId);
    expect(sessionIdFromAgentSubject(`runner:${sessionId}`)).toBeNull();
    expect(sessionIdFromAgentSubject("agent:not-a-uuid")).toBeNull();
  });

  test("claims read only in the shape the backend signs", () => {
    const own = newId("user");
    const rnr = newId("runner");
    const tkt = newId("ticket");
    expect(readAgentTokenClaims({ own, rnr, gen: 3, tkt })).toEqual({ own, rnr, gen: 3, tkt });
    expect(readAgentTokenClaims({ own, rnr, gen: 0, tkt: null })).toEqual({
      own,
      rnr,
      gen: 0,
      tkt: null,
    });
    expect(readAgentTokenClaims({ own, rnr, gen: 0 })).toEqual({ own, rnr, gen: 0, tkt: null });
    expect(readAgentTokenClaims({ own: "alice", rnr, gen: 1 })).toBeNull();
    expect(readAgentTokenClaims({ own, rnr: 7, gen: 1 })).toBeNull();
    expect(readAgentTokenClaims({ own, rnr, gen: "1" })).toBeNull();
    expect(readAgentTokenClaims({ own, rnr, gen: 1.5 })).toBeNull();
    expect(readAgentTokenClaims({ own, rnr, gen: -1 })).toBeNull();
    expect(readAgentTokenClaims({ own, rnr, gen: 1, tkt: "VC-1" })).toBeNull();
  });

  test("a grant parses only when whole", () => {
    expect(parseAgentTokenGrant({ token: "a.b.c", expiresAt: 2, serverTime: 1 })).toEqual({
      token: "a.b.c",
      expiresAt: 2,
      serverTime: 1,
    });
    for (const bad of [
      null,
      [],
      "token",
      { token: "", expiresAt: 2, serverTime: 1 },
      { token: "x".repeat(8_193), expiresAt: 2, serverTime: 1 },
      { token: "a", expiresAt: 1, serverTime: 1 },
      { token: "a", expiresAt: "2", serverTime: 1 },
      { token: "a", expiresAt: 2 },
    ]) {
      expect(() => parseAgentTokenGrant(bad)).toThrow(TypeError);
    }
  });
});
