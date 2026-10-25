import { describe, expect, test } from "vite-plus/test";

import type { ProjectId, UserId, WorkspaceId } from "./ids";
import {
  MAX_SECRET_VALUE_BYTES,
  RunnerSecretSetError,
  canReadSecrets,
  canWriteSecrets,
  isTeamSecretName,
  MAX_SCOPE_BYTES,
  secretBytes,
  exposureReaches,
  parseRunnerSecretSet,
  resolveSecretSet,
  secretLast4,
  secretLayer,
  secretScopeKey,
  secretTargetOf,
  secretValueProblem,
  secretWinners,
  type SecretCandidate,
  type SecretTarget,
} from "./secrets";
import type { MemberRole, MembershipFacts } from "./visibility";

const ws = "00000000-0000-4000-8000-000000000001" as WorkspaceId;
const other = "00000000-0000-4000-8000-000000000002" as WorkspaceId;
const project = "00000000-0000-4000-8000-000000000003" as ProjectId;
const alice = "00000000-0000-4000-8000-00000000000a" as UserId;
const bob = "00000000-0000-4000-8000-00000000000b" as UserId;

function membership(
  role: MemberRole,
  status: MembershipFacts["status"] = "active",
  userId: UserId = alice,
  workspaceId: WorkspaceId = ws,
): MembershipFacts {
  return { workspaceId, userId, role, status };
}

describe("scope keys and layers", () => {
  test.each<[SecretTarget, string, string]>([
    [{ scope: "workspace", workspaceId: ws }, `w:${ws}`, "workspace"],
    [{ scope: "project", projectId: project }, `p:${project}`, "project"],
    [{ scope: "personal", userId: alice, projectId: null }, `u:${alice}`, "personal"],
    [
      { scope: "personal", userId: alice, projectId: project },
      `u:${alice}/p:${project}`,
      "personal_project",
    ],
  ])("%j", (target, key, layer) => {
    expect(secretScopeKey(target)).toBe(key);
    expect(secretLayer(target)).toBe(layer);
    expect(secretTargetOf(target.scope, key)).toEqual(target);
  });

  test.each<[SecretTarget["scope"], string]>([
    ["workspace", `p:${project}`],
    ["project", `w:${ws}`],
    ["personal", `w:${ws}`],
    ["workspace", `w:${alice.toUpperCase()}`],
    ["personal", `u:${alice}/w:${ws}`],
    ["project", "p:"],
  ])("refuses %s %s", (scope, key) => {
    expect(secretTargetOf(scope, key)).toBeNull();
  });
});

const c = (
  name: string,
  layer: SecretCandidate["layer"],
  exposure: SecretCandidate["exposure"] = "session",
) => ({ name, layer, exposure, tag: `${layer}:${name}` });

describe("precedence and exposure", () => {
  test("setup reaches every exposure; a Session only `session`", () => {
    expect(exposureReaches("setup", "setup")).toBe(true);
    expect(exposureReaches("session", "setup")).toBe(true);
    expect(exposureReaches("session", "session")).toBe(true);
    expect(exposureReaches("setup", "session")).toBe(false);
  });

  test("personal-for-project > personal > project > workspace, per name", () => {
    const winners = secretWinners([
      c("A", "workspace"),
      c("A", "project"),
      c("A", "personal"),
      c("A", "personal_project"),
      c("B", "workspace"),
      c("B", "project"),
      c("C", "personal"),
      c("C", "workspace"),
      c("D", "workspace"),
    ]);
    expect(winners.map((w) => w.tag)).toEqual([
      "personal_project:A",
      "project:B",
      "personal:C",
      "workspace:D",
    ]);
  });

  test("the winner's exposure applies; a lower level never shows through", () => {
    const candidates = [
      c("TOKEN", "personal", "setup"),
      c("TOKEN", "project", "session"),
      c("NODE_ENV", "workspace", "session"),
      c("NPM_TOKEN", "project", "setup"),
    ];
    expect(resolveSecretSet(candidates, "session").map((w) => w.tag)).toEqual([
      "workspace:NODE_ENV",
    ]);
    expect(resolveSecretSet(candidates, "setup").map((w) => w.tag)).toEqual([
      "workspace:NODE_ENV",
      "project:NPM_TOKEN",
      "personal:TOKEN",
    ]);
  });

  test("names sort by code unit and an empty set resolves empty", () => {
    expect(
      secretWinners([c("b", "project"), c("B", "project"), c("a", "workspace")]).map((w) => w.name),
    ).toEqual(["B", "a", "b"]);
    expect(resolveSecretSet([], "session")).toEqual([]);
  });
});

