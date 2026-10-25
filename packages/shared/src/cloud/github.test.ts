import { describe, expect, test } from "vite-plus/test";

import {
  GITHUB_FLOW_TTL_MS,
  GITHUB_TOKEN_REFRESH_MARGIN_MS,
  decideGithubMint,
  decideRepoAccess,
  extractGithubEvent,
  formatFlowState,
  githubLeaseFree,
  githubTokenUseUntil,
  parseFlowState,
  parseWebhookSecrets,
  readGithubInstallation,
  readVerifiedGithubEmails,
  type GithubMintFacts,
} from "./github";

const FLOW = "0b6f7a3e-2c4d-4e8f-9a1b-3c5d7e9f1a2b";
const SECRET = "a".repeat(43);

describe("flow state", () => {
  test("round-trips the flow id and secret", () => {
    expect(GITHUB_FLOW_TTL_MS).toBe(600_000);
    expect(parseFlowState(formatFlowState(FLOW, SECRET))).toEqual({ flowId: FLOW, secret: SECRET });
  });

  test.each([
    [undefined],
    [null],
    [""],
    [FLOW],
    [`${FLOW}.short`],
    [`not-a-uuid.${SECRET}`],
    [`${FLOW.toUpperCase()}.${SECRET}`],
    [`${FLOW}.${SECRET}!`],
  ])("refuses %s", (state) => {
    expect(parseFlowState(state)).toBeNull();
  });
});

describe("token mints", () => {
  const now = 1_000_000_000;
  const live: GithubMintFacts = {
    status: "active",
    accessExpiresAt: now + 8 * 3600_000,
    refreshExpiresAt: now + 180 * 86400_000,
    hasTokens: true,
  };

  test("uses a token until 30 minutes before it expires", () => {
    expect(githubTokenUseUntil(live.accessExpiresAt)).toBe(
      live.accessExpiresAt - GITHUB_TOKEN_REFRESH_MARGIN_MS,
    );
    expect(decideGithubMint(live, now)).toBe("use");
    expect(decideGithubMint(live, githubTokenUseUntil(live.accessExpiresAt))).toBe("refresh");
  });

  test("refuses without a usable connection", () => {
    expect(decideGithubMint(null, now)).toBe("not_connected");
    expect(decideGithubMint({ ...live, status: "revoked" }, now)).toBe("not_connected");
    expect(decideGithubMint({ ...live, hasTokens: false }, now)).toBe("not_connected");
    expect(decideGithubMint({ ...live, status: "needs_reconnect" }, now)).toBe("needs_reconnect");
  });

  test("an expired refresh token needs a reconnect", () => {
    expect(decideGithubMint({ ...live, accessExpiresAt: now, refreshExpiresAt: now }, now)).toBe(
      "needs_reconnect",
    );
  });

  test("a lease is free when absent or expired", () => {
    expect(githubLeaseFree(null, now)).toBe(true);
    expect(githubLeaseFree({ until: now }, now)).toBe(true);
    expect(githubLeaseFree({ until: now + 1 }, now)).toBe(false);
  });
});

test("webhook secrets: current then previous, blanks dropped", () => {
  expect(parseWebhookSecrets(" new , old,,")).toEqual(["new", "old"]);
  expect(parseWebhookSecrets(undefined)).toEqual([]);
  expect(parseWebhookSecrets(null)).toEqual([]);
});

describe("decideRepoAccess", () => {
  const live = { deleted: false, suspended: false };
  const repo = { archived: false, deleted: false };
  test.each([
    [{ installation: live, inInstallation: true, repository: repo }, "ok"],
    [
      { installation: live, inInstallation: true, repository: { ...repo, deleted: true } },
      "deleted",
    ],
    [{ installation: null, inInstallation: false, repository: repo }, "app_removed"],
    [
      { installation: { ...live, deleted: true }, inInstallation: true, repository: repo },
      "app_removed",
    ],
    [
      { installation: { ...live, suspended: true }, inInstallation: true, repository: repo },
      "app_removed",
    ],
    [{ installation: live, inInstallation: false, repository: repo }, "not_in_installation"],
    [
      { installation: live, inInstallation: true, repository: { ...repo, archived: true } },
      "archived",
    ],
  ] as const)("%j → %s", (facts, access) => {
    expect(decideRepoAccess(facts)).toBe(access);
  });
});

test("readVerifiedGithubEmails keeps verified addresses only, bounded", () => {
  const emails = [
    { email: "a@x.test", primary: true, verified: true, visibility: "public" },
    { email: "b@x.test", primary: false, verified: false, visibility: null },
    { email: "c@x.test", verified: true, visibility: null },
    { email: "", verified: true },
    "junk",
    { email: "d@x.test", verified: true, visibility: "private" },
  ];
  expect(readVerifiedGithubEmails(emails)).toEqual([
    { email: "a@x.test", primary: true, verified: true, visibility: "public" },
    { email: "c@x.test", primary: false, verified: true, visibility: null },
    { email: "d@x.test", primary: false, verified: true, visibility: "private" },
  ]);
  expect(readVerifiedGithubEmails(emails, 1)).toHaveLength(1);
  expect(readVerifiedGithubEmails({})).toEqual([]);
});

