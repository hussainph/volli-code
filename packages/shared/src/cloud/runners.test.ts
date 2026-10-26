import { describe, expect, test } from "vite-plus/test";

import { newId, type RunnerId } from "./ids";
import {
  RUNNER_NAME_MAX_LENGTH,
  RUNNER_RELINK_CODES,
  RunnerWireError,
  USER_CODE_ALPHABET,
  chooseRunnerName,
  dedupeRunnerName,
  formatUserCode,
  normalizeUserCode,
  parseRunnerCapabilities,
  parseRunnerCapabilityReport,
  parseRunnerDeviceLinkPoll,
  parseRunnerDeviceLinkPollRequest,
  parseRunnerDeviceLinkStart,
  parseRunnerDeviceLinkStartRequest,
  parseRunnerHostFacts,
  parseRunnerLinkGrant,
  parseRunnerLinkRequest,
  parseRunnerLocalCredentials,
  parseRunnerTokenGrant,
  parseRunnerTokenRequest,
  readRunnerHttpError,
  runnerIdFromSubject,
  runnerKindForOs,
  runnerNameSlug,
  runnerSubject,
  secretHash,
  type RunnerCapabilities,
} from "./runners";

const CAPABILITIES: RunnerCapabilities = {
  v: 1,
  nodeVersion: "24.18.0",
  cpuCount: 8,
  memTotalMb: 16_384,
  git: { version: "2.43.0" },
  docker: true,
  terminals: "available",
  browser: { state: "available", backend: "chromium" },
  maxConcurrentSessions: 4,
  tools: ["xcode"],
};

const PLATFORM = { os: "linux", distro: "debian 12", kernel: "6.1", arch: "x64", glibc: "2.36" };
const HOST = { hostname: "hetzner-1", platform: PLATFORM, installMode: "user" };

describe("the runner token subject", () => {
  test("round-trips a runner id and refuses anything else", () => {
    const id = newId("runner");
    expect(runnerSubject(id)).toBe(`runner:${id}`);
    expect(runnerIdFromSubject(runnerSubject(id))).toBe(id);
    expect(runnerIdFromSubject(`user:${id}`)).toBeNull();
    expect(runnerIdFromSubject("runner:not-a-uuid")).toBeNull();
  });
});

