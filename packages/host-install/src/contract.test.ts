import { describe, expect, it } from "vite-plus/test";

import { isHostdFailure, readHostdJson } from "./contract";

describe("the box-side contract", () => {
  it("reads the last JSON answer a management command printed", () => {
    expect(readHostdJson('noise\n{"v":1,"ok":true}\n\n')).toEqual({ v: 1, ok: true });
    expect(readHostdJson('{"v":1,"first":true}\n{"v":1,"last":true}')).toEqual({
      v: 1,
      last: true,
    });
    expect(readHostdJson('{"v":1,"ok":true}\n{not json}\n{"v":2}')).toEqual({ v: 1, ok: true });
    expect(readHostdJson("Usage: volli-hostd …")).toBeNull();
    expect(readHostdJson("null\n{}")).toBeNull();
  });

  it("tells a typed failure from an answer", () => {
    expect(isHostdFailure({ v: 1, ok: false, code: "not-root", message: "No." })).toBe(true);
    expect(isHostdFailure({ v: 1, ok: true })).toBe(false);
    expect(isHostdFailure({ v: 1, ok: false, code: 1, message: "No." })).toBe(false);
    expect(isHostdFailure({ v: 1, ok: false, code: "x" })).toBe(false);
  });
});
