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

  test("a string of several MiB goes through in pieces, a value across their seam included", () => {
    const step = stepperFor({ TOKEN: "sk-live-123" });
    const MiB = 1024 * 1024;
    const pad = "p".repeat(MiB - 4);
    const text = `${pad}sk-live-123${"q".repeat(2 * MiB)}sk-live-123`;
    expect(redactString(text, step)).toBe(
      `${pad}‹secret:TOKEN›${"q".repeat(2 * MiB)}‹secret:TOKEN›`,
    );
    const clean = "c".repeat(3 * MiB + 7);
    expect(redactString(clean, step)).toBe(clean);
  });

  test("a long string is checked in pieces, and redacted whole only when a value is in it", () => {
    const MiB = 1024 * 1024;
    const pad = "p".repeat(MiB - 3);
    // A value's first bytes end a piece but the value never completes: unchanged.
    const near = `${pad}sk-nope${"q".repeat(MiB)}`;
    expect(redactString(near, stepperFor({ TOKEN: "sk-live-123" }))).toBe(near);
    const lone = `${pad}\ud800${"q".repeat(MiB)}`;
    expect(redactString(lone, stepperFor({ TOKEN: "sk-live-123" }))).toBe(lone);
    // Markers longer, as long as, and shorter than their values.
    const longer = `${"q".repeat(MiB + 1)}sk-live-123`;
    expect(redactString(longer, stepperFor({ T: "sk-live-123" }))).toBe(
      `${"q".repeat(MiB + 1)}‹secret:T›`,
    );
    const sameSize = `${"q".repeat(MiB + 1)}ABCDEFGHIJKLMN`;
    expect(redactString(sameSize, stepperFor({ X: "ABCDEFGHIJKLMN" }))).toBe(
      `${"q".repeat(MiB + 1)}‹secret:X›`,
    );
    const prefix = new ExactValueByteRedactor([["[hidden]tail", "[hidden]"]]);
    const shorter = `${"q".repeat(MiB + 1)}[hidden]tail`;
    expect(redactString(shorter, (window, from, final) => prefix.step(window, from, final))).toBe(
      `${"q".repeat(MiB + 1)}[hidden]`,
    );
  });

  test("a value whose marker is its own prefix is still a change", () => {
    const redactor = new ExactValueByteRedactor([["[hidden]tail", "[hidden]"]]);
    const step: CredentialStreamStepper = (window, from, final) =>
      redactor.step(window, from, final);
    expect(redactString("a[hidden]tail", step)).toBe("a[hidden]");
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
    expect(redactJsonValue(true, step)).toEqual({ value: true, changed: false });
  });

  test("a number that is a value becomes its marker", () => {
    const pin = stepperFor({ PIN: "482913" });
    expect(redactJsonValue({ code: 482913, other: 7 }, pin)).toEqual({
      value: { code: "‹secret:PIN›", other: 7 },
      changed: true,
    });
  });
});
