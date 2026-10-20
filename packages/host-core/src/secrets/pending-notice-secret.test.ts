import { describe, expect, it } from "vite-plus/test";
import { pendingNoticeSecretStart } from "./pending-notice-secret";

describe("live notice credential prefixes", () => {
  it.each([
    ["ready https://alice:opaque-value", 14],
    ["https://alice", 8],
    ["ready eyJheader.payload", 6],
    ["ready eyJheader", 6],
    ["ready AKIA012345", 6],
    ["ready ASIA012345", 6],
    ["ready https://eyJheader", 14],
    ["safe-eyJheader", 5],
  ])("withholds a potentially unfinished credential in %s", (text, start) => {
    expect(pendingNoticeSecretStart(text)).toBe(start);
  });

  it.each([
    "ready",
    "",
    "ready\n",
    "https://",
    "https://example.test/path",
    "https://example.test\n",
    "eyJheader.payload\n",
    "aeyJheader",
    "aAKIA012345",
    "ready eyJheader!",
    "ready AKIA012345!",
  ])("leaves a complete noncredential context alone: %s", (text) => {
    expect(pendingNoticeSecretStart(text)).toBeNull();
  });

  it("scans a repetitive near miss without retries from every prefix", () => {
    const text = `${"eyJ-".repeat(50_000)}!`;
    expect(pendingNoticeSecretStart(text)).toBeNull();
    expect(pendingNoticeSecretStart(text.slice(0, -1))).toBe(0);
  });
});
