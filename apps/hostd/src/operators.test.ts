/**
 * The operator verifier store (VC-623), against real files. The owner a test
 * trusts is its own uid; production's is root, and `hostd.ts` never takes it
 * from an argument.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  root = realpathSync(mkdtempSync(join(tmpdir(), "hostd-operators-")));
  file = join(root, "operators");
});

afterEach(() => {
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
});

function entry(login: string, token: string, uid = 4000001): OperatorEntry {
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
    const entries = [entry("alice", "a"), entry("bob", "b", 4000002)];
    expect(parseOperators(`${formatOperators(entries)}\n\n# trailing note\n`)).toEqual(entries);
  });

  it("refuses the whole file over one bad line, naming it", () => {
    const good = `alice 4000001 ${operatorVerifier("a")} 2026`;
    for (const [text, message] of [
      [`${good}\nbob 4000002 md5:abc 2026`, "line 2 is not"],
      [`bob x ${operatorVerifier("b")} 2026`, "line 1 is not"],
      [`-bob 1 ${operatorVerifier("b")} 2026`, "line 1 is not"],
      [`bob 1 ${operatorVerifier("b")}`, "line 1 is not"],
      [`bob 1 ${operatorVerifier("b")} 2026 extra`, "line 1 is not"],
      [`${good}\nalice 4000001 ${operatorVerifier("c")} 2027`, "line 2 names alice a second time"],
    ] as const) {
      expect(() => parseOperators(text), text).toThrow(message);
    }
  });
});

describe("inspectOperatorsFile", () => {
  it("answers absent for no file, and the entries for a safe one", () => {
    expect(inspectOperatorsFile(file, ME)).toEqual({ state: "absent", realPath: file });
    write([entry("alice", "a")]);
    expect(inspectOperatorsFile(file, ME)).toEqual({
      state: "ok",
      realPath: file,
      entries: [entry("alice", "a")],
    });
  });

  it("refuses a file its trusted owner does not own, and a directory chain it does not", () => {
    write([]);
    // The file is checked through its descriptor: owned by ME, trusted is root.
    const asRoot = inspectOperatorsFile(file, 0);
    expect(asRoot).toMatchObject({ state: "unsafe" });
    // Here the directory, which ME owns, is what fails first.
    if (asRoot.state === "unsafe") expect(asRoot.reason).toContain(`${root} belongs to uid ${ME}`);
    // A root-owned chain with a file someone else owns: here, root's own
    // /etc/hosts, judged as if this user were the trusted owner.
    expect(inspectOperatorsFile("/etc/hosts", ME)).toMatchObject({
      state: "unsafe",
      reason: expect.stringContaining(`belongs to uid 0, not to uid ${ME}`),
    });
  });

  it("refuses a file or a directory its group or others can write, unless the directory is sticky", () => {
    write([], 0o660);
    expect(inspectOperatorsFile(file, ME)).toMatchObject({
      state: "unsafe",
      reason: expect.stringContaining("(mode 0660)"),
    });
    chmodSync(file, 0o644);
    chmodSync(root, 0o777);
    expect(inspectOperatorsFile(file, ME)).toMatchObject({
      state: "unsafe",
      reason: expect.stringContaining(`${root} can be written by its group or other users`),
    });
    // Sticky, as /tmp is: nobody else can rename or remove the file in it.
    chmodSync(root, 0o1777);
    expect(inspectOperatorsFile(file, ME)).toMatchObject({ state: "ok" });
  });

  it("follows a symlinked directory once, and reads the real path", () => {
    write([entry("alice", "a")]);
    const alias = join(root, "alias");
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), alias);
    writeFileSync(join(root, "real", "operators"), formatOperators([entry("bob", "b")]));
    expect(inspectOperatorsFile(join(alias, "operators"), ME)).toEqual({
      state: "ok",
      realPath: join(root, "real", "operators"),
      entries: [entry("bob", "b")],
    });
  });

  it("refuses a symlinked file, a directory, an unreadable file and one that does not parse", () => {
    write([]);
    const link = join(root, "link");
    symlinkSync(file, link);
    expect(inspectOperatorsFile(link, ME)).toEqual({
      state: "unsafe",
      reason: `${link} is a symbolic link`,
    });

    mkdirSync(join(root, "dir"));
    expect(inspectOperatorsFile(join(root, "dir"), ME)).toEqual({
      state: "unsafe",
      reason: `${join(root, "dir")} is not a regular file`,
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

  it("refuses a path it cannot open, and a directory it cannot resolve", () => {
    writeFileSync(join(root, "plain"), "");
    const throughFile = join(root, "plain", "operators");
    expect(inspectOperatorsFile(throughFile, ME)).toMatchObject({
      state: "unsafe",
      reason: expect.stringContaining(`${throughFile} could not be read`),
    });
    expect(inspectOperatorsFile(join(root, "missing", "operators"), ME)).toMatchObject({
      state: "unsafe",
      reason: expect.stringContaining(`${join(root, "missing")} could not be resolved`),
    });
  });
});

describe("matchOperator", () => {
  const entries = [entry("alice", "token-a"), entry("bob", "token-b", 4000002)];

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
  const open = (log = logger(), processUid = 4000042) =>
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
    write([entry("alice", "a", 4000001), entry("svc", "s", 4000042)]);
    const log = logger();
    open(log);
    expect(log.info).toHaveBeenCalledWith("operators file read", {
      operatorsFile: file,
      operators: ["alice", "svc"],
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("operator and Sessions are not separated"),
      { operators: ["svc"], uid: 4000042 },
    );
  });

  it("warns when the host runs as the file's owner, and stays quiet when separated", () => {
    write([entry("alice", "a", 4000001)]);
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