describe("who reads and writes", () => {
  const viewer = { userId: alice };
  const workspace: SecretTarget = { scope: "workspace", workspaceId: ws };
  const projectTarget: SecretTarget = { scope: "project", projectId: project };
  const mine: SecretTarget = { scope: "personal", userId: alice, projectId: null };
  const mineHere: SecretTarget = { scope: "personal", userId: alice, projectId: project };
  const bobs: SecretTarget = { scope: "personal", userId: bob, projectId: null };

  test.each<[MemberRole, boolean]>([
    ["owner", true],
    ["admin", true],
    ["member", false],
  ])("a Workspace %s writes Workspace secrets: %s", (role, allowed) => {
    expect(canReadSecrets(viewer, workspace, ws, membership(role))).toBe(true);
    expect(canWriteSecrets(viewer, workspace, ws, membership(role))).toBe(allowed);
    expect(canWriteSecrets(viewer, projectTarget, ws, membership(role))).toBe(true);
  });

  test.each<[string, MembershipFacts | null]>([
    ["suspended", membership("owner", "suspended")],
    ["departed", membership("admin", "left")],
    ["another Workspace's member", membership("owner", "active", alice, other)],
    ["someone else's membership", membership("owner", "active", bob)],
    ["not a member", null],
  ])("%s sees nothing", (_label, facts) => {
    for (const target of [workspace, projectTarget, mineHere]) {
      expect(canReadSecrets(viewer, target, ws, facts)).toBe(false);
      expect(canWriteSecrets(viewer, target, ws, facts)).toBe(false);
    }
  });

  test("personal secrets are the person's alone", () => {
    expect(canReadSecrets(viewer, mine, null, null)).toBe(true);
    expect(canWriteSecrets(viewer, mine, null, null)).toBe(true);
    expect(canWriteSecrets(viewer, mineHere, ws, membership("member"))).toBe(true);
    expect(canReadSecrets(viewer, bobs, null, null)).toBe(false);
    expect(canWriteSecrets(viewer, bobs, ws, membership("owner"))).toBe(false);
    expect(canReadSecrets(viewer, workspace, null, null)).toBe(false);
  });
});

describe("team secret names", () => {
  test.each(["DATABASE_URL", "NPM_TOKEN", "STRIPE_KEY"])("accepts %s", (name) => {
    expect(isTeamSecretName(name)).toBe(true);
  });

  test.each([
    "PATH",
    "HTTPS_PROXY",
    "http_proxy",
    "SOCKS_PROXY",
    "SSL_CERT_FILE",
    "GIT_EDITOR",
    "GIT_DIR",
    "CC",
    "BROWSER",
  ])("refuses %s, which steers someone else's processes", (name) => {
    expect(isTeamSecretName(name)).toBe(false);
  });
});

