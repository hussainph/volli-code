import { describe, expect, it } from "vite-plus/test";

import { parseHexColor } from "./css-color";

describe("parseHexColor", () => {
  it("parses #rrggbb", () => {
    expect(parseHexColor("#e8652a")).toEqual({ r: 0xe8, g: 0x65, b: 0x2a });
    expect(parseHexColor("#111111")).toEqual({ r: 0x11, g: 0x11, b: 0x11 });
    expect(parseHexColor("#000000")).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseHexColor("#ffffff")).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("expands #rgb shorthand by doubling each digit", () => {
    expect(parseHexColor("#f5a")).toEqual({ r: 0xff, g: 0x55, b: 0xaa });
    expect(parseHexColor("#000")).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("is case-insensitive", () => {
    expect(parseHexColor("#E8652A")).toEqual({ r: 0xe8, g: 0x65, b: 0x2a });
    expect(parseHexColor("#F5A")).toEqual({ r: 0xff, g: 0x55, b: 0xaa });
  });

  it("tolerates surrounding whitespace (getComputedStyle values are padded)", () => {
    expect(parseHexColor(" #111111 ")).toEqual({ r: 0x11, g: 0x11, b: 0x11 });
    expect(parseHexColor("\t#f5a\n")).toEqual({ r: 0xff, g: 0x55, b: 0xaa });
  });

  it("rejects missing or empty values", () => {
    expect(parseHexColor("")).toBeNull();
    expect(parseHexColor("   ")).toBeNull();
  });

  it("rejects values without a leading hash", () => {
    expect(parseHexColor("e8652a")).toBeNull();
    expect(parseHexColor("f5a")).toBeNull();
  });

  it("rejects lengths other than 3 or 6 digits", () => {
    expect(parseHexColor("#1")).toBeNull();
    expect(parseHexColor("#12")).toBeNull();
    expect(parseHexColor("#1234")).toBeNull();
    expect(parseHexColor("#12345")).toBeNull();
    expect(parseHexColor("#1234567")).toBeNull();
    expect(parseHexColor("#11223344")).toBeNull(); // #rrggbbaa unsupported
  });

  it("rejects non-hex digits and other color syntaxes", () => {
    expect(parseHexColor("#ggg")).toBeNull();
    expect(parseHexColor("#11z111")).toBeNull();
    expect(parseHexColor("rgb(17, 17, 17)")).toBeNull();
    expect(parseHexColor("#11 11 11")).toBeNull();
  });
});
