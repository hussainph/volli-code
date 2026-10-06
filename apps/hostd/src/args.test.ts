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
      listen: null,
      devicesFile: null,
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
      listen: null,
      devicesFile: null,
    });
  });

  // VC-663: the host protocol's address. Loopback only until VC-575.
  it("takes a loopback address for the host protocol", () => {
    for (const [value, listen] of [
      ["127.0.0.1:7420", { host: "127.0.0.1", port: 7420 }],
      ["127.0.0.2:0", { host: "127.0.0.2", port: 0 }],
      ["[::1]:65535", { host: "::1", port: 65535 }],
    ] as const) {
      expect(parseHostdArgs(["--data-dir", "/d", "--listen", value], CWD)).toMatchObject({
        listen,
      });
    }
  });

  it("refuses a --listen that is not a loopback host and port", () => {
    expect(refusal(["--data-dir", "/d", "--listen", "0.0.0.0:7420"])).toBe(
      "--listen binds a loopback address (127.0.0.1, [::1]) only until VC-575, not 0.0.0.0.",
    );
    // A name a resolver could point off the box is not a loopback address.
    expect(refusal(["--data-dir", "/d", "--listen", "localhost:7420"])).toBe(
      "--listen binds a loopback address (127.0.0.1, [::1]) only until VC-575, not localhost.",
    );
    expect(refusal(["--data-dir", "/d", "--listen", "7420"])).toBe(
      "--listen takes <host>:<port>, not 7420.",
    );
    expect(refusal(["--data-dir", "/d", "--listen", "[::1]:70000"])).toBe(
      "--listen's port must be 0–65535, not 70000.",
    );
    expect(refusal(["status", "--data-dir", "/d", "--listen", "127.0.0.1:1"])).toBe(
      "--listen belongs to serving, not to status.",
    );
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

  it("resets credentials for a data directory, confirmed only by --yes", () => {
    expect(parseHostdArgs(["credentials", "reset", "--data-dir", "d"], CWD)).toEqual({
      kind: "credentials-reset",
      dataDir: "/srv/d",
      confirmed: false,
    });
    expect(parseHostdArgs(["credentials", "reset", "--data-dir", "/d", "--yes"], CWD)).toEqual({
      kind: "credentials-reset",
      dataDir: "/d",
      confirmed: true,
    });
    expect(USAGE).toContain("volli-hostd credentials reset --data-dir <dir> [--yes]");
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
    expect(refusal(["--bogus", "80"])).toMatch(/Unknown option '--bogus'/);
    expect(refusal(["--port", "80"])).toMatch(/belong to install, start, enroll and status --json/);
    expect(refusal(["credentials", "--data-dir", "/d"])).toBe(
      "credentials needs an action: reset.",
    );
    expect(refusal(["credentials", "wipe", "--data-dir", "/d"])).toBe("Unknown argument: wipe");
    expect(refusal(["credentials", "reset", "now", "--data-dir", "/d"])).toBe(
      "Unknown argument: now",
    );
    expect(refusal(["credentials", "reset"])).toBe("--data-dir <dir> is required.");
    expect(refusal(["credentials", "reset", "--data-dir", "/d", "--socket", "s"])).toBe(
      "credentials reset takes --data-dir and --yes only.",
    );
    expect(refusal(["--data-dir", "/d", "--yes"])).toBe(
      "--yes belongs to credentials reset or database restore.",
    );
    expect(refusal(["status", "--data-dir", "/d", "--yes"])).toBe(
      "--yes belongs to credentials reset or database restore.",
    );
  });
});

describe("database restore arguments", () => {
  it("resolves the source and requires explicit confirmation", () => {
    for (const yes of [[], ["--yes"]]) {
      expect(
        parseHostdArgs(
          ["database", "restore", "--data-dir", "d", "--from", "backup", "--schema", "59", ...yes],
          CWD,
        ),
      ).toEqual({
        kind: "database-restore",
        dataDir: "/srv/d",
        sourcePath: "/srv/backup",
        schemaVersion: 59,
        confirmed: yes.length > 0,
      });
    }
    expect(USAGE).toContain("volli-hostd database restore");
  });

  it("refuses incomplete actions, bad schemas and flags belonging elsewhere", () => {
    expect(refusal(["database"])).toBe("database needs an action: restore.");
    expect(refusal(["database", "wipe"])).toBe("Unknown argument: wipe");
    expect(refusal(["database", "restore", "extra"])).toBe("Unknown argument: extra");
    expect(refusal(["database", "restore"])).toBe("--data-dir <dir> is required.");
    const base = ["database", "restore", "--data-dir", "d"];
    for (const from of [[], ["--from", ""]])
      expect(refusal([...base, ...from])).toBe("database restore requires --from <file>.");
    for (const schema of [
      [],
      ["--schema", "0"],
      ["--schema=-1"],
      ["--schema", "x"],
      ["--schema", "1.5"],
      ["--schema", "9007199254740992"],
    ])
      expect(refusal([...base, "--from", "b", ...schema])).toBe(
        "database restore requires --schema <N>, a positive integer.",
      );
    for (const flag of ["--socket", "--operators"])
      expect(refusal([...base, flag, "x"])).toBe(
        "database restore takes --data-dir, --from, --schema and --yes only.",
      );
    for (const flag of ["--from", "--schema"])
      expect(refusal(["status", "--data-dir", "d", flag, "x"])).toBe(
        "--from and --schema belong to database restore.",
      );
    expect(refusal([...base, "--for", "alice"])).toBe(
      "--for, --revoke and --service-user belong to operator-token.",
    );
  });
});

