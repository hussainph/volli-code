// @vitest-environment node
import { createServer as createNetServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { bindOneCallback, RELAY_IDLE_MS, relayAddressOf } from "./relay-client";

const open: { close(): void }[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const item of open.splice(0)) item.close();
});

/** A server that listens at once and records its closing: no socket, so time can be mocked. */
function fakeServer() {
  const closed = vi.fn();
  const createServer = (() => {
    const server = {
      once: () => server,
      listen: (_options: unknown, listening: () => void) => {
        listening();
        return server;
      },
      close: closed,
      closeAllConnections: vi.fn(),
    };
    return server;
  }) as unknown as typeof import("node:http").createServer;
  return { createServer, closed };
}

/** A free loopback port: bound, read, released. */
async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe("relayAddressOf", () => {
  it("binds only a loopback http address with a port", () => {
    expect(relayAddressOf("http://localhost:53692/callback")).toEqual({
      host: "127.0.0.1",
      port: 53692,
      path: "/callback",
    });
    expect(relayAddressOf("http://127.0.0.1:1455/auth/callback")).toMatchObject({
      host: "127.0.0.1",
      path: "/auth/callback",
    });
    expect(relayAddressOf("http://[::1]:8080/cb")).toMatchObject({ host: "::1", port: 8080 });
    for (const refused of [
      "https://localhost:53692/callback",
      "http://example.com:53692/callback",
      "http://10.0.0.2:53692/callback",
      "http://localhost/callback",
      "http://user:pw@localhost:1/callback",
      "not a url",
    ]) {
      expect(relayAddressOf(refused)).toBeNull();
    }
  });
});

describe("bindOneCallback", () => {
  it("delivers the first request on the path once, answers the browser, and closes", async () => {
    const port = await freePort();
    const deliver = vi.fn(async () => ({ status: 200 }));
    const binding = await bindOneCallback(`http://localhost:${port}/callback`, deliver);
    if (binding.kind !== "bound") throw new Error("expected to bind");
    open.push(binding);
    // Another path is not the redirect, and spends nothing.
    expect((await fetch(`http://127.0.0.1:${port}/favicon.ico`)).status).toBe(404);
    expect(
      (await fetch(`http://127.0.0.1:${port}/callback?code=x`, { method: "POST" })).status,
    ).toBe(404);
    const answered = await fetch(`http://127.0.0.1:${port}/callback?code=CODE&state=s`);
    expect(answered.status).toBe(200);
    expect(await answered.text()).toContain("Signed in");
    expect(await binding.outcome).toEqual({ kind: "delivered", status: 200 });
    expect(deliver).toHaveBeenCalledExactlyOnceWith("/callback?code=CODE&state=s");
    // One request, ever: the listener is gone.
    await expect(fetch(`http://127.0.0.1:${port}/callback?code=AGAIN`)).rejects.toThrow();
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("tells the browser and the row when the host's listener refused, or the link failed", async () => {
    const refusedPort = await freePort();
    const refused = await bindOneCallback(`http://localhost:${refusedPort}/cb`, async () => ({
      status: 400,
    }));
    if (refused.kind !== "bound") throw new Error("expected to bind");
    open.push(refused);
    const page = await fetch(`http://127.0.0.1:${refusedPort}/cb?code=x`);
    expect(page.status).toBe(502);
    expect(await page.text()).toContain("did not finish");
    expect(await refused.outcome).toEqual({ kind: "delivered", status: 400 });

    const brokenPort = await freePort();
    const broken = await bindOneCallback(`http://localhost:${brokenPort}/cb`, async () => {
      throw new Error("host-unreachable");
    });
    if (broken.kind !== "bound") throw new Error("expected to bind");
    open.push(broken);
    expect((await fetch(`http://127.0.0.1:${brokenPort}/cb?code=x`)).status).toBe(502);
    expect(await broken.outcome).toEqual({ kind: "failed" });
  });

  it("falls back to paste when the port is taken or the address is not loopback", async () => {
    const holder: Server = createNetServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    open.push({ close: () => holder.close() });
    const { port } = holder.address() as AddressInfo;
    const deliver = vi.fn(async () => ({ status: 200 }));
    expect(await bindOneCallback(`http://localhost:${port}/callback`, deliver)).toEqual({
      kind: "unavailable",
      reason: "port-taken",
    });
    expect(await bindOneCallback("https://evil.test/callback", deliver)).toEqual({
      kind: "unavailable",
      reason: "address",
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("reports any other bind failure as a reason to paste", async () => {
    const failing = (() => {
      const server = {
        once(event: string, listener: (error: NodeJS.ErrnoException) => void) {
          if (event === "error")
            queueMicrotask(() => listener(Object.assign(new Error("x"), { code: "EACCES" })));
          return server;
        },
        listen() {
          return server;
        },
      };
      return server;
    }) as unknown as typeof import("node:http").createServer;
    expect(
      await bindOneCallback("http://localhost:1/cb", async () => ({ status: 200 }), {
        createServer: failing,
      }),
    ).toEqual({ kind: "unavailable", reason: "bind-failed" });
  });

  it("settles closed when the flow ends before a redirect arrives", async () => {
    const port = await freePort();
    const binding = await bindOneCallback(`http://localhost:${port}/cb`, async () => ({
      status: 200,
    }));
    if (binding.kind !== "bound") throw new Error("expected to bind");
    binding.close();
    expect(await binding.outcome).toEqual({ kind: "closed" });
    await expect(fetch(`http://127.0.0.1:${port}/cb?code=late`)).rejects.toThrow();
  });

  it("gives up after a bounded wait, so a host cannot keep this Mac's port bound", async () => {
    const port = await freePort();
    const binding = await bindOneCallback(
      `http://localhost:${port}/cb`,
      async () => ({ status: 200 }),
      { idleMs: 10 },
    );
    if (binding.kind !== "bound") throw new Error("expected to bind");
    expect(await binding.outcome).toEqual({ kind: "timed-out" });
    await expect(fetch(`http://127.0.0.1:${port}/cb?code=late`)).rejects.toThrow();
    binding.close();
  });

  it("keeps listening no longer than its declared wait, under mocked time", async () => {
    vi.useFakeTimers();
    const server = fakeServer();
    const binding = await bindOneCallback("http://localhost:1/cb", async () => ({ status: 200 }), {
      createServer: server.createServer,
    });
    if (binding.kind !== "bound") throw new Error("expected to bind");
    let outcome: unknown = "pending";
    void binding.outcome.then((settled) => (outcome = settled));
    await vi.advanceTimersByTimeAsync(RELAY_IDLE_MS - 1);
    expect(outcome).toBe("pending");
    expect(server.closed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toEqual({ kind: "timed-out" });
    expect(server.closed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its wait when the flow closes it first", async () => {
    vi.useFakeTimers();
    const server = fakeServer();
    const binding = await bindOneCallback("http://localhost:1/cb", async () => ({ status: 200 }), {
      createServer: server.createServer,
    });
    if (binding.kind !== "bound") throw new Error("expected to bind");
    expect(vi.getTimerCount()).toBe(1);
    binding.close();
    expect(await binding.outcome).toEqual({ kind: "closed" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
