import { describe, expect, it } from "vite-plus/test";

import {
  MCP_CREDENTIAL_ENTRY_MAX,
  MCP_CREDENTIAL_NAME_MAX_CHARS,
  MCP_CREDENTIAL_TEMPLATE_MAX_CHARS,
  MCP_OAUTH_CLIENT_SECRET_SLOT,
  MCP_OAUTH_TEXT_MAX_CHARS,
  MCP_SECRET_VALUE_MAX_CHARS,
  checkMcpCredentialTemplate,
  mcpCredentialSlot,
  mcpCredentialSlotLabel,
  mcpCredentialValueProblem,
  mcpSecretSlots,
  mcpServerUsesOAuth,
  resolveMcpCredentialTemplate,
  sanitizeMcpCredentialEntries,
  sanitizeMcpOAuthClient,
} from "./mcp-credentials";

describe("checkMcpCredentialTemplate", () => {
  it("names every variable a reference reads, once, with literal text around them", () => {
    expect(checkMcpCredentialTemplate("${TOKEN}")).toEqual({ ok: true, names: ["TOKEN"] });
    expect(checkMcpCredentialTemplate("Bearer ${TOKEN}")).toEqual({ ok: true, names: ["TOKEN"] });
    expect(checkMcpCredentialTemplate("${USER}:${PASS}:${USER}")).toEqual({
      ok: true,
      names: ["USER", "PASS"],
    });
    // A lone `$` is literal text, not an opened reference.
    expect(checkMcpCredentialTemplate("$5 ${PRICE}")).toEqual({ ok: true, names: ["PRICE"] });
  });

  it.each([
    [undefined, "${NAME}"],
    ["", "${NAME}"],
    [7, "${NAME}"],
    ["x".repeat(MCP_CREDENTIAL_TEMPLATE_MAX_CHARS + 1), "too long"],
    ["!gh auth token", "does not run commands"],
    ["Bearer ${TOKEN}\n", "control character"],
    ["${1BAD}", "every ${"],
    ["${TOKEN", "every ${"],
    ["${OK} ${", "every ${"],
    ["sk-live-plain-value", "store a plain value as a secret"],
  ])("refuses %j", (template, reason) => {
    const result = checkMcpCredentialTemplate(template);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });
});

describe("resolveMcpCredentialTemplate", () => {
  const environment: Record<string, string> = { TOKEN: "t0k3n", EMPTY: "" };
  const lookup = (name: string): string | undefined => environment[name];

  it("substitutes every reference and keeps the literal text", () => {
    expect(resolveMcpCredentialTemplate("Bearer ${TOKEN}", lookup)).toEqual({
      ok: true,
      value: "Bearer t0k3n",
    });
  });

  it("reports missing and blank variables by name, never a half-built value", () => {
    expect(resolveMcpCredentialTemplate("${TOKEN} ${ABSENT} ${EMPTY} ${ABSENT}", lookup)).toEqual({
      ok: false,
      missing: ["ABSENT", "EMPTY"],
    });
  });
});

describe("mcpCredentialValueProblem", () => {
  it("accepts an ordinary value and refuses what would smuggle or truncate", () => {
    expect(mcpCredentialValueProblem("header", "Bearer abc")).toBeNull();
    expect(mcpCredentialValueProblem("env", "multi\nline")).toBeNull();
    expect(mcpCredentialValueProblem("header", "abc\r\nX-Evil: 1")).toContain("line break");
    expect(mcpCredentialValueProblem("env", "a\u0000b")).toContain("NUL");
    expect(mcpCredentialValueProblem("env", "x".repeat(MCP_SECRET_VALUE_MAX_CHARS + 1))).toContain(
      "too long",
    );
  });
});

describe("credential slots", () => {
  it("files header slots case-insensitively and environment slots exactly", () => {
    expect(mcpCredentialSlot("header", "Authorization")).toBe("header:authorization");
    expect(mcpCredentialSlot("env", "Api_Key")).toBe("env:Api_Key");
    expect(mcpCredentialSlotLabel("header:authorization")).toBe("header authorization");
    expect(mcpCredentialSlotLabel("env:API_KEY")).toBe("env API_KEY");
    expect(mcpCredentialSlotLabel(MCP_OAUTH_CLIENT_SECRET_SLOT)).toBe("OAuth client secret");
  });

  it("lists only the slots kept as stored secrets", () => {
    expect(
      mcpSecretSlots("header", [
        { name: "Authorization", source: { kind: "secret" } },
        { name: "X-Org", source: { kind: "reference", template: "${ORG}" } },
      ]),
    ).toEqual(["header:authorization"]);
    expect(mcpSecretSlots("env", undefined)).toEqual([]);
  });
});