// VC-700: the management commands the desktop runs over SSH.
describe("volli-hostd's management commands", () => {
  it("installs, starts, enrolls and reports, each with its own options", () => {
    expect(parseHostdArgs(["install", "--system"], CWD)).toEqual({
      kind: "install",
      mode: "system",
      from: null,
      port: 7420,
      operator: null,
    });
    expect(
      parseHostdArgs(
        ["install", "--system", "--from", "rel", "--port", "7500", "--operator", "alice"],
        CWD,
      ),
    ).toEqual({ kind: "install", mode: "system", from: "/srv/rel", port: 7500, operator: "alice" });
    expect(parseHostdArgs(["install", "--user"], CWD)).toMatchObject({ mode: "user" });
    expect(parseHostdArgs(["start", "--user"], CWD)).toEqual({
      kind: "start",
      mode: "user",
      timeoutMs: 60_000,
    });
    expect(parseHostdArgs(["start", "--system", "--timeout", "5"], CWD)).toMatchObject({
      timeoutMs: 5_000,
    });
    expect(
      parseHostdArgs(["enroll", "--system", "--public-key", "KEY", "--name", "Mac"], CWD),
    ).toEqual({ kind: "enroll", mode: "system", dataDir: null, publicKey: "KEY", name: "Mac" });
    expect(parseHostdArgs(["enroll", "--data-dir", "d", "--public-key", "KEY"], CWD)).toEqual({
      kind: "enroll",
      mode: null,
      dataDir: "/srv/d",
      publicKey: "KEY",
      name: "",
    });
    expect(parseHostdArgs(["status", "--json"], CWD)).toEqual({
      kind: "status-json",
      mode: null,
      dataDir: null,
    });
    expect(parseHostdArgs(["status", "--json", "--user"], CWD)).toMatchObject({ mode: "user" });
    expect(parseHostdArgs(["status", "--json", "--data-dir", "/d"], CWD)).toMatchObject({
      dataDir: "/d",
    });
    expect(USAGE).toContain("volli-hostd install --system|--user");
  });

  it("refuses options that belong elsewhere, and a mode it cannot tell", () => {
    expect(refusal(["install"])).toBe("install needs --system or --user.");
    expect(refusal(["install", "--data-dir", "/d"])).toBe("install needs --system or --user.");
    expect(refusal(["install", "--system", "--user"])).toBe(
      "Name one of --system, --user or --data-dir.",
    );
    expect(refusal(["install", "--system", "extra"])).toBe("Unknown argument: extra");
    expect(refusal(["install", "--user", "--operator", "a"])).toMatch(
      /--operator belongs to install --system/u,
    );
    expect(refusal(["install", "--system", "--port", "0"])).toBe(
      "--port takes a whole number from 1 to 65535.",
    );
    expect(refusal(["install", "--system", "--port", "70000"])).toBe(
      "--port takes a whole number from 1 to 65535.",
    );
    expect(refusal(["install", "--system", "--timeout", "5"])).toBe(
      "--timeout does not belong to install.",
    );
    expect(refusal(["start", "--system", "--timeout", "x"])).toBe(
      "--timeout takes a whole number from 1 to 3600.",
    );
    expect(refusal(["start", "--system", "--port", "1"])).toBe("--port does not belong to start.");
    expect(refusal(["enroll", "--public-key", "K"])).toBe(
      "enroll needs --system, --user or --data-dir <dir>.",
    );
    expect(refusal(["enroll", "--user"])).toBe("enroll needs --public-key <base64url SPKI>.");
    expect(refusal(["enroll", "--user", "--public-key", ""])).toBe(
      "enroll needs --public-key <base64url SPKI>.",
    );
    expect(refusal(["status", "--json", "--name", "x"])).toBe(
      "--name does not belong to status --json.",
    );
    expect(refusal(["status", "--data-dir", "/d", "--system"])).toMatch(
      /belong to install, start, enroll and status --json/u,
    );
  });

  it("takes a root-owned devices file for serving, and nowhere else", () => {
    expect(
      parseHostdArgs(["--data-dir", "/d", "--devices", "/etc/volli-hostd-devices"], CWD),
    ).toMatchObject({ kind: "serve", devicesFile: "/etc/volli-hostd-devices" });
    expect(refusal(["status", "--data-dir", "/d", "--devices", "/x"])).toBe(
      "--devices belongs to serving, not to status.",
    );
    expect(refusal(["--data-dir", "/d", "--devices="])).toBe("--devices takes a file.");
  });

  it("lists and revokes enrolled devices, naming one store", () => {
    const id = "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
    expect(parseHostdArgs(["devices", "list", "--system"], CWD)).toEqual({
      kind: "devices",
      action: "list",
      mode: "system",
      dataDir: null,
      deviceId: null,
    });
    expect(parseHostdArgs(["devices", "revoke", id, "--data-dir", "d"], CWD)).toEqual({
      kind: "devices",
      action: "revoke",
      mode: null,
      dataDir: "/srv/d",
      deviceId: id,
    });
    expect(refusal(["devices"])).toBe("devices needs an action: list or revoke.");
    expect(refusal(["devices", "forget", "--user"])).toBe("Unknown argument: forget");
    expect(refusal(["devices", "list"])).toBe(
      "devices list needs --system, --user or --data-dir <dir>.",
    );
    expect(refusal(["devices", "revoke", "--user"])).toBe(
      "devices revoke needs a device id (a UUID).",
    );
    expect(refusal(["devices", "revoke", "not-a-uuid", "--user"])).toBe(
      "devices revoke needs a device id (a UUID).",
    );
    expect(refusal(["devices", "list", "x", "--user"])).toBe("Unknown argument: x");
    expect(refusal(["devices", "revoke", id, "y", "--user"])).toBe("Unknown argument: y");
    expect(refusal(["devices", "list", "--user", "--name", "x"])).toBe(
      "--name does not belong to devices list.",
    );
  });
});
