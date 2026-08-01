import { readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vite-plus/test";
import { createOpenCodeNativeAdapter } from "@volli/opencode-adapter";

import {
  LAB_SESSION_RPC_PATH,
  type LabProcessExitLifecycle,
  LabSessionRpcServer,
  labRequestSecurityError,
} from "./session-rpc";

const labDirectories = async () =>
  (await readdir(tmpdir())).filter((entry) => entry.startsWith("volli-lab-session-rpc-"));

describe("Lab Session RPC server", () => {
  const servers: LabSessionRpcServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("only accepts loopback, same-origin requests", () => {
    expect(
      labRequestSecurityError(request({ host: "localhost:5174", origin: "http://localhost:5174" })),
    ).toBeNull();
    expect(
      labRequestSecurityError(request({ host: "127.0.0.1:5174", origin: "http://127.0.0.1:5174" })),
    ).toBeNull();
    expect(
      labRequestSecurityError(
        request({ host: "localhost:5174", origin: "https://localhost:5174" }),
      ),
    ).toContain("foreign");
    expect(
      labRequestSecurityError(request({ host: "localhost:5174", origin: "http://evil.example" })),
    ).toContain("foreign");
    expect(labRequestSecurityError(request({ host: "evil.example:5174" }))).toContain(
      "loopback hosts",
    );
    expect(labRequestSecurityError(request({ host: "localhost:5174" }, "192.0.2.8"))).toContain(
      "non-loopback clients",
    );
  });

  it("initializes an isolated database only on its first valid request and removes it on close", async () => {
    const before = new Set(await labDirectories());
    const lifecycle = new TestExitLifecycle();
    const lab = new LabSessionRpcServer({ repoRoot: process.cwd(), exitLifecycle: lifecycle });
    servers.push(lab);
    const server = createServer((req, res) => {
      void lab.handle(req, res);
    });
    await listen(server);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
      const response = await fetch(
        `http://127.0.0.1:${address.port}${LAB_SESSION_RPC_PATH}/session.command`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: "lab-create",
            command: {
              kind: "session.create",
              projectId: "lab-project",
              ticketId: null,
              title: "Lab scratch",
            },
          }),
        },
      );
      expect(response.status).toBe(200);
      const sessionId = sessionIdFromResponse(await response.json());
      const batchedSnapshot = await fetch(
        `http://127.0.0.1:${address.port}${LAB_SESSION_RPC_PATH}/session.snapshot?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { sessionId } }))}`,
      );
      expect(batchedSnapshot.status).toBe(200);
      const created = (await labDirectories()).find((entry) => !before.has(entry));
      expect(created).toBeDefined();
      if (!created) throw new Error("Expected Lab Session RPC to create temporary resources");
      expect(created).toMatch(/^volli-lab-session-rpc-/);
      await lab.close();
      expect(await labDirectories()).not.toContain(created);
      expect(lifecycle.size).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  it("synchronously reaps only its owned directory when the dev process exits", async () => {
    const before = new Set(await labDirectories());
    const firstLifecycle = new TestExitLifecycle();
    const secondLifecycle = new TestExitLifecycle();
    const first = new LabSessionRpcServer({
      repoRoot: process.cwd(),
      exitLifecycle: firstLifecycle,
    });
    const second = new LabSessionRpcServer({
      repoRoot: process.cwd(),
      exitLifecycle: secondLifecycle,
    });
    servers.push(first, second);
    const firstServer = createServer((req, res) => {
      void first.handle(req, res);
    });
    const secondServer = createServer((req, res) => {
      void second.handle(req, res);
    });
    await Promise.all([listen(firstServer), listen(secondServer)]);
    try {
      await Promise.all([createSession(firstServer), createSession(secondServer)]);
      const created = (await labDirectories()).filter((entry) => !before.has(entry));
      expect(created).toHaveLength(2);

      firstLifecycle.exit();

      const remaining = (await labDirectories()).filter((entry) => !before.has(entry));
      expect(remaining).toHaveLength(1);
      expect(firstLifecycle.size).toBe(0);
      expect(secondLifecycle.size).toBe(1);

      await second.close();
      expect(secondLifecycle.size).toBe(0);
    } finally {
      await Promise.all([closeServer(firstServer), closeServer(secondServer)]);
    }
  });

  it("does not initialize a database for rejected requests", async () => {
    const before = new Set(await labDirectories());
    const lab = new LabSessionRpcServer({ repoRoot: process.cwd() });
    servers.push(lab);
    const response = await invoke(lab, request({ host: "evil.example" }));
    expect(response.status).toBe(403);
    expect((await labDirectories()).filter((entry) => !before.has(entry))).toEqual([]);
  });

  it("retries initialization after a temporary adapter construction failure", async () => {
    let attempts = 0;
    const lab = new LabSessionRpcServer({
      repoRoot: process.cwd(),
      createAdapter: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("adapter unavailable");
        return createOpenCodeNativeAdapter();
      },
    });
    servers.push(lab);
    const path = `${LAB_SESSION_RPC_PATH}/session.snapshot`;

    await expect(
      invoke(lab, request({ host: "localhost:5174" }, "127.0.0.1", path)),
    ).resolves.toMatchObject({
      status: 500,
      body: "adapter unavailable",
    });
    await expect(
      invoke(lab, request({ host: "localhost:5174" }, "127.0.0.1", path)),
    ).resolves.not.toMatchObject({
      status: 500,
      body: "adapter unavailable",
    });
    expect(attempts).toBe(2);
  });
});

function request(
  headers: Record<string, string>,
  remoteAddress = "127.0.0.1",
  url?: string,
): IncomingMessage {
  return {
    headers,
    socket: { remoteAddress },
    url,
  } as unknown as IncomingMessage;
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function invoke(
  lab: LabSessionRpcServer,
  req: IncomingMessage,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    let body = "";
    const res = {
      headersSent: false,
      statusCode: 200,
      setHeader: () => undefined,
      end: (value?: string) => {
        body = value ?? "";
        resolve({ status: res.statusCode, body });
      },
    } as unknown as ServerResponse;
    void lab.handle(req, res);
  });
}

function sessionIdFromResponse(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.result) || !isRecord(value.result.data)) {
    throw new Error("Expected a tRPC session command response");
  }
  const payload = isRecord(value.result.data.json) ? value.result.data.json : value.result.data;
  const sessionId = payload.sessionId;
  if (typeof sessionId !== "string") throw new Error("Expected a Session id from tRPC");
  return sessionId;
}

async function createSession(server: ReturnType<typeof createServer>): Promise<void> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
  const response = await fetch(
    `http://127.0.0.1:${address.port}${LAB_SESSION_RPC_PATH}/session.command`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: `lab-create-${address.port}`,
        command: {
          kind: "session.create",
          projectId: "lab-project",
          ticketId: null,
          title: "Lab scratch",
        },
      }),
    },
  );
  expect(response.status).toBe(200);
}

class TestExitLifecycle implements LabProcessExitLifecycle {
  readonly #listeners = new Set<() => void>();

  get size(): number {
    return this.#listeners.size;
  }

  add(listener: () => void): void {
    this.#listeners.add(listener);
  }

  remove(listener: () => void): void {
    this.#listeners.delete(listener);
  }

  exit(): void {
    for (const listener of this.#listeners) listener();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