describe("sanitizeMcpCredentialEntries", () => {
  it("reads absence as none and keeps valid entries in order", () => {
    expect(sanitizeMcpCredentialEntries("env", undefined)).toEqual({ ok: true, entries: [] });
    expect(sanitizeMcpCredentialEntries("header", null)).toEqual({ ok: true, entries: [] });
    expect(
      sanitizeMcpCredentialEntries("header", [
        { name: "Authorization", source: { kind: "reference", template: "Bearer ${T}" } },
        { name: "X-Team", source: { kind: "secret", value: "dropped" } },
      ]),
    ).toEqual({
      ok: true,
      entries: [
        { name: "Authorization", source: { kind: "reference", template: "Bearer ${T}" } },
        // Anything beside the marker is dropped: a value never rides along.
        { name: "X-Team", source: { kind: "secret" } },
      ],
    });
  });

  it.each([
    ["env", {}, "must be a list"],
    [
      "env",
      Array.from({ length: MCP_CREDENTIAL_ENTRY_MAX + 1 }, (_, index) => ({
        name: `V${index}`,
        source: { kind: "secret" },
      })),
      "at most",
    ],
    ["header", [null], "must be objects"],
    ["header", [["x"]], "must be objects"],
    ["header", [{ name: 1, source: { kind: "secret" } }], "valid HTTP header name"],
    ["header", [{ name: "Bad Header", source: { kind: "secret" } }], "valid HTTP header name"],
    [
      "header",
      [{ name: "x".repeat(MCP_CREDENTIAL_NAME_MAX_CHARS + 1), source: { kind: "secret" } }],
      "valid HTTP header name",
    ],
    ["env", [{ name: "BAD-NAME", source: { kind: "secret" } }], "environment variable name"],
    ["header", [{ name: "Mcp-Session-Id", source: { kind: "secret" } }], "set by the transport"],
    [
      "header",
      [
        { name: "Authorization", source: { kind: "secret" } },
        { name: "authorization", source: { kind: "secret" } },
      ],
      "listed twice",
    ],
    ["env", [{ name: "A", source: null }], "A: a credential must be"],
    ["env", [{ name: "A", source: ["secret"] }], "A: a credential must be"],
    ["env", [{ name: "A", source: { kind: "literal" } }], "A: a credential must be"],
    ["env", [{ name: "A", source: { kind: "reference", template: "plain" } }], "A: a reference"],
  ] as const)("refuses %s %j", (family, raw, reason) => {
    const result = sanitizeMcpCredentialEntries(family, raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });
});

describe("sanitizeMcpOAuthClient", () => {
  it("reads absence and an empty object as no settings", () => {
    expect(sanitizeMcpOAuthClient(undefined)).toEqual({ ok: true, oauth: undefined });
    expect(sanitizeMcpOAuthClient(null)).toEqual({ ok: true, oauth: undefined });
    expect(sanitizeMcpOAuthClient({ clientId: "  ", scope: "" })).toEqual({
      ok: true,
      oauth: undefined,
    });
  });

  it("keeps a pre-registered client with its secret as a reference and a loopback callback", () => {
    expect(
      sanitizeMcpOAuthClient({
        clientId: " my-client ",
        clientSecret: { kind: "reference", template: "${EXAMPLE_SECRET}" },
        callbackPort: 8765,
        callbackUrl: "http://localhost:8080/oauth/callback",
        scope: "read write",
      }),
    ).toEqual({
      ok: true,
      oauth: {
        clientId: "my-client",
        clientSecret: { kind: "reference", template: "${EXAMPLE_SECRET}" },
        callbackPort: 8765,
        callbackUrl: "http://localhost:8080/oauth/callback",
        scope: "read write",
      },
    });
    expect(sanitizeMcpOAuthClient({ callbackUrl: "http://[::1]/cb" })).toEqual({
      ok: true,
      oauth: { callbackUrl: "http://[::1]/cb" },
    });
  });

  it.each([
    ["not an object", "must be an object"],
    [["array"], "must be an object"],
    [{ clientId: 7 }, "client id is invalid"],
    [{ clientId: "x".repeat(MCP_OAUTH_TEXT_MAX_CHARS + 1) }, "client id is invalid"],
    [{ scope: "read\nwrite" }, "scope is invalid"],
    [{ callbackUrl: 9 }, "callback URL is invalid"],
    [{ clientSecret: { kind: "secret" } }, "needs a client id"],
    [{ clientId: "c", clientSecret: { kind: "plain" } }, "OAuth client secret:"],
    [{ callbackPort: "8765" }, "port number"],
    [{ callbackPort: 1.5 }, "port number"],
    [{ callbackPort: 70_000 }, "port number"],
    [{ callbackUrl: "not a url" }, "callback URL is invalid"],
    [{ callbackUrl: "https://localhost/cb" }, "must be http on localhost"],
    [{ callbackUrl: "http://example.com/cb" }, "must be http on localhost"],
    [{ callbackUrl: "http://127.0.0.1/cb?x=1" }, "plain loopback"],
    [{ callbackUrl: "http://127.0.0.1/cb#x" }, "plain loopback"],
    [{ callbackUrl: "http://user@127.0.0.1/cb" }, "plain loopback"],
    [{ callbackUrl: "http://:secret@127.0.0.1/cb" }, "plain loopback"],
  ])("refuses %j", (raw, reason) => {
    const result = sanitizeMcpOAuthClient(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });
});

describe("mcpServerUsesOAuth", () => {
  it("applies OAuth unless the person configured an Authorization header", () => {
    expect(mcpServerUsesOAuth(undefined)).toBe(true);
    expect(mcpServerUsesOAuth([{ name: "X-Team", source: { kind: "secret" } }])).toBe(true);
    expect(mcpServerUsesOAuth([{ name: "AUTHORIZATION", source: { kind: "secret" } }])).toBe(false);
  });
});
