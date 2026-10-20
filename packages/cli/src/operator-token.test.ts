/**
 * The CLI's half of VC-623's precedence rule: an operator token rides only on
 * a request with no Session evidence, and the operator's file is read only
 * then, and only when it is private to the operator.
 */
import { describe, expect, it, vi } from "vite-plus/test";

import type { AgentRequest, AgentResponse } from "@volli/shared";

import { operatorTokenFor, readOperatorTokenFile, untrustedSocketPath } from "./client";
import type { OperatorTokenFileRead, OperatorTokenFileSystem } from "./client";
import { runCli } from "./run";

/** A stat answer for a token file. */
const file = (overrides: Partial<{ isFile: boolean; mode: number; uid: number }> = {}) => ({
  isFile: () => overrides.isFile ?? true,
  mode: overrides.mode ?? 0o100600,
  uid: overrides.uid ?? 501,
});
/** A scripted file system around one stat and one read. */
const fs = (
  stat: ReturnType<typeof file> | null,
  text: string | null = "volli_op_abc\n",
  uid: number | null = 501,
): OperatorTokenFileSystem => ({
  lstat: async () => {
    if (stat === null) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return stat;
  },
  readFile: async () => {
    if (text === null) throw new Error("EACCES");
    return text;
  },
  uid: () => uid,
});

/** One `volli ticket create`, answering with the request environment it sent. */
const invoke = async (
  env: Record<string, string>,
  readOperatorToken?: () => Promise<{ token: string } | { warning: string } | null>,
) => {
  const requests: AgentRequest[] = [];
  const stderr: string[] = [];
  const code = await runCli(["ticket", "create", "--title", "Over SSH"], {
    env: { VOLLI_SOCKET: "/socket", ...env },
    cwd: "/work",
    stdout: () => undefined,
    stderr: (text) => stderr.push(text),
    readText: async () => "",
    observe: async () => ({}),
    request: async (_socket, request): Promise<AgentResponse> => {
      requests.push(request);
      return { v: 1, ok: true, data: {} };
    },
    launch: async () => ({ alreadyRunning: true }),
    ...(readOperatorToken === undefined ? {} : { readOperatorToken }),
  });
  return { code, env: requests[0]!.ctx.env, stderr: stderr.join("") };
};

/** A socket the CLI found nothing wrong with. */
const trustedSocket = async (): Promise<string | null> => null;

