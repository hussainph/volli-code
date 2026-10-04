/**
 * `volli-hostd operator-token` (VC-623): issue and revoke, against real files.
 *
 * "Root" here is the test's own uid: the command's rule is that the caller IS
 * the operators file's owner, and production names 0 for both. The real
 * writer and lookup run too, as this user, into a temporary home.
 */
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  EXIT_NOPERM,
  lookupSystemUser,
  runOperatorToken,
  writeTokenAsUser,
  type OperatorTokenCommand,
  type OperatorTokenPorts,
  type SystemUser,
} from "./operator-token";
import { inspectOperatorsFile, matchOperator, OPERATOR_TOKEN_PREFIX } from "./operators";

const ME = process.getuid!();
const MY_GID = process.getgid!();
let root: string;
let operatorsFile: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hostd-operator-token-")));
  operatorsFile = join(root, "operators");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ALICE: SystemUser = { login: "alice", uid: 1001, gid: 1001 };
const SERVICE: SystemUser = { login: "volli", uid: 999, gid: MY_GID };

function setup(overrides: Partial<OperatorTokenPorts> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const written: Array<{ user: SystemUser; token: string }> = [];
  const users: Record<string, SystemUser> = { alice: ALICE, volli: SERVICE };
  const ports: OperatorTokenPorts = {
    uid: () => ME,
    rootUid: ME,
    lookupUser: (login) => users[login] ?? null,
    writeTokenAsUser: (user, token) => {
      written.push({ user, token });
      return `/home/${user.login}/.config/volli/operator-token`;
    },
    now: () => new Date("2026-10-04T12:00:00.000Z"),
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    ...overrides,
  };
  const run = (command: Partial<OperatorTokenCommand> = {}) =>
    runOperatorToken(
      {
        kind: "operator-token",
        action: "issue",
        login: "alice",
        operatorsFile,
        serviceUser: "volli",
        ...command,
      },
      ports,
    );
  return { run, out, err, written };
}

function entries() {
  const state = inspectOperatorsFile(operatorsFile, ME);
  if (state.state !== "ok") throw new Error(`operators file is ${state.state}`);
  return state.entries;
}

