/**
 * The operator verifier store (VC-623), against real files. The owner a test
 * trusts is its own uid; production's is root, and `hostd.ts` never takes it
 * from an argument.
 */
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { HostdBootError } from "./boot-error";
import type { HostdLogger } from "./log";
import {
  formatOperators,
  inspectOperatorsFile,
  isOperatorLogin,
  matchOperator,
  mintOperatorToken,
  OPERATOR_TOKEN_PREFIX,
  openOperators,
  operatorVerifier,
  parseOperators,
  type OperatorEntry,
} from "./operators";

const ME = process.getuid!();
let root: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hostd-operators-"));
  file = join(root, "operators");
});

afterEach(() => {
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
});

function entry(login: string, token: string, uid = 1001): OperatorEntry {
  return { login, uid, verifier: operatorVerifier(token), issuedAt: "2026-10-04T00:00:00.000Z" };
}

function write(entries: readonly OperatorEntry[], mode = 0o640): void {
  writeFileSync(file, formatOperators(entries), { mode });
  chmodSync(file, mode);
}

type LogFn = HostdLogger["info"];
function logger() {
  return {
    debug: vi.fn<LogFn>(),
    info: vi.fn<LogFn>(),
    warn: vi.fn<LogFn>(),
    error: vi.fn<LogFn>(),
  };
}

describe("tokens and verifiers", () => {
  it("mints 256 random bits behind a recognisable prefix, never the same twice", () => {
    const token = mintOperatorToken();
    expect(token.startsWith(OPERATOR_TOKEN_PREFIX)).toBe(true);
    expect(Buffer.from(token.slice(OPERATOR_TOKEN_PREFIX.length), "base64url")).toHaveLength(32);
    expect(mintOperatorToken()).not.toBe(token);
  });

  it("keeps only a SHA-256 of the token", () => {
    const verifier = operatorVerifier("volli_op_x");
    expect(verifier).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifier).not.toContain("volli_op_x");
  });

  it("accepts login names and nothing that could split a line", () => {
    expect(isOperatorLogin("alice")).toBe(true);
    expect(isOperatorLogin("svc.ops-1")).toBe(true);
    for (const bad of ["", "-x", "a b", "a\nb", "x".repeat(33)]) {
      expect(isOperatorLogin(bad), bad).toBe(false);
    }
  });
});

describe("the file format", () => {
  it("round-trips, skipping comments and blank lines", () => {
    const entries = [entry("alice", "a"), entry("bob", "b", 1002)];
    expect(parseOperators(`${formatOperators(entries)}\n\n# trailing note\n`)).toEqual(entries);
  });

  it("refuses the whole file over one bad line, naming it", () => {
    const good = `alice 1001 ${operatorVerifier("a")} 2026`;
    for (const [text, message] of [
      [`${good}\nbob 1002 md5:abc 2026`, "line 2 is not"],
      [`bob x ${operatorVerifier("b")} 2026`, "line 1 is not"],
      [`-bob 1 ${operatorVerifier("b")} 2026`, "line 1 is not"],
      [`bob 1 ${operatorVerifier("b")}`, "line 1 is not"],
      [`bob 1 ${operatorVerifier("b")} 2026 extra`, "line 1 is not"],
      [`${good}\nalice 1001 ${operatorVerifier("c")} 2027`, "line 2 names alice a second time"],
    ] as const) {
      expect(() => parseOperators(text), text).toThrow(message);
    }
  });
});

