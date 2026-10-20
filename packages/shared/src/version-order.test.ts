import { describe, expect, it } from "vite-plus/test";

import { compareVersions } from "./version-order";

describe("compareVersions", () => {
  it("orders versions numerically, a prerelease before its release", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.1")).toBe(-1);
    expect(compareVersions("1.0.1", "1.0")).toBe(1);
    expect(compareVersions("1.0.0-canary.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-canary.1")).toBe(1);
    expect(compareVersions("1.0.0-canary.1", "1.0.0-canary.2")).toBe(-1);
    expect(compareVersions("1.0.0-canary.2", "1.0.0-canary.1")).toBe(1);
    expect(compareVersions("x.y", "0.0")).toBe(0);
    expect(compareVersions("0.3.0-canary.9", "0.3.0-canary.10")).toBe(-1);
    expect(compareVersions("0.3.0-canary.10", "0.3.0-canary.9")).toBe(1);
    expect(compareVersions("0.3.0-canary.10", "0.3.0")).toBe(-1);
    expect(compareVersions("0.3.0-canary.10+build.1", "0.3.0-canary.10+build.2")).toBe(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    expect(compareVersions("1.0.0-beta", "1.0.0-alpha")).toBe(1);
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.one")).toBe(-1);
    expect(compareVersions("1.0.0-alpha.one", "1.0.0-alpha.1")).toBe(1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha")).toBe(1);
    expect(compareVersions("1.0.0-alpha.1.x", "1.0.0-alpha.1.y")).toBe(-1);
    expect(compareVersions("1.0.0-alpha.01", "1.0.0-alpha.1")).toBe(0);
    expect(compareVersions("1.0.0-alpha.01.x", "1.0.0-alpha.1.x")).toBe(0);
    expect(compareVersions("1.0.0-9007199254740992", "1.0.0-9007199254740993")).toBe(-1);
    expect(compareVersions("1.0.0-alpha-one", "1.0.0-alpha-two")).toBe(-1);
  });
});