describe("operatorTokenFor", () => {
  it("sends none beside a Session token or a Session claim, and never reads the file", async () => {
    const readFile = vi.fn(async () => ({ token: "from-file" }));
    for (const env of [
      { VOLLI_SESSION_TOKEN: "session-token", VOLLI_OPERATOR_TOKEN: "op" },
      { VOLLI_SESSION: "session-1", VOLLI_OPERATOR_TOKEN: "op" },
      // Present but empty still counts: a Session environment, however broken.
      { VOLLI_SESSION_TOKEN: "" },
    ]) {
      expect(await operatorTokenFor(env, readFile, trustedSocket), JSON.stringify(env)).toEqual({});
    }
    expect(readFile).not.toHaveBeenCalled();
  });

  it("prefers the exported variable to the file", async () => {
    const readFile = vi.fn(async () => ({ token: "from-file" }));
    expect(
      await operatorTokenFor({ VOLLI_OPERATOR_TOKEN: " exported \n" }, readFile, trustedSocket),
    ).toEqual({
      token: "exported",
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("falls back to the file, passing on its token, its warning, or nothing", async () => {
    expect(
      await operatorTokenFor(
        { VOLLI_OPERATOR_TOKEN: "" },
        async () => ({ token: "f" }),
        trustedSocket,
      ),
    ).toEqual({ token: "f" });
    expect(
      await operatorTokenFor({}, async () => ({ warning: "careful\n" }), trustedSocket),
    ).toEqual({
      warning: "careful\n",
    });
    expect(await operatorTokenFor({}, async () => null, trustedSocket)).toEqual({});
  });

  it("sends nothing to a socket whose name it cannot trust, and says why", async () => {
    const fault = vi.fn(async () => "/run/x belongs to uid 999");
    expect(await operatorTokenFor({ VOLLI_OPERATOR_TOKEN: "op" }, async () => null, fault)).toEqual(
      {
        warning: "volli: not sending the operator token: /run/x belongs to uid 999.\n",
      },
    );
    // And never asks when there is no token to protect.
    const unasked = vi.fn(async () => null);
    await operatorTokenFor({}, async () => null, unasked);
    expect(unasked).not.toHaveBeenCalled();
  });
});

/** One entry in a scripted file system: a directory, a socket, a file, or a symlink. */
type Entry = { uid: number; mode: number; link?: string };

/**
 * A scripted file system. `realpath` follows `link`s one level at a time and
 * `lstat` never does, as the real calls behave.
 */
function tree(entries: Record<string, Entry>, self: number | null = 501) {
  const resolve = (path: string): string => {
    const entry = entries[path];
    if (entry === undefined) throw new Error("ENOENT");
    return entry.link === undefined ? path : resolve(entry.link);
  };
  return {
    realpath: async (path: string) => resolve(path),
    lstat: async (path: string) => {
      const entry = entries[path];
      if (entry === undefined) throw new Error("ENOENT");
      const type = entry.link === undefined ? entry.mode & 0o170000 : 0o120000;
      return {
        uid: entry.uid,
        mode: entry.mode,
        isSocket: () => type === 0o140000,
        isDirectory: () => type === 0o040000,
      };
    },
    uid: () => self,
  };
}

const DIR = 0o40755;
const ROOT_DIRS: Record<string, Entry> = {
  "/": { uid: 0, mode: DIR },
  "/run": { uid: 0, mode: DIR },
  "/tmp": { uid: 0, mode: 0o41777 },
  "/run/volli-hostd.sock": { uid: 0, mode: 0o140660 },
};

describe("untrustedSocketPath", () => {
  it("trusts a root socket in root's /run, and the caller's own socket", async () => {
    expect(await untrustedSocketPath("/run/volli-hostd.sock", tree(ROOT_DIRS))).toBeNull();
    expect(
      await untrustedSocketPath(
        "/tmp/me/v.sock",
        tree({
          ...ROOT_DIRS,
          "/tmp/me": { uid: 501, mode: 0o40700 },
          "/tmp/me/v.sock": { uid: 501, mode: 0o140600 },
        }),
      ),
    ).toBeNull();
  });

  it("trusts a symlink root or the caller owns, even in sticky /tmp", async () => {
    for (const owner of [0, 501]) {
      expect(
        await untrustedSocketPath(
          "/tmp/volli.sock",
          tree({
            ...ROOT_DIRS,
            "/tmp/volli.sock": { uid: owner, mode: 0o120777, link: "/run/volli-hostd.sock" },
          }),
        ),
      ).toBeNull();
    }
  });

  it("refuses a symlink the service account owns, though sticky /tmp and the target are root's", async () => {
    // The Session could repoint its own link between this check and the
    // connect, sending the token to an impostor.
    expect(
      await untrustedSocketPath(
        "/tmp/volli.sock",
        tree({
          ...ROOT_DIRS,
          "/tmp/volli.sock": { uid: 999, mode: 0o120777, link: "/run/volli-hostd.sock" },
        }),
      ),
    ).toBe("/tmp/volli.sock belongs to uid 999, who could replace /tmp/volli.sock");
  });

  it("refuses a symlinked directory the service account owns anywhere on the typed path", async () => {
    expect(
      await untrustedSocketPath(
        "/home/svc/run/volli-hostd.sock",
        tree({
          ...ROOT_DIRS,
          "/home": { uid: 0, mode: DIR },
          "/home/svc": { uid: 0, mode: DIR },
          "/home/svc/run": { uid: 999, mode: 0o120777, link: "/run" },
          "/home/svc/run/volli-hostd.sock": {
            uid: 0,
            mode: 0o140660,
            link: "/run/volli-hostd.sock",
          },
        }),
      ),
    ).toBe("/home/svc/run belongs to uid 999, who could replace /home/svc/run/volli-hostd.sock");
  });

  it("refuses a socket, or a directory, the service account owns", async () => {
    expect(
      await untrustedSocketPath(
        "/run/volli-hostd/volli.sock",
        tree({
          ...ROOT_DIRS,
          "/run/volli-hostd": { uid: 0, mode: 0o40750 },
          "/run/volli-hostd/volli.sock": { uid: 999, mode: 0o140660 },
        }),
      ),
    ).toBe(
      "/run/volli-hostd/volli.sock belongs to uid 999, who could replace /run/volli-hostd/volli.sock",
    );
    expect(
      await untrustedSocketPath(
        "/run/volli-hostd/volli.sock",
        tree({
          ...ROOT_DIRS,
          "/run/volli-hostd": { uid: 999, mode: 0o40750 },
          "/run/volli-hostd/volli.sock": { uid: 0, mode: 0o140660 },
        }),
      ),
    ).toBe("/run/volli-hostd belongs to uid 999, who could replace /run/volli-hostd/volli.sock");
  });

  it("refuses a group-writable directory, a missing path and a non-socket", async () => {
    expect(
      await untrustedSocketPath(
        "/run/volli-hostd.sock",
        tree({ ...ROOT_DIRS, "/run": { uid: 0, mode: 0o40775 } }),
      ),
    ).toBe(
      "/run can be written by its group or other users, who could replace /run/volli-hostd.sock",
    );
    expect(await untrustedSocketPath("/nope", tree(ROOT_DIRS))).toBe("/nope could not be resolved");
    expect(
      await untrustedSocketPath(
        "/run/f",
        tree({ ...ROOT_DIRS, "/run/f": { uid: 0, mode: 0o100600 } }),
      ),
    ).toBe("/run/f is not a socket");
  });

  it("trusts only root where the platform has no uid", async () => {
    expect(
      await untrustedSocketPath(
        "/run/s",
        tree({ ...ROOT_DIRS, "/run/s": { uid: 501, mode: 0o140600 } }, null),
      ),
    ).toBe("/run/s belongs to uid 501, who could replace /run/s");
  });
});

describe("readOperatorTokenFile", () => {
  it("reads a private file the caller owns", async () => {
    expect(await readOperatorTokenFile("/home/a/t", fs(file()))).toEqual({ token: "volli_op_abc" });
    // A platform with no uid judges by mode alone.
    expect(await readOperatorTokenFile("/home/a/t", fs(file({ uid: 0 }), "x", null))).toEqual({
      token: "x",
    });
  });

  it("is nothing when the file is missing, unreadable or empty", async () => {
    expect(await readOperatorTokenFile("/home/a/t", fs(null))).toBeNull();
    expect(await readOperatorTokenFile("/home/a/t", fs(file(), null))).toBeNull();
    expect(await readOperatorTokenFile("/home/a/t", fs(file(), "  \n"))).toBeNull();
  });

  it("refuses a file others can read, another user owns, or that is not a file", async () => {
    for (const stat of [file({ mode: 0o100644 }), file({ uid: 0 }), file({ isFile: false })]) {
      expect(await readOperatorTokenFile("/home/a/t", fs(stat))).toEqual({
        warning: expect.stringContaining("chmod 600 /home/a/t"),
      });
    }
  });
});

describe("runCli with an operator token", () => {
  it("sends the file's token from an operator's shell", async () => {
    const { code, env } = await invoke({}, async () => ({ token: "volli_op_abc" }));
    expect(code).toBe(0);
    expect(env).toEqual({ socket: "/socket", operatorToken: "volli_op_abc" });
  });

  it("sends exactly what a Session sent before, whatever the operator's file holds", async () => {
    const readOperatorToken = vi.fn(async () => ({ token: "volli_op_abc" }));
    const { env } = await invoke(
      { VOLLI_SESSION: "s-1", VOLLI_SESSION_TOKEN: "t-1", VOLLI_OPERATOR_TOKEN: "op" },
      readOperatorToken,
    );
    expect(env).toEqual({ socket: "/socket", session: "s-1", token: "t-1" });
    expect(readOperatorToken).not.toHaveBeenCalled();
  });

  it("warns about an unsafe file and sends nothing from it", async () => {
    const { env, stderr } = await invoke({}, async () => ({ warning: "volli: not using it\n" }));
    expect(env).toEqual({ socket: "/socket" });
    expect(stderr).toBe("volli: not using it\n");
  });

  it("asks about the socket it would send to, and sends nothing to an untrusted one", async () => {
    const requests: AgentRequest[] = [];
    const stderr: string[] = [];
    const asked: string[] = [];
    await runCli(["project", "add", "/srv/acme"], {
      env: { VOLLI_SOCKET: "/run/volli-hostd/volli.sock" },
      cwd: "/work",
      stdout: () => undefined,
      stderr: (text) => stderr.push(text),
      readText: async () => "",
      observe: async () => ({}),
      request: async (_socket, request): Promise<AgentResponse> => {
        requests.push(request);
        return { v: 1, ok: true, data: {} };
      },
      launch: async () => ({ alreadyRunning: true }),
      readOperatorToken: async () => ({ token: "volli_op_abc" }),
      socketPathFault: async (path) => {
        asked.push(path);
        return "/run/volli-hostd belongs to uid 999, who could replace it";
      },
    });
    expect(asked).toEqual(["/run/volli-hostd/volli.sock"]);
    expect(requests[0]!.ctx.env).toEqual({ socket: "/run/volli-hostd/volli.sock" });
    expect(stderr.join("")).toContain("not sending the operator token");
  });

  it("sends none when no reader is wired", async () => {
    const { env } = await invoke({});
    expect(env).toEqual({ socket: "/socket" });
  });
});

async function startOperatorSession(
  env: Record<string, string | undefined>,
  readToken?: () => Promise<OperatorTokenFileRead>,
  fault?: string | null,
) {
  const request = vi.fn(async (): Promise<AgentResponse> => ({ v: 1, ok: true, data: {} }));
  const stderr: string[] = [];
  const code = await runCli(["session", "start", "VC-1", "-m", "hello", "--json"], {
    env,
    cwd: "/work",
    stdout: () => {},
    stderr: (text) => stderr.push(text),
    readText: async () => "",
    observe: async () => ({}),
    request,
    launch: async () => ({ alreadyRunning: true }),
    ...(readToken === undefined ? {} : { readOperatorToken: readToken }),
    ...(fault === undefined ? {} : { socketPathFault: async () => fault }),
  });
  return { code, request, stderr: stderr.join("") };
}

describe("the operator-only Session start door", () => {
  it("keeps the no-reader fallback refused and accepts the operator environment without a file", async () => {
    expect((await startOperatorSession({ VOLLI_SOCKET: "/socket" })).stderr).toContain(
      "WRONG_DOOR",
    );
    expect(
      (await startOperatorSession({ VOLLI_SOCKET: "/socket", VOLLI_OPERATOR_TOKEN: "op" })).code,
    ).toBe(0);
  });
  it("routes with a private operator token, read exactly once", async () => {
    const readToken = vi.fn(async () => ({ token: "op" }));
    const result = await startOperatorSession({ VOLLI_SOCKET: "/socket" }, readToken);
    expect(result.code).toBe(0);
    expect(readToken).toHaveBeenCalledTimes(1);
    expect(result.request).toHaveBeenCalledWith(
      "/socket",
      expect.objectContaining({
        cmd: "session.start",
        args: { id: "VC-1", message: "hello" },
        ctx: { cwd: "/work", env: { socket: "/socket", operatorToken: "op" } },
      }),
    );
  });
  it.each([
    {},
    { VOLLI_SOCKET: "/socket" },
    { VOLLI_SOCKET: "/socket", VOLLI_SESSION: "s", VOLLI_OPERATOR_TOKEN: "op" },
    { VOLLI_SOCKET: "/socket", VOLLI_SESSION_TOKEN: "s", VOLLI_OPERATOR_TOKEN: "op" },
  ])("keeps ordinary and Session callers refused: %j", async (env) => {
    const readToken = vi.fn(async () => null);
    const result = await startOperatorSession(env, readToken);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("WRONG_DOOR");
    expect(
      result.request.mock.calls.every(
        (call) => (call as unknown as [string, AgentRequest])[1].cmd !== "session.start",
      ),
    ).toBe(true);
    if (env["VOLLI_SESSION"] || env["VOLLI_SESSION_TOKEN"] || !env["VOLLI_SOCKET"])
      expect(readToken).not.toHaveBeenCalled();
  });
  it("keeps the token home at an untrusted socket, and reports why", async () => {
    const result = await startOperatorSession(
      { VOLLI_SOCKET: "/socket", VOLLI_OPERATOR_TOKEN: "op" },
      vi.fn(async () => null),
      "unsafe socket",
    );
    expect(result.stderr).toContain("not sending the operator token");
    expect(result.stderr).toContain("WRONG_DOOR");
    expect(
      result.request.mock.calls.every(
        (call) => (call as unknown as [string, AgentRequest])[1].cmd !== "session.start",
      ),
    ).toBe(true);
  });
});
