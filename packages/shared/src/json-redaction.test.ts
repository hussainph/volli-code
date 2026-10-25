import { describe, expect, test } from "vite-plus/test";

import {
  CredentialRedactionError,
  ExactValueByteRedactor,
  type CredentialStreamStepper,
} from "./credential-stream-redaction";
import { redactJsonValue, redactString } from "./json-redaction";

function stepperFor(values: Record<string, string>): CredentialStreamStepper {
  const redactor = new ExactValueByteRedactor(
    Object.entries(values).map(([name, value]) => [value, `‹secret:${name}›`] as const),
  );
  return (window, from, final) => redactor.step(window, from, final);
}

const failingStepper: CredentialStreamStepper = () => {
  throw new Error("contains sk-live-123");
};

describe("redactString", () => {
  test("replaces a value and leaves other text alone", () => {
    const step = stepperFor({ TOKEN: "sk-live-123" });
    expect(redactString("auth sk-live-123 ok", step)).toBe("auth ‹secret:TOKEN› ok");
    expect(redactString("", step)).toBe("");
  });

  test("an unchanged string is the original, even one UTF-8 cannot carry", () => {
    const step = stepperFor({ TOKEN: "sk-live-123" });
    const lone = "a\ud800b";
    expect(redactString(lone, step)).toBe(lone);
    expect(redactString("same length", step)).toBe("same length");
    // The marker is as long as this value: a change, not a no-op.
    const sameSize = stepperFor({ X: "ABCDEFGHIJKLMN" });
    expect(redactString("ABCDEFGHIJKLMN", sameSize)).toBe("‹secret:X›");
  });

  test("a failing redactor fails closed", () => {
    expect(() => redactString("x", failingStepper)).toThrow(CredentialRedactionError);
  });
});

describe("redactJsonValue", () => {
  const step = stepperFor({ PEM: "-----BEGIN KEY-----\nabc\n-----END KEY-----", TOKEN: "tok_9" });

  test("matches a value in its decoded form, which escaped bytes would miss", () => {
    const value = { text: "key: -----BEGIN KEY-----\nabc\n-----END KEY----- end" };
    // The serialized form escapes the newlines, so a byte pass would not see the value.
    expect(JSON.stringify(value)).not.toContain("-----BEGIN KEY-----\nabc");
    const result = redactJsonValue(value, step);
    expect(result.changed).toBe(true);
    expect(result.value).toEqual({ text: "key: ‹secret:PEM› end" });
  });

  test("walks arrays, nested objects and keys; keeps non-strings", () => {
    const value = {
      parts: [{ type: "text", text: "tok_9" }, 3, null, true],
      tok_9: { nested: ["fine"] },
    };
    const result = redactJsonValue(value, step);
    expect(result.changed).toBe(true);
    expect(result.value).toEqual({
      parts: [{ type: "text", text: "‹secret:TOKEN›" }, 3, null, true],
      "‹secret:TOKEN›": { nested: ["fine"] },
    });
  });

  test("nothing to redact returns the same reference", () => {
    const value = { parts: [{ type: "text", text: "hello" }], count: 2 };
    const result = redactJsonValue(value, step);
    expect(result.changed).toBe(false);
    expect(result.value).toBe(value);
    expect(redactJsonValue("plain", step)).toEqual({ value: "plain", changed: false });
    expect(redactJsonValue(5, step)).toEqual({ value: 5, changed: false });
  });
});
