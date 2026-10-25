import { describe, expect, test } from "vite-plus/test";

import {
  InvalidIdError,
  MAX_DERIVED_ID_LENGTH,
  isDerivedId,
  isUuid,
  newId,
  parseId,
  readId,
} from "./ids";

const V4 = "0d1e8f6a-3b2c-4d5e-8f70-123456789abc";
const V7 = "01a0f892-d611-7758-a14e-541793f7f4c0";

describe("isUuid", () => {
  test("accepts the lowercase canonical form of any version", () => {
    expect(isUuid(V4)).toBe(true);
    expect(isUuid(V7)).toBe(true);
    expect(isUuid("00000000-0000-0000-0000-000000000000")).toBe(true);
  });

  test("refuses uppercase, braces, missing dashes, wrong lengths and non-strings", () => {
    expect(isUuid(V4.toUpperCase())).toBe(false);
    expect(isUuid(`{${V4}}`)).toBe(false);
    expect(isUuid(V4.replaceAll("-", ""))).toBe(false);
    expect(isUuid(`${V4}0`)).toBe(false);
    expect(isUuid(` ${V4}`)).toBe(false);
    expect(isUuid("0d1e8f6a-3b2c-4d5e-8f70-12345678zabc")).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});

describe("parseId / readId", () => {
  test("parseId brands a valid id and throws a typed error otherwise", () => {
    expect(parseId("project", V4)).toBe(V4);
    expect(() => parseId("project", "nope")).toThrow(InvalidIdError);
    try {
      parseId("ticket", 7);
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_id", kind: "ticket", value: 7 });
      expect((error as Error).message).toBe("Expected a lowercase UUID for ticket, got number");
    }
    expect(() => parseId("user", "x".repeat(100))).toThrow(`"${"x".repeat(64)}"`);
  });

  test("readId answers null instead of throwing", () => {
    expect(readId("session", V7)).toBe(V7);
    expect(readId("session", "VC-12")).toBeNull();
  });
});

describe("newId", () => {
  test("mints distinct lowercase v4 ids", () => {
    const a = newId("ticket");
    const b = newId("ticket");
    expect(isUuid(a)).toBe(true);
    expect(a[14]).toBe("4");
    expect(a).not.toBe(b);
  });
});

describe("isDerivedId", () => {
  test("accepts frozen opaque ids up to the bound", () => {
    expect(isDerivedId("pi:observation:abc")).toBe(true);
    expect(isDerivedId(`sha256:${"a".repeat(64)}`)).toBe(true);
    expect(isDerivedId("x".repeat(MAX_DERIVED_ID_LENGTH))).toBe(true);
  });

  test("refuses empty, oversized and non-string values", () => {
    expect(isDerivedId("")).toBe(false);
    expect(isDerivedId("x".repeat(MAX_DERIVED_ID_LENGTH + 1))).toBe(false);
    expect(isDerivedId(undefined)).toBe(false);
  });
});
