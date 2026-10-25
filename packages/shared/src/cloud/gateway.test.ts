import { describe, expect, test } from "vite-plus/test";

import {
  GATEWAY_APIS,
  GATEWAY_AUDIENCE,
  GATEWAY_ERRORS,
  gatewayGrantSessionId,
  parseGatewayGrantClaims,
} from "./gateway";

const SESSION = "6f1c2a4e-0b8d-4c39-9a57-2d1e8f3b7c60";
const CONN = "0e9a7c51-3d2b-4f86-8a14-7b5c6d2e9f03";

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "https://issuer.example",
    aud: GATEWAY_AUDIENCE,
    sub: `session:${SESSION}`,
    jti: "2b7f0d9e-5a1c-4e38-b6d4-9c0a3f8e1b52",
    iat: 1_000,
    exp: 1_600,
    act: {
      runner: "8c3e1f5a-7b2d-4a96-8e0c-1d4f6b9a2c75",
      user: "4a9d2c7e-1f6b-4e05-9c38-5b7e0a1d3f86",
    },
    ws: "9e2b5d8a-4c7f-4b13-a6e9-0f3c8d1b5a27",
    routes: {
      anthropic: {
        conn: CONN,
        kv: 3,
        up: "https://api.anthropic.com",
        api: "anthropic-messages",
        sk: "sealed",
      },
    },
    ...overrides,
  };
}

describe("gatewayGrantSessionId", () => {
  test("reads the Session from a session subject", () => {
    expect(gatewayGrantSessionId(`session:${SESSION}`)).toBe(SESSION);
  });

  test("refuses other subjects and non-canonical ids", () => {
    expect(gatewayGrantSessionId(`runner:${SESSION}`)).toBeNull();
    expect(gatewayGrantSessionId(`session:${"-".repeat(36)}`)).toBeNull();
  });
});

describe("parseGatewayGrantClaims", () => {
  test("accepts a well-formed grant and keeps only known fields", () => {
    const parsed = parseGatewayGrantClaims(
      claims({
        prj: "1c5e8a2d-6b9f-4d37-8e1a-3f7c0b4d9e62",
        extra: "dropped",
        routes: {
          openrouter: {
            conn: CONN,
            kv: 0,
            up: "https://openrouter.ai/api/v1",
            api: "openai-completions",
            sk: "sealed",
            hdr: { "x-title": "Volli" },
            extra: "dropped",
          },
        },
      }),
    );
    expect(parsed).toEqual({
      ...claims(),
      prj: "1c5e8a2d-6b9f-4d37-8e1a-3f7c0b4d9e62",
      routes: {
        openrouter: {
          conn: CONN,
          kv: 0,
          up: "https://openrouter.ai/api/v1",
          api: "openai-completions",
          sk: "sealed",
          hdr: { "x-title": "Volli" },
        },
      },
    });
  });

  test("omits absent optional fields rather than writing undefined", () => {
    const parsed = parseGatewayGrantClaims(claims());
    expect(parsed && "prj" in parsed).toBe(false);
    expect(parsed && "hdr" in parsed.routes.anthropic!).toBe(false);
  });

  const route = (overrides: Record<string, unknown>) => ({
    routes: {
      anthropic: {
        conn: CONN,
        kv: 3,
        up: "https://api.anthropic.com",
        api: "anthropic-messages",
        sk: "sealed",
        ...overrides,
      },
    },
  });

  test.each([
    ["a non-object", null],
    ["an array", []],
    ["a non-string issuer", claims({ iss: 1 })],
    ["another audience", claims({ aud: "volli-runner" })],
    ["a non-string subject", claims({ sub: 1 })],
    ["a runner subject", claims({ sub: `runner:${SESSION}` })],
    ["a non-uuid jti", claims({ jti: "x" })],
    ["a fractional iat", claims({ iat: 1.5 })],
    ["a missing exp", claims({ exp: undefined })],
    ["a missing actor", claims({ act: undefined })],
    ["a non-uuid runner", claims({ act: { runner: "x", user: SESSION } })],
    ["a non-uuid user", claims({ act: { runner: SESSION, user: "x" } })],
    ["a non-uuid workspace", claims({ ws: "x" })],
    ["a non-uuid project", claims({ prj: "x" })],
    ["non-object routes", claims({ routes: [] })],
    ["no routes", claims({ routes: {} })],
    ["a non-object route", claims({ routes: { anthropic: "x" } })],
    ["a non-uuid connection", claims(route({ conn: "x" }))],
    ["a negative key version", claims(route({ kv: -1 }))],
    ["a fractional key version", claims(route({ kv: 1.5 }))],
    ["a non-string upstream", claims(route({ up: 1 }))],
    ["a non-string sealed key", claims(route({ sk: 1 }))],
    ["an empty sealed key", claims(route({ sk: "" }))],
    ["an unknown api", claims(route({ api: "bedrock-converse" }))],
    ["non-string extra headers", claims(route({ hdr: { a: 1 } }))],
    ["an array of extra headers", claims(route({ hdr: ["a"] }))],
  ])("refuses %s", (_label, value) => {
    expect(parseGatewayGrantClaims(value)).toBeNull();
  });
});

test("every gateway error is a volli_ code with an HTTP error status", () => {
  for (const [code, { status }] of Object.entries(GATEWAY_ERRORS)) {
    expect(code).toMatch(/^volli_[a-z_]+$/);
    expect(status).toBeGreaterThanOrEqual(400);
  }
});

test("the relayable API families are Pi's api ids", () => {
  expect(GATEWAY_APIS).toEqual(["anthropic-messages", "openai-responses", "openai-completions"]);
});