describe("issuing", () => {
  it("writes the token as the operator, and only its verifier to the root-owned file", () => {
    const { run, out, written } = setup();

    expect(run()).toBe(0);

    expect(written).toHaveLength(1);
    const [{ user, token }] = written as [{ user: SystemUser; token: string }];
    expect(user).toEqual(ALICE);
    expect(token.startsWith(OPERATOR_TOKEN_PREFIX)).toBe(true);
    // The file holds a hash: never the token.
    expect(readFileSync(operatorsFile, "utf8")).not.toContain(token);
    expect(matchOperator(entries(), token)).toMatchObject({ login: "alice", uid: 1001 });
    expect(entries()[0]!.issuedAt).toBe("2026-10-04T12:00:00.000Z");
    // Root's, readable by the service's group, written by nobody else.
    const stat = statSync(operatorsFile);
    expect(stat.uid).toBe(ME);
    expect(stat.gid).toBe(SERVICE.gid);
    expect(stat.mode & 0o777).toBe(0o640);
    expect(out.join("")).toContain("sudo usermod -aG volli alice");
  });

  it("replaces a login's token on reissue, so the old one stops working", () => {
    const { run, written } = setup();
    run();
    run();
    expect(entries()).toHaveLength(1);
    expect(matchOperator(entries(), written[0]!.token)).toBeNull();
    expect(matchOperator(entries(), written[1]!.token)).toMatchObject({ login: "alice" });
  });

  it("is root's alone", () => {
    const { run, err, written } = setup({ uid: () => ME + 1 });
    expect(run()).toBe(EXIT_NOPERM);
    expect(err.join("")).toContain("run it as root (sudo)");
    expect(written).toEqual([]);
  });

  it("never issues to the service account, by name or by uid", () => {
    const { run, err, written } = setup({
      lookupUser: (login) =>
        login === "svc-alias" ? { ...SERVICE, login } : login === "volli" ? SERVICE : null,
    });
    expect(run({ login: "volli" })).toBe(1);
    expect(run({ login: "svc-alias" })).toBe(1);
    expect(err.join("")).toContain("is the service account hostd and every Session run as");
    expect(written).toEqual([]);
  });

  it("refuses a name that is not a login, and a login the host does not have", () => {
    const { run, err } = setup();
    expect(run({ login: "a b" })).toBe(1);
    expect(run({ login: "nobody-here" })).toBe(1);
    expect(err.join("")).toContain('"a b" is not a login name');
    expect(err.join("")).toContain("no user named nobody-here");
  });

  it("refuses to write into an operators file that is already unsafe", () => {
    writeFileSync(operatorsFile, "", { mode: 0o666 });
    chmodSync(operatorsFile, 0o666);
    const { run, err, written } = setup();
    expect(run()).toBe(1);
    expect(err.join("")).toContain("not writing to it");
    expect(written).toEqual([]);
  });

  it("records no verifier when the token file could not be written", () => {
    const { run, err } = setup({
      writeTokenAsUser: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    expect(run()).toBe(1);
    expect(err.join("")).toContain("could not write alice's token file: EACCES");
    expect(inspectOperatorsFile(operatorsFile, ME)).toMatchObject({ state: "absent" });
  });

  it("says when there is no service account to check against, and writes the file world-readable", () => {
    const { run, err } = setup({ lookupUser: (login) => (login === "alice" ? ALICE : null) });
    expect(run({ serviceUser: "svc" })).toBe(0);
    expect(err.join("")).toContain("no service account named svc");
    expect(statSync(operatorsFile).mode & 0o777).toBe(0o644);
  });
});

describe("revoking", () => {
  it("removes the login's verifier and keeps everyone else's", () => {
    const users: Record<string, SystemUser> = {
      alice: ALICE,
      bob: { login: "bob", uid: 1002, gid: 1002 },
      volli: SERVICE,
    };
    const { run, out, written } = setup({ lookupUser: (login) => users[login] ?? null });
    run();
    run({ login: "bob" });

    expect(run({ action: "revoke" })).toBe(0);

    expect(entries().map((entry) => entry.login)).toEqual(["bob"]);
    expect(matchOperator(entries(), written[0]!.token)).toBeNull();
    expect(out.join("")).toContain("Revoked alice's operator token");
  });

  it("is a no-op for a login that holds none", () => {
    const { run, out } = setup();
    expect(run({ action: "revoke" })).toBe(0);
    expect(out.join("")).toContain("alice holds no operator token");
  });
});

describe("the system ports", () => {
  it("looks a login up in the password database", () => {
    const me = lookupSystemUser(userInfo().username);
    expect(me).toEqual({ login: userInfo().username, uid: ME, gid: MY_GID });
    expect(lookupSystemUser("volli-no-such-user-623")).toBeNull();
  });

  it("writes the token as the user, private to them, and returns its path", () => {
    const home = join(root, "home");
    const user = { login: userInfo().username, uid: ME, gid: MY_GID };

    const path = writeTokenAsUser(user, "volli_op_abc", home);

    expect(path).toBe(join(home, ".config", "volli", "operator-token"));
    expect(readFileSync(path, "utf8")).toBe("volli_op_abc\n");
    // A second issue replaces it in place.
    writeTokenAsUser(user, "volli_op_def", home);
    expect(readFileSync(path, "utf8")).toBe("volli_op_def\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".config", "volli")).mode & 0o777).toBe(0o700);
  });

  it("reports the child's failure as a sentence, and a refused spawn as itself", () => {
    const user = { login: userInfo().username, uid: ME, gid: MY_GID };
    const blocker = join(root, "not-a-dir");
    writeFileSync(blocker, "");
    expect(() => writeTokenAsUser(user, "volli_op_abc", blocker)).toThrow(/ENOTDIR|EEXIST/);

    // Becoming another user takes root; as anyone else the spawn itself fails.
    const spawnRefused = vi.fn(() => writeTokenAsUser({ ...user, uid: ME + 1 }, "t", root));
    expect(spawnRefused).toThrow(/EPERM/);
  });
});
