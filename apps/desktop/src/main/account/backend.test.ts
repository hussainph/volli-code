import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { BackendRefusedError, convexAccountBackend } from "./backend";

const VIEWER = {
  userId: "6b4c3a1e-2a9f-4c3e-9d1b-0f8e7d6c5b4a",
  displayName: "Dana",
  primaryEmail: "dana@example.com",
  status: "active",
  purgeAfter: null,
};

const servers: (() => void)[] = [];
afterEach(() => {
  for (const close of servers.splice(0)) close();
});

/** A stand-in for Convex's HTTP functions API. */
async function convex(answer: (path: string) => { status: number; body: unknown }) {
  const seen: { url: string; authorization: string | undefined; body: unknown }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { path: string };
    seen.push({ url: request.url ?? "", authorization: request.headers.authorization, body });
    const reply = answer(body.path);
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe("the account's backend calls", () => {
  it("calls each accounts mutation with the person's bearer token", async () => {
    const { url, seen } = await convex(() => ({
      status: 200,
      body: { status: "success", value: VIEWER, logLines: [] },
    }));
    const backend = convexAccountBackend({ url: `${url}/` });
    await expect(backend.ensureViewer("tok-1")).resolves.toEqual(VIEWER);
    await backend.requestDeletion("tok-2");
    await backend.cancelDeletion("tok-3");
    expect(seen).toEqual([
      {
        url: "/api/mutation",
        authorization: "Bearer tok-1",
        body: { path: "accounts:ensureViewer", args: {}, format: "json" },
      },
      {
        url: "/api/mutation",
        authorization: "Bearer tok-2",
        body: { path: "accounts:requestDeletion", args: { via: "desktop" }, format: "json" },
      },
      {
        url: "/api/mutation",
        authorization: "Bearer tok-3",
        body: { path: "accounts:cancelDeletion", args: { via: "desktop" }, format: "json" },
      },
    ]);
  });

  it("carries the backend's typed refusal, and refuses what it cannot read", async () => {
    let reply: { status: number; body: unknown } = {
      status: 560,
      body: {
        status: "error",
        errorMessage: "Uncaught ConvexError",
        errorData: { code: "sole_owner", message: "Make someone else an owner first." },
      },
    };
    const { url } = await convex(() => reply);
    const backend = convexAccountBackend({ url });
    const refused = await backend.requestDeletion("t").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(BackendRefusedError);
    expect(refused).toMatchObject({
      code: "sole_owner",
      message: "Make someone else an owner first.",
    });

    reply = { status: 560, body: { status: "error", errorMessage: "Server Error" } };
    await expect(backend.ensureViewer("t")).rejects.toMatchObject({
      code: null,
      message: "Server Error",
    });
    reply = { status: 401, body: "not json" };
    await expect(backend.ensureViewer("t")).rejects.toMatchObject({
      code: "unauthenticated",
      message: "Volli Cloud did not accept this sign-in.",
    });
    reply = { status: 502, body: "not json" };
    await expect(backend.ensureViewer("t")).rejects.toThrow("Volli Cloud answered 502.");
    reply = { status: 200, body: { status: "success", value: { userId: 1 } } };
    await expect(backend.ensureViewer("t")).rejects.toThrow("cannot read");
  });
});