describe("secrets and device codes", () => {
  test("hashes a secret to lowercase hex SHA-256", () => {
    expect(secretHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("formats and normalizes codes from the twenty-consonant alphabet", () => {
    expect(USER_CODE_ALPHABET).toHaveLength(20);
    expect(formatUserCode("BCDFGHJK")).toBe("BCDF-GHJK");
    expect(normalizeUserCode(" bcdf-ghjk ")).toBe("BCDFGHJK");
    expect(normalizeUserCode("bcdf ghjk")).toBe("BCDFGHJK");
    expect(normalizeUserCode("BCDF-GHJ")).toBeNull();
    expect(normalizeUserCode("BCDF-GHJA")).toBeNull();
  });
});

describe("runner names", () => {
  test("slugs to lowercase letters, digits and dashes, bounded", () => {
    expect(runnerNameSlug("  Build Box!! ")).toBe("build-box");
    expect(runnerNameSlug("--a--b--")).toBe("a-b");
    expect(runnerNameSlug("!!!")).toBeNull();
    const long = runnerNameSlug(`${"a".repeat(RUNNER_NAME_MAX_LENGTH - 1)}-b`);
    expect(long).toBe("a".repeat(RUNNER_NAME_MAX_LENGTH - 1));
  });

  test("chooses --name, then the hint, then the hostname's first label, then a default", () => {
    expect(chooseRunnerName({ name: "Mine", nameHint: "hint", hostname: "h.example" })).toBe(
      "mine",
    );
    expect(chooseRunnerName({ name: "!!", nameHint: "Hint", hostname: "h.example" })).toBe("hint");
    expect(chooseRunnerName({ name: null, nameHint: null, hostname: "box-1.example.com" })).toBe(
      "box-1",
    );
    expect(chooseRunnerName({ hostname: "..." })).toBe("runner");
    expect(chooseRunnerName({})).toBe("runner");
  });

  test("dedupes with a numeric suffix that keeps the bound", () => {
    expect(dedupeRunnerName("box", () => false)).toBe("box");
    const taken = new Set(["box", "box-2"]);
    expect(dedupeRunnerName("box", (name) => taken.has(name))).toBe("box-3");
    const full = "a".repeat(RUNNER_NAME_MAX_LENGTH);
    const deduped = dedupeRunnerName(full, (name) => name === full);
    expect(deduped).toHaveLength(RUNNER_NAME_MAX_LENGTH);
    expect(deduped.endsWith("-2")).toBe(true);
  });

  test("a Mac links as mac, anything else as linux", () => {
    expect(runnerKindForOs("darwin")).toBe("mac");
    expect(runnerKindForOs("linux")).toBe("linux");
  });
});

describe("capability reports", () => {
  test("accepts a full report and both browser arms", () => {
    expect(parseRunnerCapabilities(CAPABILITIES)).toEqual(CAPABILITIES);
    const headless = {
      ...CAPABILITIES,
      git: null,
      browser: { state: "unavailable", reason: "no chromium" },
    };
    expect(parseRunnerCapabilities(headless)).toEqual(headless);
    expect(parseRunnerCapabilities({ ...CAPABILITIES, git: undefined }).git).toBeNull();
  });

  test.each([
    ["a non-object", null],
    ["a list", []],
    ["another version", { ...CAPABILITIES, v: 2 }],
    ["a non-boolean docker", { ...CAPABILITIES, docker: "yes" }],
    ["an unknown terminals state", { ...CAPABILITIES, terminals: "maybe" }],
    ["a negative count", { ...CAPABILITIES, cpuCount: -1 }],
    ["an infinite count", { ...CAPABILITIES, memTotalMb: Number.POSITIVE_INFINITY }],
    ["an empty version", { ...CAPABILITIES, nodeVersion: "" }],
    ["an over-long version", { ...CAPABILITIES, nodeVersion: "x".repeat(256) }],
    ["a non-string tool", { ...CAPABILITIES, tools: [1] }],
    ["an empty tool", { ...CAPABILITIES, tools: [""] }],
    ["too many tools", { ...CAPABILITIES, tools: Array.from({ length: 65 }, (_, n) => `t${n}`) }],
    ["tools that are not a list", { ...CAPABILITIES, tools: "xcode" }],
    ["a browser without its backend", { ...CAPABILITIES, browser: { state: "available" } }],
    ["a git without a version", { ...CAPABILITIES, git: {} }],
  ])("refuses %s", (_label, value) => {
    expect(() => parseRunnerCapabilities(value)).toThrow(RunnerWireError);
  });

  test("local credentials are availability only, bounded", () => {
    expect(
      parseRunnerLocalCredentials([
        { providerId: "anthropic", kind: "subscription" },
        { providerId: "openai", kind: "api_key", expiresAt: 5 },
      ]),
    ).toEqual([
      { providerId: "anthropic", kind: "subscription", expiresAt: null },
      { providerId: "openai", kind: "api_key", expiresAt: 5 },
    ]);
    expect(() => parseRunnerLocalCredentials([{ providerId: "x", kind: "password" }])).toThrow(
      /kind must be one of/,
    );
  });

  test("a whole report", () => {
    const report = {
      version: "0.3.0",
      platform: { os: "darwin", arch: "arm64" },
      installMode: "app",
      capabilities: CAPABILITIES,
      localCredentials: [],
    };
    expect(parseRunnerCapabilityReport(report)).toEqual({
      ...report,
      platform: { os: "darwin", distro: null, kernel: null, arch: "arm64", glibc: null },
    });
    expect(() => parseRunnerCapabilityReport({ ...report, installMode: "root" })).toThrow(
      RunnerWireError,
    );
  });

  test("a wire error is an invalid request", () => {
    const error = new RunnerWireError("bad");
    expect(error).toMatchObject({
      code: "invalid_request",
      name: "RunnerWireError",
      message: "bad",
    });
  });
});

describe("the /runner/* wire", () => {
  test("requests", () => {
    expect(parseRunnerHostFacts(HOST)).toEqual(HOST);
    expect(parseRunnerLinkRequest({ installToken: "vrt_x", host: HOST })).toEqual({
      installToken: "vrt_x",
      host: HOST,
      name: null,
    });
    expect(parseRunnerLinkRequest({ installToken: "vrt_x", host: HOST, name: "n" }).name).toBe("n");
    expect(parseRunnerDeviceLinkStartRequest({ host: HOST })).toEqual({ host: HOST });
    expect(parseRunnerDeviceLinkPollRequest({ requestId: "r", pollSecret: "s" })).toEqual({
      requestId: "r",
      pollSecret: "s",
    });
    const runnerId = newId("runner");
    expect(parseRunnerTokenRequest({ runnerId, credential: "vrc_x" })).toEqual({
      runnerId,
      credential: "vrc_x",
    });
    expect(() => parseRunnerTokenRequest({ runnerId: "nope", credential: "vrc_x" })).toThrow(
      /runnerId/,
    );
    expect(() =>
      parseRunnerLinkRequest({ installToken: "vrt_x", host: { ...HOST, hostname: 1 } }),
    ).toThrow(/hostname/);
  });

  test("replies", () => {
    const runnerId: RunnerId = newId("runner");
    const grant = { runnerId, name: "box", credential: "vrc_x", generation: 1 };
    expect(parseRunnerLinkGrant(grant)).toEqual(grant);
    expect(() => parseRunnerLinkGrant({ ...grant, runnerId: "x" })).toThrow(/runnerId/);
    const started = {
      requestId: "r",
      userCode: "BCDF-GHJK",
      pollSecret: "s",
      intervalMs: 5000,
      expiresAt: 1,
    };
    expect(parseRunnerDeviceLinkStart(started)).toEqual(started);
    expect(parseRunnerDeviceLinkPoll({ status: "pending" })).toEqual({ status: "pending" });
    expect(parseRunnerDeviceLinkPoll({ status: "linked", grant })).toEqual({
      status: "linked",
      grant,
    });
    expect(() => parseRunnerDeviceLinkPoll({ status: "approved" })).toThrow(RunnerWireError);
    const token = {
      token: "a.b.c",
      expiresAt: 2,
      serverTime: 1,
      credential: "vrc_y",
      generation: 2,
    };
    expect(parseRunnerTokenGrant(token)).toEqual(token);
    expect(parseRunnerTokenGrant({ ...token, token: "x".repeat(2_000) }).token).toHaveLength(2_000);
    expect(() => parseRunnerTokenGrant({ ...token, token: "" })).toThrow(/token/);
    expect(() => parseRunnerTokenGrant({ ...token, token: "x".repeat(8_193) })).toThrow(/token/);
  });

  test("errors are read tolerantly, and only ours count", () => {
    expect(readRunnerHttpError({ error: { code: "revoked", message: "gone" } })).toEqual({
      code: "revoked",
      message: "gone",
    });
    expect(readRunnerHttpError({ error: { code: "revoked" } })).toEqual({
      code: "revoked",
      message: "revoked",
    });
    expect(readRunnerHttpError({ error: { code: "teapot" } })).toBeNull();
    expect(readRunnerHttpError({ error: "revoked" })).toBeNull();
    expect(readRunnerHttpError({})).toBeNull();
    expect(readRunnerHttpError(null)).toBeNull();
    // A rate limit is ours (the caller waits for `Retry-After`), never a reason to link again.
    expect(readRunnerHttpError({ error: { code: "rate_limited", message: "slow" } })).toEqual({
      code: "rate_limited",
      message: "slow",
    });
    expect(
      readRunnerHttpError({ error: { code: "preview_access_required", message: "preview" } }),
    ).toEqual({
      code: "preview_access_required",
      message: "preview",
    });
    expect(RUNNER_RELINK_CODES).toEqual(["invalid_credential", "revoked"]);
  });
});
