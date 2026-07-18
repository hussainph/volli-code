import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { AgentRequest } from "@volli/shared";

import { AgentClientError, requestAgent } from "./client";

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("requestAgent", () => {
  it("performs one newline-delimited request and returns the one response", async () => {
    const dir = await mkdtemp(join(tmpdir(), "volli-cli-client-"));
    scratch.push(dir);
    const socketPath = join(dir, "volli.sock");
    let received = "";
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        received += chunk;
        if (received.endsWith("\n")) {
          socket.end(`${JSON.stringify({ v: 1, ok: true, data: { projects: 2 } })}\n`);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    const request: AgentRequest = {
      v: 1,
      cmd: "project.list",
      args: {},
      ctx: { cwd: "/work/volli", env: {} },
    };
    const result = await requestAgent(socketPath, request, { timeoutMs: 500 });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );

    expect(JSON.parse(received.trim())).toEqual(request);
    expect(result).toEqual({ v: 1, ok: true, data: { projects: 2 } });
  });

  it("classifies a missing socket as retryable app infrastructure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "volli-cli-missing-"));
    scratch.push(dir);
    const request: AgentRequest = {
      v: 1,
      cmd: "project.list",
      args: {},
      ctx: { cwd: "/work/volli", env: {} },
    };

    await expect(
      requestAgent(join(dir, "missing.sock"), request, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: "APP_UNREACHABLE" } satisfies Partial<AgentClientError>);
  });
});
