import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { McpOAuthCallbackServer } from "./oauth-callback";

const listeners: McpOAuthCallbackServer[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(listeners.splice(0).map((listener) => listener.close()));
});

async function listen(options: Parameters<typeof McpOAuthCallbackServer.listen>[0] = {}) {
  const listener = await McpOAuthCallbackServer.listen(options);
  listeners.push(listener);
  return listener;
}

function callbackUrl(listener: McpOAuthCallbackServer, query: Record<string, string>): URL {
  const url = new URL(listener.redirectUrl);
  url.search = new URLSearchParams(query).toString();
  return url;
}

describe("MCP OAuth callback listener", () => {
  it("validates path and state without consuming the real wait, passes issuer through and flushes the page", async () => {
    const listener = await listen({ path: "/oauth/return", redirectHost: "localhost" });
    expect(listener.redirectUrl).toMatch(/^http:\/\/localhost:\d+\/oauth\/return$/);
    const waiting = listener.waitForCallback("synthetic-state");
    expect(() => listener.waitForCallback("synthetic-state")).toThrow("already pending");
    const wrongPath = callbackUrl(listener, { state: "synthetic-state", code: "synthetic-code" });
    wrongPath.pathname = "/other";
    expect((await fetch(wrongPath)).status).toBe(404);
    for (const state of ["", "wrong-state"]) {
      expect((await fetch(callbackUrl(listener, { state, code: "synthetic-code" }))).status).toBe(
        400,
      );
    }
    const valid = callbackUrl(listener, {
      state: "synthetic-state",
      code: "synthetic-code",
      iss: "https://issuer.example",
    });
    // Close as soon as the callback settles, before consuming the response:
    // graceful draining must still deliver the browser's completion page.
    const response = fetch(valid);
    await expect(waiting).resolves.toEqual({
      state: "synthetic-state",
      code: "synthetic-code",
      iss: "https://issuer.example",
    });
    const closed = listener.close();
    const page = await response;
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toBe("Authorization complete. You may close this window.");
    await closed;
  });

  it("does not accept a callback twice", async () => {
    const listener = await listen();
    const waiting = listener.waitForCallback("synthetic-state");
    const url = callbackUrl(listener, { state: "synthetic-state", code: "synthetic-code" });
    expect((await fetch(url)).status).toBe(200);
    await waiting;
    expect((await fetch(url)).status).toBe(400);
  });

  it.each(["missing code", "provider error"] as const)(
    "settles %s once without reflecting error prose",
    async (kind) => {
      const listener = await listen();
      const waiting = listener.waitForCallback("synthetic-state");
      const rejection = expect(waiting).rejects.toThrow(
        kind === "missing code" ? "authorization code" : "authorization failed",
      );
      const response = await fetch(
        callbackUrl(listener, {
          state: "synthetic-state",
          ...(kind === "provider error"
            ? { error: "access_denied", error_description: "untrusted provider prose" }
            : {}),
        }),
      );
      expect(response.status).toBe(kind === "missing code" ? 400 : 200);
      expect(await response.text()).not.toContain("untrusted provider prose");
      await rejection;
      expect(
        (await fetch(callbackUrl(listener, { state: "synthetic-state", code: "synthetic-code" })))
          .status,
      ).toBe(400);
    },
  );

  it("expires the state and clears pending waits on repeated close", async () => {
    const listener = await listen({ timeoutMs: 20 });
    await expect(listener.waitForCallback("expired-state")).rejects.toThrow("timed out");
    expect(
      (await fetch(callbackUrl(listener, { state: "expired-state", code: "synthetic-code" })))
        .status,
    ).toBe(400);
    const waiting = listener.waitForCallback("pending-state");
    const rejection = expect(waiting).rejects.toThrow("server closed");
    const close = listener.close();
    expect(listener.close()).toBe(close);
    await close;
    await rejection;
    await expect(listener.waitForCallback("after-close")).rejects.toThrow("server closed");
  });

  it("drains both raw preconnections and incomplete HTTP on concurrent close", async () => {
    const listener = await listen();
    const port = Number(new URL(listener.redirectUrl).port);
    for (const partialHttp of [false, true]) {
      const socket = createConnection({ host: "127.0.0.1", port });
      sockets.push(socket);
      socket.on("error", () => undefined);
      await once(socket, "connect");
      if (partialHttp) socket.write("GET /callback HTTP/1.1\r\nHost:");
    }
    // Barrier ensures the server accepted the raw sockets before teardown.
    await fetch(listener.redirectUrl);
    const closedSockets = sockets.map(
      (socket) => new Promise<void>((resolve) => socket.once("close", () => resolve())),
    );
    const started = Date.now();
    const closing = listener.close();
    expect(listener.close()).toBe(closing);
    await closing;
    await Promise.all(closedSockets);
    expect(Date.now() - started).toBeLessThan(1_500);
    const reuse = createServer();
    try {
      reuse.listen(port, "127.0.0.1");
      await once(reuse, "listening");
    } finally {
      await new Promise<void>((resolve) => reuse.close(() => resolve()));
    }
  });
});