describe("values", () => {
  test("problems never echo the value", () => {
    expect(secretValueProblem("x")).toBeNull();
    expect(secretValueProblem("")).toMatch(/empty/);
    expect(secretValueProblem("a\0b")).toMatch(/NUL/);
    expect(secretValueProblem("é".repeat(MAX_SECRET_VALUE_BYTES / 2))).toBeNull();
    expect(secretValueProblem("é".repeat(MAX_SECRET_VALUE_BYTES / 2 + 1))).toBe(
      "A value is at most 32 KiB.",
    );
  });

  test("a secret costs its name, `=` and value in UTF-8 bytes", () => {
    expect(secretBytes("A", "é")).toBe(4);
  });

  test("last4 only for long sealed secrets, by character", () => {
    expect(secretLast4("env", "development-environment")).toBeNull();
    expect(secretLast4("secret", "short-secret")).toBeNull();
    expect(secretLast4("secret", "sk-live-0123456789abcd")).toBe("abcd");
    expect(secretLast4("secret", `${"x".repeat(14)}😀🔑`)).toBe("xx😀🔑");
  });
});

describe("parseRunnerSecretSet", () => {
  const sessionId = "00000000-0000-4000-8000-0000000000c1";
  const valid = {
    version: 1,
    claim: { kind: "session", sessionId },
    purpose: "session",
    withheld: null,
    entries: [
      { name: "NODE_ENV", kind: "env", value: "development" },
      { name: "STRIPE_KEY", kind: "secret", value: "sk_test_123" },
    ],
  };

  test("a valid set reads back whole", () => {
    expect(parseRunnerSecretSet(valid)).toEqual(valid);
    const job = { ...valid, claim: { kind: "job", jobId: sessionId }, purpose: "setup" };
    expect(parseRunnerSecretSet(job).claim).toEqual({ kind: "job", jobId: sessionId });
    const optOut = { ...valid, withheld: "runner_opt_out", entries: [] };
    expect(parseRunnerSecretSet(optOut).withheld).toBe("runner_opt_out");
  });

  test.each<[string, unknown]>([
    ["not an object", "nope"],
    ["an array", []],
    ["a newer version", { ...valid, version: 2 }],
    ["no claim", { ...valid, claim: null }],
    ["an unknown claim", { ...valid, claim: { kind: "ticket", ticketId: "x" } }],
    ["a session claim without an id", { ...valid, claim: { kind: "session" } }],
    ["a job claim without an id", { ...valid, claim: { kind: "job" } }],
    ["no purpose", { ...valid, purpose: "snapshot" }],
    ["an unknown withheld reason", { ...valid, withheld: "nope" }],
    ["withheld with entries", { ...valid, withheld: "runner_opt_out" }],
    ["entries not a list", { ...valid, entries: {} }],
    ["a control name", { ...valid, entries: [{ name: "PATH", kind: "env", value: "/x" }] }],
    ["an entry not an object", { ...valid, entries: [null] }],
    ["an unknown kind", { ...valid, entries: [{ name: "A", kind: "file", value: "x" }] }],
    ["a non-string value", { ...valid, entries: [{ name: "A", kind: "env", value: 1 }] }],
    ["an empty value", { ...valid, entries: [{ name: "A", kind: "env", value: "" }] }],
    [
      "a repeated name",
      {
        ...valid,
        entries: [
          { name: "A", kind: "env", value: "1" },
          { name: "A", kind: "secret", value: "2" },
        ],
      },
    ],
  ])("refuses %s", (_label, input) => {
    expect(() => parseRunnerSecretSet(input)).toThrow(RunnerSecretSetError);
  });

  test("refuses a set larger than four scopes can hold", () => {
    const big = "x".repeat(30 * 1024);
    const entries = Array.from({ length: 9 }, (_, i) => ({
      name: `K${i}`,
      kind: "env",
      value: big,
    }));
    expect(9 * 30 * 1024).toBeGreaterThan(4 * MAX_SCOPE_BYTES);
    expect(() => parseRunnerSecretSet({ ...valid, entries })).toThrow(/larger/);
  });

  test("a refusal never echoes a value", () => {
    const leaky = {
      ...valid,
      entries: [{ name: "lower", kind: "secret", value: "hunter2-value" }],
    };
    expect(() => parseRunnerSecretSet(leaky)).toThrow(/^(?!.*hunter2).*$/);
  });
});
