/**
 * The CLI's half of VC-623's precedence rule: an operator token rides only on
 * a request with no Session evidence, and the operator's file is read only
 * then, and only when it is private to the operator.
 */
import { describe, expect, it, vi } from "vite-plus/test";

import type { AgentRequest, AgentResponse } from "@volli/shared";

import { operatorTokenFor, readOperatorTokenFile } from "./client";
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

describe("operatorTokenFor", () => {
  it("sends none beside a Session token or a Session claim, and never reads the file", async () => {
    const readFile = vi.fn(async () => ({ token: "from-file" }));
    for (const env of [
      { VOLLI_SESSION_TOKEN: "session-token", VOLLI_OPERATOR_TOKEN: "op" },
      { VOLLI_SESSION: "session-1", VOLLI_OPERATOR_TOKEN: "op" },
      // Present but empty still counts: a Session environment, however broken.
      { VOLLI_SESSION_TOKEN: "" },
    ]) {
      expect(await operatorTokenFor(env, readFile), JSON.stringify(env)).toEqual({});
    }
    expect(readFile).not.toHaveBeenCalled();
  });

  it("prefers the exported variable to the file", async () => {
    const readFile = vi.fn(async () => ({ token: "from-file" }));
    expect(await operatorTokenFor({ VOLLI_OPERATOR_TOKEN: " exported \n" }, readFile)).toEqual({
      token: "exported",
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("falls back to the file, passing on its token, its warning, or nothing", async () => {
    expect(
      await operatorTokenFor({ VOLLI_OPERATOR_TOKEN: "" }, async () => ({ token: "f" })),
    ).toEqual({ token: "f" });
    expect(await operatorTokenFor({}, async () => ({ warning: "careful\n" }))).toEqual({
      warning: "careful\n",
    });
    expect(await operatorTokenFor({}, async () => null)).toEqual({});
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

  it("sends none when no reader is wired", async () => {
    const { env } = await invoke({});
    expect(env).toEqual({ socket: "/socket" });
  });
});
