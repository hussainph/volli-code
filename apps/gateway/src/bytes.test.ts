import { expect, test } from "vite-plus/test";

import { concatBytes, fromBase64Url, toBase64Url, utf8 } from "./bytes.ts";

test("base64url round-trips every byte, unpadded", () => {
  const bytes = new Uint8Array(256).map((_, index) => index);
  const text = toBase64Url(bytes);
  expect(text).not.toMatch(/[+/=]/);
  expect(fromBase64Url(text)).toEqual(bytes);
  expect(toBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
});

test("fromBase64Url refuses what is not unpadded base64url", () => {
  expect(fromBase64Url("ab+/")).toBeNull();
  expect(fromBase64Url("abc=")).toBeNull();
  expect(fromBase64Url("abcde")).toBeNull();
  expect(fromBase64Url("")).toEqual(new Uint8Array(0));
});

test("concatBytes joins in order", () => {
  expect(concatBytes(utf8("ab"), new Uint8Array(0), utf8("c"))).toEqual(utf8("abc"));
});