const installation = {
  id: 42,
  account: { id: 7, login: "acme", type: "Organization" },
  repository_selection: "all",
  permissions: { contents: "write", metadata: "read", bogus: 3 },
  events: ["pull_request", 5],
  suspended_at: null,
};

describe("readGithubInstallation", () => {
  test("reads an organization installation", () => {
    expect(readGithubInstallation(installation)).toEqual({
      installationId: "42",
      accountId: "7",
      accountLogin: "acme",
      accountType: "org",
      repositorySelection: "all",
      permissions: { contents: "write", metadata: "read" },
      events: ["pull_request"],
      suspended: false,
    });
  });

  test("reads a suspended user installation with sparse fields", () => {
    expect(
      readGithubInstallation({
        id: "43",
        account: { id: "8", login: "dana", type: "User" },
        suspended_at: "2026-10-25T00:00:00Z",
      }),
    ).toEqual({
      installationId: "43",
      accountId: "8",
      accountLogin: "dana",
      accountType: "user",
      repositorySelection: "selected",
      permissions: {},
      events: [],
      suspended: true,
    });
  });

  test.each([
    [null],
    [[]],
    [{ id: 0, account: { id: 7, login: "acme" } }],
    [{ id: 1.5, account: { id: 7, login: "acme" } }],
    [{ id: "01", account: { id: 7, login: "acme" } }],
    [{ id: 1, account: { id: 7, login: "" } }],
    [{ id: 1, account: { login: "acme" } }],
    [{ id: 1 }],
  ])("refuses %j", (value) => {
    expect(readGithubInstallation(value)).toBeNull();
  });
});

describe("extractGithubEvent", () => {
  test("installation events, with and without a requester", () => {
    expect(
      extractGithubEvent("installation", {
        action: "created",
        installation,
        requester: { id: 99, login: "sam" },
      }),
    ).toMatchObject({ kind: "installation", action: "created", requesterId: "99" });
    expect(
      extractGithubEvent("installation", { action: "deleted", installation, requester: null }),
    ).toMatchObject({ kind: "installation", action: "deleted", requesterId: null });
  });

  test("installation_repositories", () => {
    expect(
      extractGithubEvent("installation_repositories", { action: "removed", installation }),
    ).toMatchObject({ kind: "installation_repositories", action: "removed" });
    expect(
      extractGithubEvent("installation_repositories", { action: "added", installation }),
    ).toMatchObject({ kind: "installation_repositories", action: "added" });
  });

  test("installation_target renames", () => {
    expect(
      extractGithubEvent("installation_target", {
        action: "renamed",
        installation: { id: 42 },
        account: { id: 7, login: "acme-inc" },
      }),
    ).toEqual({
      kind: "installation_target",
      action: "renamed",
      installationId: "42",
      accountLogin: "acme-inc",
    });
  });

  test("repository events, with and without an installation", () => {
    expect(
      extractGithubEvent("repository", {
        action: "renamed",
        repository: { id: 1001 },
        installation: { id: 42 },
      }),
    ).toEqual({
      kind: "repository",
      action: "renamed",
      installationId: "42",
      githubRepoId: "1001",
    });
    expect(
      extractGithubEvent("repository", { action: "deleted", repository: { id: 1001 } }),
    ).toMatchObject({ installationId: null });
  });

  test("an authorization revoke", () => {
    expect(
      extractGithubEvent("github_app_authorization", { action: "revoked", sender: { id: 5 } }),
    ).toEqual({ kind: "github_app_authorization", action: "revoked", githubUserId: "5" });
  });

  test.each([
    ["ping", { zen: "hi" }, null],
    ["push", { action: "x" }, "x"],
    ["installation", { action: "requested", installation }, "requested"],
    ["installation", { action: "created", installation: {} }, "created"],
    ["installation_repositories", { action: "changed", installation }, "changed"],
    ["installation_repositories", { action: "added" }, "added"],
    ["installation_target", { action: "renamed", installation: { id: 42 } }, "renamed"],
    [
      "installation_target",
      { action: "other", installation: { id: 42 }, account: { login: "a" } },
      "other",
    ],
    ["installation_target", { action: "renamed", account: { login: "a" } }, "renamed"],
    ["repository", { action: "starred", repository: { id: 1 } }, "starred"],
    ["repository", { action: "renamed", repository: {} }, "renamed"],
    ["github_app_authorization", { action: "revoked" }, "revoked"],
    ["github_app_authorization", { action: "other", sender: { id: 5 } }, "other"],
  ])("ignores %s %j", (event, payload, action) => {
    expect(extractGithubEvent(event, payload)).toEqual({ kind: "ignored", event, action });
  });

  test("ignores a body that is not an object", () => {
    expect(extractGithubEvent("installation", "nope")).toEqual({
      kind: "ignored",
      event: "installation",
      action: null,
    });
  });
});
