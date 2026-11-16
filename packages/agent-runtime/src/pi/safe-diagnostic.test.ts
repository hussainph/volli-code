import { describe, expect, it } from "vite-plus/test";
import {
  localProviderDiagnostic,
  safeProgramErrorMessage,
  safeStopMessage,
} from "./safe-diagnostic";
import {
  DIAGNOSTIC_SECRET_CASES,
  diagnosticCredentialRedaction,
  STORED_DIAGNOSTIC_SECRET,
} from "./diagnostic-fixtures";

describe("the common diagnostic redaction boundary", () => {
  it("redacts typed program exceptions before bounding without parsing JSON punctuation as an envelope", () => {
    const secret = `dummy-${"s".repeat(100)}`;
    const raw = `Unexpected token '{' in JSON: ${secret} ${"word ".repeat(200)}`;
    const result = safeProgramErrorMessage(raw, {
      redact: (text) => text.replaceAll(secret, "[redacted]"),
    });
    expect(result).toMatch(/^Unexpected token '\{' in JSON: \[redacted\]/);
    expect(result.length).toBeLessThanOrEqual(401);
    expect(result).not.toContain(secret.slice(0, 20));
    expect(
      safeProgramErrorMessage("private", {
        redact: () => {
          throw new Error("private");
        },
      }),
    ).toBe("[Text withheld: credential redaction failed.]");
    expect(safeProgramErrorMessage("Bearer dummy-token")).not.toContain("dummy-token");
  });

  it.each(DIAGNOSTIC_SECRET_CASES)(
    "redacts %s with the same policy as provider stops",
    (_label, raw, secrets) => {
      const safe = safeStopMessage(raw, diagnosticCredentialRedaction);
      for (const secret of secrets) expect(safe).not.toContain(secret);
      expect(safe.length).toBeLessThanOrEqual(401);
    },
  );

  it("matches exact values before whitespace normalization and length bounding", () => {
    const stored = "dummy-secret\nwith  spaces";
    const raw = `${"word ".repeat(75)}${stored} trailing`;
    const safe = safeStopMessage(raw, { redact: (text) => text.replaceAll(stored, "[redacted]") });
    expect(safe).not.toContain("dummy-secret");
    expect(safe).toContain("[redacted]");
    expect(safe).toHaveLength(394);
  });

  it("fails closed without keeping a credential-owner exception", () => {
    expect(
      safeStopMessage(STORED_DIAGNOSTIC_SECRET, {
        redact: () => {
          throw new Error(STORED_DIAGNOSTIC_SECRET);
        },
      }),
    ).toBe("[Text withheld: credential redaction failed.]");
  });

  it("never unwraps a request as an error sentence", () => {
    expect(safeStopMessage('{"password":"dummy-password"}')).toBe(
      "Provider error (no message stated).",
    );
    expect(safeStopMessage('503: {"error":null,"message":"upstream down"}')).toBe(
      "503 upstream down",
    );
    expect(safeStopMessage('{"error":[],"message":"upstream down"}')).toBe("upstream down");
    // Fields beside the error are never read, whatever they hold.
    expect(
      safeStopMessage(
        '400 {"error":{"message":"bad"},"request":{"messages":[{"role":"user","content":"private-prompt"}]}}',
      ),
    ).toBe("400 bad");
  });

  it.each([
    ['"role": "user"', 'Bad turn {"role": "user", "content": "private-prompt"'],
    ["a quoted request field", 'Invalid {"messages": ["private-prompt"]'],
    ["a quoted content field", "failed near 'content': 'private-prompt'"],
    ["a long quoted span", `Unexpected value "${"private-prompt ".repeat(10)}"`],
    ["a long code span", `Unexpected value \`${"private-prompt ".repeat(10)}\``],
    ["an announced echo", "Echoed request: private-prompt"],
    ["an envelope sentence", '{"error":{"message":"bad turn {\\"role\\":\\"user\\"}"}}'],
  ])("withholds echoed request content: %s", (_label, raw) => {
    expect(safeStopMessage(raw)).toBe("[Provider text withheld: possible request content.]");
  });

  // Every case a person saw replaced by a withheld or empty notice (VC-1244).
  it.each([
    [
      '400 {"error":{"type":"invalid_request_error","message":"messages: text content blocks must be non-empty"}}',
      "400 messages: text content blocks must be non-empty",
    ],
    [
      "Input: tools.0.custom.input_schema: JSON schema is invalid",
      "Input: tools.0.custom.input_schema: JSON schema is invalid",
    ],
    ["request body: missing field model", "request body: missing field model"],
    ['400 {"error":{"message":"bad"}} (request id req_123)', "400 bad (request id req_123)"],
    [
      '{"detail":"Unsupported parameter: reasoning.summary"}',
      "Unsupported parameter: reasoning.summary",
    ],
    [
      'Codex error: {"type":"error","status":400}',
      "Codex error: Provider error (type error, status 400).",
    ],
    [
      "messages.3.content.0: `thinking` blocks cannot be modified.",
      "messages.3.content.0: `thinking` blocks cannot be modified.",
    ],
    ["input[12].content: expected a string", "input[12].content: expected a string"],
    ['{"error":"model_not_found"}', "model_not_found"],
    [
      '{"type":"error","error":{"type":"overloaded_error","code":529}}',
      "Provider error (type overloaded_error, code 529).",
    ],
    // A summary names codes, never prose or a value that could be anything.
    [
      '{"error":{"type":"a sentence, not a code","code":1.5}}',
      "Provider error (no message stated).",
    ],
    ['{"detail":[{"msg":"field required"}],"status":"422"}', "Provider error (status 422)."],
    // An escaped quote or brace inside a string is not the envelope's end.
    ['{"message":"say \\"}\\" twice"} later', 'say "}" twice later'],
    // A balanced span that is not JSON is prose.
    ["{oops} at the end", "{oops} at the end"],
    // An unbalanced one is too.
    ['{"error":{"message":"cut', '{"error":{"message":"cut'],
  ])("reads %s as the provider's sentence", (raw, expected) => {
    expect(safeStopMessage(raw)).toBe(expected);
  });

  it("keeps provider ids and documentation links but not keys or other URLs (VC-1244)", () => {
    for (const id of [
      "toolu_01A09q90qw90lq917835lq9AbC",
      "srvtoolu_01A09q90qw90lq917835lq9AbC",
      "call_AbCdEf1234567890XyZ12345",
      "fc_68b0a1f2c3d4e5f60718293a4b5c6d7e",
      "req_011CVK9vX3mF7pQwLtRs2ZbN",
      "msg_01XFDUDYJgAACzvnptvVoYEL",
      "resp_68b0a1f2c3d4e5f60718293a4b5c6d7e",
    ]) {
      expect(safeStopMessage(`unmatched ${id} here`)).toBe(`unmatched ${id} here`);
    }
    expect(
      safeStopMessage(
        "tool_use ids were found without tool_result blocks: toolu_01A09q90qw90lq917835lq9AbC. See https://docs.anthropic.com/en/docs/build-with-claude/tool-use.",
      ),
    ).toBe(
      "tool_use ids were found without tool_result blocks: toolu_01A09q90qw90lq917835lq9AbC. See https://docs.anthropic.com/en/docs/build-with-claude/tool-use.",
    );
    expect(safeStopMessage("(https://platform.openai.com/docs/guides/error-codes)")).toBe(
      "(https://platform.openai.com/docs/guides/error-codes)",
    );
    for (const url of [
      "https://example.com/docs",
      "http://docs.anthropic.com/en/api/errors",
      "https://docs.anthropic.com:8443/en/api/errors",
      "https://docs.anthropic.com.evil.test/en/api/errors",
      "https://user@docs.anthropic.com/en",
      "https://[bad",
    ]) {
      expect(safeStopMessage(`see ${url}`)).toBe("see [redacted URL]");
    }
    const signed = safeStopMessage("see https://docs.anthropic.com/en/api/errors?token=dummy");
    expect(signed).toMatch(/^see \[redacted URL\]/);
    expect(signed).not.toContain("dummy");
    // Look-alike prefixes are not provider ids; real key shapes still redact.
    for (const key of [
      "tok_AbCdEf1234567890XyZ12345",
      "call_AbCdEf-1234567890XyZ12345",
      "sk-proj-AbC123xyzAbC123xyzAbC123",
    ]) {
      expect(safeStopMessage(`bad ${key}`)).toBe("bad [redacted]");
    }
  });

  it.each([
    [
      '401 {"error":{"message":"Incorrect API key provided: sk-proj-AbC123xyzAbC123xyzAbC123. You can find your API key at https://platform.openai.com/account/api-keys."}}',
      "401 Incorrect API key provided: [redacted]. You can find your API key at https://platform.openai.com/account/api-keys.",
      "sk-proj-AbC123",
    ],
    [
      '400 {"error":{"message":"bad Bearer abcDEF123ghiJKL456"}} (Authorization: Bearer xyzTOKEN987)',
      "400 bad Bearer [redacted] (Authorization: Bearer [redacted])",
      "TOKEN987",
    ],
    [
      '{"detail":"token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkdW1teSJ9.dummySignature482 expired"}',
      "token [redacted] expired",
      "dummySignature482",
    ],
    [
      "request body: api_key=dummy-key-1244 is not valid for toolu_01A09q90qw90lq917835lq9AbC",
      "request body: api_key= [redacted] is not valid for toolu_01A09q90qw90lq917835lq9AbC",
      "dummy-key-1244",
    ],
    [
      'Codex error: {"type":"error","status":401} owner-dummy-482',
      "Codex error: Provider error (type error, status 401). [redacted]",
      STORED_DIAGNOSTIC_SECRET,
    ],
  ])("still redacts credentials inside a readable message: %s", (raw, expected, secret) => {
    const safe = safeStopMessage(raw, diagnosticCredentialRedaction);
    expect(safe).toBe(expected);
    expect(safe).not.toContain(secret);
  });

  it("keeps the whole envelope for the local diagnostic, credentials still redacted", () => {
    const raw = `400 {"error":{"message":"bad"},"request_id":"req_011CVK9vX3mF7pQwLtRs2ZbN","request":{"password":"dummy-password","api_key": 12345,"messages":[{"role":"user","content":"Bearer dummy-bearer ${STORED_DIAGNOSTIC_SECRET}"}]}}`;
    const local = localProviderDiagnostic(raw, diagnosticCredentialRedaction);
    expect(local).toContain('"request_id":"req_011CVK9vX3mF7pQwLtRs2ZbN"');
    expect(local).toContain('"role":"user"');
    for (const secret of ["dummy-password", "12345", "dummy-bearer", STORED_DIAGNOSTIC_SECRET])
      expect(local).not.toContain(secret);
    expect(local).toContain('"password":"[redacted]"');
    expect(localProviderDiagnostic(`${"word ".repeat(1000)}`)).toHaveLength(2001);
    expect(localProviderDiagnostic('{"type":"note","value":"plain"}')).toBe(
      '{"type":"note","value":"plain"}',
    );
  });

  it("preserves actionable vocabulary, not mixed-case, empty-segment or numeric tokens", () => {
    expect(safeStopMessage("prefix_mismatch_behavior")).toBe("prefix_mismatch_behavior");
    for (const token of [
      "a".repeat(24),
      "Abc-".repeat(6),
      "12345678-1234-1234-1234-123456789012",
      "joined--lowercase-words-extra",
    ]) {
      expect(safeStopMessage(token)).toBe("[redacted]");
    }
  });

  it("bounds extracted envelopes and strips URLs", () => {
    expect(
      safeStopMessage(`400 ${JSON.stringify({ error: { message: "word ".repeat(100) } })}`),
    ).toHaveLength(401);
    expect(safeStopMessage("failed https://example.test/private?password=dummy-password")).toBe(
      "failed [redacted URL] [redacted]",
    );
  });
});
