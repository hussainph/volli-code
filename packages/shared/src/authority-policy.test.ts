import { describe, expect, it } from "vite-plus/test";
import { containsPath } from "./authority-policy";

describe("containsPath", () => {
  it.each([
    ["/ws", "/ws", true],
    ["/ws", "/ws/src/file", true],
    ["/ws/", "/ws//src", true],
    ["/ws", "/ws-evil/file", false],
    ["/ws", "/WS/file", false],
    ["/ws/src", "/ws", false],
    ["/", "/tmp/file", true],
  ])("compares resolved components literally: %s, %s", (root, candidate, result) => {
    expect(containsPath(root, candidate)).toBe(result);
  });
});