describe("inspectOperatorsFile", () => {
  it("answers absent for no file, and the entries for a safe one", () => {
    expect(inspectOperatorsFile(file, ME)).toEqual({ state: "absent" });
    write([entry("alice", "a")]);
    expect(inspectOperatorsFile(file, ME)).toEqual({ state: "ok", entries: [entry("alice", "a")] });
  });

  it("refuses a file its trusted owner does not own", () => {
    write([]);
    expect(inspectOperatorsFile(file, ME + 1)).toMatchObject({
      state: "unsafe",
      reason: expect.stringContaining(`belongs to uid ${ME}, not to uid ${ME + 1}`),
    });
  });

  it("refuses a file or a directory its group or others can write", () => {
    write([], 0o660);
    expect(inspectOperatorsFile(file, ME)).toMatchObject({
      state: "unsafe",
      reason: expect.stringContaining("(mode 0660)"),
    });
    chmodSync(file, 0o644);
    chmodSync(root, 0o777);
    expect(inspectOperatorsFile(file, ME)).toMatchObject({
      state: "unsafe",
      reason: expect.stringContaining(`its directory ${root} can be written`),
    });
  });

  it("refuses a symlink, an unreadable file and one that does not parse", () => {
    write([]);
    const link = join(root, "link");
    symlinkSync(file, link);
    expect(inspectOperatorsFile(link, ME)).toEqual({
      state: "unsafe",
      reason: `${link} is not a regular file`,
    });

    chmodSync(file, 0o000);
    expect(inspectOperatorsFile(file, ME)).toMatchObject({
      state: "unsafe",
      reason: expect.stringContaining("could not be read"),
    });

    chmodSync(file, 0o600);
    writeFileSync(file, "garbage\n");
    expect(inspectOperatorsFile(file, ME)).toMatchObject({
      state: "unsafe",
      reason: expect.stringContaining("line 1 is not"),
    });
  });

  it("refuses a path it cannot even look at", () => {
    writeFileSync(join(root, "plain"), "");
    const path = join(root, "plain", "operators");
    expect(inspectOperatorsFile(path, ME)).toMatchObject({
      state: "unsafe",
      reason: expect.stringContaining(`${path} could not be read`),
    });
  });
});

describe("matchOperator", () => {
  const entries = [entry("alice", "token-a"), entry("bob", "token-b", 1002)];

  it("finds the login a token was issued to, among every entry", () => {
    expect(matchOperator(entries, "token-b")).toEqual(entries[1]);
    expect(matchOperator(entries, "token-a")).toEqual(entries[0]);
  });

  it("finds nobody for a token it never issued, or one too long to be one", () => {
    expect(matchOperator(entries, "token-c")).toBeNull();
    expect(matchOperator(entries, "x".repeat(257))).toBeNull();
    expect(matchOperator([], "token-a")).toBeNull();
  });
});

describe("openOperators", () => {
  const open = (log = logger(), processUid = 4242) =>
    openOperators({ path: file, trustedOwnerUid: ME, processUid, logger: log });

  it("refuses to boot on an unsafe file, naming the fix", () => {
    write([], 0o666);
    const error = (() => {
      try {
        open();
      } catch (thrown) {
        return thrown;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(HostdBootError);
    expect((error as HostdBootError).reason).toBe("operators");
    expect((error as Error).message).toContain(`sudo chmod go-w ${file}`);
  });

  it("serves with no file, and accepts no token", () => {
    const log = logger();
    const operators = open(log);
    expect(log.info).toHaveBeenCalledWith(
      "no operators file: this host accepts no operator token",
      { operatorsFile: file },
    );
    expect(operators.verify("anything")).toBeNull();
  });

  it("verifies against the file as it is now: issued later, then revoked, then unsafe", () => {
    const log = logger();
    const operators = open(log);

    write([entry("alice", "token-a")]);
    expect(operators.verify("token-a")).toEqual({ login: "alice" });

    write([]);
    expect(operators.verify("token-a")).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      "operator token refused: not issued by this host, or revoked",
    );

    chmodSync(file, 0o666);
    expect(operators.verify("token-a")).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      "operator token refused: the operators file is unsafe",
      expect.objectContaining({ reason: expect.stringContaining("(mode 0666)") }),
    );
    // And no line ever carries the token.
    expect(JSON.stringify([log.warn.mock.calls, log.error.mock.calls])).not.toContain("token-a");
  });

  it("names its operators at boot, and warns when one shares the host's uid", () => {
    write([entry("alice", "a", 1001), entry("svc", "s", 4242)]);
    const log = logger();
    open(log);
    expect(log.info).toHaveBeenCalledWith("operators file read", {
      operatorsFile: file,
      operators: ["alice", "svc"],
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("operator and Sessions are not separated"),
      { operators: ["svc"], uid: 4242 },
    );
  });

  it("warns when the host runs as the file's owner, and stays quiet when separated", () => {
    write([entry("alice", "a", 1001)]);
    const asOwner = logger();
    open(asOwner, ME);
    expect(asOwner.warn).toHaveBeenCalledWith(
      expect.stringContaining("operator and Sessions are not separated"),
      { operators: [], uid: ME },
    );
    const separated = logger();
    open(separated);
    expect(separated.warn).not.toHaveBeenCalled();
  });
});
