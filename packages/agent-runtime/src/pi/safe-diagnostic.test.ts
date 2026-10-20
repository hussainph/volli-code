import { describe, expect, it } from "vite-plus/test";
import { safeStopMessage } from "./safe-diagnostic";
import {
  DIAGNOSTIC_SECRET_CASES,
  diagnosticCredentialRedaction,
  STORED_DIAGNOSTIC_SECRET,
} from "./diagnostic-fixtures";

describe("the common diagnostic redaction boundary", () => {
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
    expect(safeStopMessage('{"error":{"message":"request: dummy-password"}}')).toContain(
      "withheld",
    );
    expect(safeStopMessage("not JSON {dummy-password}")).toContain("withheld");
    expect(safeStopMessage("a closing } dummy-password")).toContain("withheld");
    expect(safeStopMessage('503: {"error":null,"message":"upstream down"}')).toBe(
      "503 upstream down",
    );
    expect(safeStopMessage('{"error":[],"message":"upstream down"}')).toBe("upstream down");
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
