import { describe, expect, it } from "vite-plus/test";

import { HostdBootError } from "./boot-error";
import { defaultSocketPath, parseHostdArgs, USAGE } from "./args";

const CWD = "/srv";

function refusal(argv: string[]): string {
  try {
    parseHostdArgs(argv, CWD);
  } catch (error) {
    expect(error).toBeInstanceOf(HostdBootError);
    expect((error as HostdBootError).reason).toBe("usage");
    return (error as Error).message;
  }
  throw new Error("expected a usage refusal");
}

describe("volli-hostd's arguments", () => {
  it("serves a data directory on its default socket", () => {
    expect(parseHostdArgs(["--data-dir", "/var/lib/volli"], CWD)).toEqual({
      kind: "serve",
      dataDir: "/var/lib/volli",
      socketPath: "/var/lib/volli/volli.sock",
      operatorsFile: "/etc/volli-hostd-operators",
    });
    expect(defaultSocketPath("/d")).toBe("/d/volli.sock");
  });

  it("resolves relative paths against the working directory", () => {
    expect(
      parseHostdArgs(
        ["--data-dir=data", "--socket", "run/v.sock", "--operators", "etc/operators"],
        CWD,
      ),
    ).toEqual({
      kind: "serve",
      dataDir: "/srv/data",
      socketPath: "/srv/run/v.sock",
      operatorsFile: "/srv/etc/operators",
    });
  });

  it("treats an empty --socket as the default", () => {
    expect(parseHostdArgs(["--data-dir", "/d", "--socket="], CWD)).toMatchObject({
      socketPath: "/d/volli.sock",
    });
  });

  it("checks status for a data directory", () => {
    expect(parseHostdArgs(["status", "--data-dir", "/d"], CWD)).toEqual({
      kind: "status",
      dataDir: "/d",
    });
  });

  it("treats an empty --operators as the default", () => {
    expect(parseHostdArgs(["--data-dir", "/d", "--operators="], CWD)).toMatchObject({
      operatorsFile: "/etc/volli-hostd-operators",
    });
  });

  it("issues and revokes operator tokens, defaulting the file and the service user", () => {
    expect(parseHostdArgs(["operator-token", "--for", "alice"], CWD)).toEqual({
      kind: "operator-token",
      action: "issue",
      login: "alice",
      operatorsFile: "/etc/volli-hostd-operators",
      serviceUser: "volli",
    });
    expect(
      parseHostdArgs(
        ["operator-token", "--revoke", "alice", "--operators", "ops", "--service-user", "svc"],
        CWD,
      ),
    ).toEqual({
      kind: "operator-token",
      action: "revoke",
      login: "alice",
      operatorsFile: "/srv/ops",
      serviceUser: "svc",
    });
  });

  it("answers help and version before anything else", () => {
    expect(parseHostdArgs(["--help"], CWD)).toEqual({ kind: "help" });
    expect(parseHostdArgs(["-h", "status"], CWD)).toEqual({ kind: "help" });
    expect(parseHostdArgs(["--version"], CWD)).toEqual({ kind: "version" });
    expect(parseHostdArgs(["-v"], CWD)).toEqual({ kind: "version" });
    expect(USAGE).toContain("volli-hostd --data-dir <dir> [--socket <path>]");
    expect(USAGE).toContain("volli-hostd operator-token --for <login>");
  });

  it("refuses what it does not understand", () => {
    expect(refusal([])).toBe("--data-dir <dir> is required.");
    expect(refusal(["--data-dir="])).toBe("--data-dir <dir> is required.");
    expect(refusal(["serve", "--data-dir", "/d"])).toBe("Unknown argument: serve");
    expect(refusal(["status", "extra", "--data-dir", "/d"])).toBe("Unknown argument: extra");
    for (const flag of ["--socket", "--operators"]) {
      expect(refusal(["status", "--data-dir", "/d", flag, "x"])).toBe(
        "status takes --data-dir only: it reads the socket path from the data directory.",
      );
    }
    expect(refusal(["--data-dir", "/d", "--for", "alice"])).toBe(
      "--for, --revoke and --service-user belong to operator-token.",
    );
    expect(refusal(["operator-token", "--data-dir", "/d", "--for", "alice"])).toBe(
      "operator-token takes --for or --revoke, --operators and --service-user only.",
    );
    expect(refusal(["operator-token"])).toBe(
      "operator-token needs exactly one of --for <login> or --revoke <login>.",
    );
    expect(refusal(["operator-token", "--for", "a", "--revoke", "b"])).toBe(
      "operator-token needs exactly one of --for <login> or --revoke <login>.",
    );
    expect(refusal(["operator-token", "extra", "--for", "a"])).toBe("Unknown argument: extra");
    expect(refusal(["--port", "80"])).toMatch(/Unknown option '--port'/);
  });
});
