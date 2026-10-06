import { describe, expect, it } from "vite-plus/test";

import {
  expiredHostSignIns,
  hostSignInUpdateIsFinal,
  isSignInRefused,
  normalizeGitHost,
  SignInRefusedError,
  type HostSignInStatus,
} from "./host-sign-ins";

describe("a sign-in flow's updates", () => {
  it("ends on done, failed or cancelled, and on nothing else", () => {
    for (const kind of ["done", "failed", "cancelled"]) {
      expect(hostSignInUpdateIsFinal({ kind })).toBe(true);
    }
    for (const kind of ["auth-url", "device-code", "auth-callback", "prompt", "a-future-kind"]) {
      expect(hostSignInUpdateIsFinal({ kind })).toBe(false);
    }
  });
});

describe("expiredHostSignIns", () => {
  it("names the rows a host-chip badge reads", () => {
    const status: HostSignInStatus = {
      providers: [
        {
          providerId: "anthropic",
          label: "Claude",
          state: "expired",
          kind: "subscription",
          methods: [],
        },
        {
          providerId: "openai",
          label: "ChatGPT",
          state: "signed-in",
          kind: "api-key",
          methods: [],
        },
        { providerId: "xai", label: "xAI", state: "missing", kind: null, methods: [] },
      ],
      git: [{ host: "github.com", state: "signed-in", kind: "git" }],
    };
    // Exactly `HostRecord.expiredSignIns`'s shape (VC-576): a provider and its name.
    expect(expiredHostSignIns(status)).toStrictEqual([{ providerId: "anthropic", name: "Claude" }]);
  });
});

describe("normalizeGitHost", () => {
  it("keys a host name with an optional port, lowercase", () => {
    expect(normalizeGitHost(" GitHub.com ")).toBe("github.com");
    expect(normalizeGitHost("git.example.com:8443")).toBe("git.example.com:8443");
    expect(normalizeGitHost("127.0.0.1:7000")).toBe("127.0.0.1:7000");
  });

  it("refuses anything that is not just a host", () => {
    for (const value of [
      "",
      "   ",
      "https://github.com",
      "user@github.com",
      "github.com/owner/repo",
      "*.github.com",
      "-github.com",
      "github..com",
      `${"a".repeat(250)}.com`,
    ]) {
      expect(normalizeGitHost(value)).toBeNull();
    }
  });
});

describe("SignInRefusedError", () => {
  it("carries its reason and is recognized by its brand alone", () => {
    const error = new SignInRefusedError("sign-in-unknown", "There is no such sign-in.");
    expect(error).toMatchObject({
      name: "SignInRefusedError",
      reason: "sign-in-unknown",
      message: "There is no such sign-in.",
    });
    expect(isSignInRefused(error)).toBe(true);
    expect(isSignInRefused(new Error("sign-in-unknown"))).toBe(false);
    expect(isSignInRefused({ reason: "sign-in-unknown" })).toBe(false);
    expect(isSignInRefused(null)).toBe(false);
    expect(isSignInRefused("sign-in-unknown")).toBe(false);
  });
});
