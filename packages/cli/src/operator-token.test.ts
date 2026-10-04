/**
 * The CLI's half of VC-623's precedence rule: an operator token rides only on
 * a request with no Session evidence, and the operator's file is read only
 * then, and only when it is private to the operator.
 */
import { describe, expect, it, vi } from "vite-plus/test";

import type { AgentRequest, AgentResponse } from "@volli/shared";

import { operatorTokenFor, readOperatorTokenFile, untrustedSocketPath } from "./client";
import type { OperatorTokenFileSystem } from "./client";
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

/** A scripted file system of directories, sockets and symlinks. */
type Node = { uid: number; mode: number; socket?: boolean };
const tree = (nodes: Record<string, Node>, links: Record<string, string> = {}, self = 501) => ({
  realpath: async (path: string) => {
    if (!(path in nodes) && !(path in links)) throw new Error("ENOENT");
    return links[path] ?? path;
  },
  stat: async (path: string) => {
    const node = nodes[links[path] ?? path]!;
    return { uid: node.uid, mode: node.mode, isSocket: () => node.socket === true };
  },
  uid: () => self,
});

describe("untrustedSocketPath", () => {
  const rootDirs = { "/": { uid: 0, mode: 0o40755 }, "/run": { uid: 0, mode: 0o40755 } };

  it("trusts a root socket in root's /run, and the caller's own socket", async () => {
    expect(
      await untrustedSocketPath(
        "/run/volli-hostd.sock",
        tree({ ...rootDirs, "/run/volli-hostd.sock": { uid: 0, mode: 0o140660, socket: true } }),
      ),
    ).toBeNull();
    expect(
      await untrustedSocketPath(
        "/tmp/me/v.sock",
        tree({
          "/": { uid: 0, mode: 0o40755 },
          "/tmp": { uid: 0, mode: 0o41777 },
          "/tmp/me": { uid: 501, mode: 0o40700 },
          "/tmp/me/v.sock": { uid: 501, mode: 0o140600, socket: true },
        }),
      ),
    ).toBeNull();
  });

  it("refuses a socket in a directory the service account owns", async () => {
    expect(
      await untrustedSocketPath(
        "/run/volli-hostd/volli.sock",
        tree({
          ...rootDirs,
          "/run/volli-hostd": { uid: 999, mode: 0o40750 },
          "/run/volli-hostd/volli.sock": { uid: 999, mode: 0o140660, socket: true },
        }),
      ),
    ).toBe("/run/volli-hostd/volli.sock belongs to uid 999");
    expect(
      await untrustedSocketPath(
        "/run/volli-hostd/volli.sock",
        tree({
          ...rootDirs,
          "/run/volli-hostd": { uid: 999, mode: 0o40750 },
          "/run/volli-hostd/volli.sock": { uid: 0, mode: 0o140660, socket: true },
        }),
      ),
    ).toBe("/run/volli-hostd belongs to uid 999, who could replace /run/volli-hostd/volli.sock");
  });

  it("refuses a group-writable directory, a missing path and a non-socket", async () => {
    expect(
      await untrustedSocketPath(
        "/run/s",
        tree({
          "/": { uid: 0, mode: 0o40755 },
          "/run": { uid: 0, mode: 0o40775 },
          "/run/s": { uid: 0, mode: 0o140600, socket: true },
        }),
      ),
    ).toBe("/run can be written by its group or other users, who could replace /run/s");
    expect(await untrustedSocketPath("/nope", tree(rootDirs))).toBe("/nope could not be resolved");
    expect(
      await untrustedSocketPath(
        "/run/f",
        tree({ ...rootDirs, "/run/f": { uid: 0, mode: 0o100600 } }),
      ),
    ).toBe("/run/f is not a socket");
  });

  it("judges the path as typed as well as the one it resolves to", async () => {
    // /home/svc/link -> /run/volli-hostd.sock: the target is root's, but the
    // service account could repoint the link.
    expect(
      await untrustedSocketPath(
        "/home/svc/link",
        tree(
          {
            ...rootDirs,
            "/home": { uid: 0, mode: 0o40755 },
            "/home/svc": { uid: 999, mode: 0o40755 },
            "/run/volli-hostd.sock": { uid: 0, mode: 0o140660, socket: true },
          },
          { "/home/svc/link": "/run/volli-hostd.sock" },
        ),
      ),
    ).toBe("/home/svc belongs to uid 999, who could replace /home/svc/link");
  });

  it("trusts only root where the platform has no uid", async () => {
    expect(
      await untrustedSocketPath(
        "/run/s",
        tree(
          { ...rootDirs, "/run/s": { uid: 501, mode: 0o140600, socket: true } },
          {},
          null as unknown as number,
        ),
      ),
    ).toBe("/run/s belongs to uid 501");
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
