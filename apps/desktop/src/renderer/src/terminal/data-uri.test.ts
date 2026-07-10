import { describe, expect, it } from "vite-plus/test";
import { decodeBase64DataUri } from "./data-uri";

describe("decodeBase64DataUri", () => {
  it("decodes the base64 payload to its bytes", () => {
    // "hi" → base64 "aGk="
    const bytes = decodeBase64DataUri("data:font/woff2;base64,aGk=");
    expect(Array.from(bytes)).toEqual([0x68, 0x69]);
  });

  it("preserves binary (non-ASCII) bytes", () => {
    // bytes [0x00, 0xff, 0x10] → base64 "AP8Q"
    const bytes = decodeBase64DataUri("data:application/octet-stream;base64,AP8Q");
    expect(Array.from(bytes)).toEqual([0x00, 0xff, 0x10]);
  });

  it("throws when the string is not a data: URI", () => {
    expect(() => decodeBase64DataUri("https://example.com/font.woff2")).toThrow("Not a data: URI");
    expect(() => decodeBase64DataUri("data:font/woff2")).toThrow("Not a data: URI");
  });

  it("throws when the data: URI is not base64-encoded", () => {
    expect(() => decodeBase64DataUri("data:text/plain,hello")).toThrow("not base64");
  });
});
