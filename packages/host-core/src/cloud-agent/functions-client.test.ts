import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  CloudContentionError,
  CloudFunctionError,
  CloudOfflineError,
  CONVEX_OCC_CODE,
  createCloudFunctionsClient,
} from "./functions-client";

type Handler = (
  request: { url: string; headers: IncomingMessage["headers"]; body: unknown },
  response: ServerResponse,
) => void;

const servers: Server[] = [];

/** A real HTTP server on a free loopback port, answering as `handler` says. */
async function serve(handler: Handler): Promise<string> {
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    request.on("end", () =>
      handler(
        {
          url: request.url ?? "",
          headers: request.headers,
          body: raw === "" ? null : JSON.parse(raw),
        },
        response,
      ),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("the HTTP functions client", () => {
  it("posts { path, args, format } with the bearer token and answers the value", async () => {
    let seen: { url: string; authorization: string | undefined; body: unknown } | null = null;
    const url = await serve((request, response) => {
      seen = {
        url: request.url,
        authorization: request.headers.authorization,
        body: request.body,
      };
      json(response, 200, { status: "success", value: { ok: 1 }, logLines: [] });
    });
    const client = createCloudFunctionsClient({ url });
    await expect(client.call("mutation", "board:createTicket", { a: 1 }, "tok")).resolves.toEqual({
      ok: 1,
    });
    expect(seen).toEqual({
      url: "/api/mutation",
      authorization: "Bearer tok",
      body: { path: "board:createTicket", args: { a: 1 }, format: "json" },
    });
  });

  it("reads a backend refusal by its typed code and keeps its data", async () => {
    const url = await serve((_request, response) =>
      json(response, 400, {
        status: "error",
        errorMessage: "Uncaught ConvexError: …",
        errorData: { code: "ambiguous_key", message: "VC-1 names two tickets.", candidates: [1] },
      }),
    );
    const error = await createCloudFunctionsClient({ url })
      .call("query", "board:resolveTicketKey", {}, "tok")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudFunctionError);
    expect(error).toMatchObject({
      code: "ambiguous_key",
      message: "VC-1 names two tickets.",
      data: { candidates: [1] },
    });
  });

  it("an untyped server error keeps the backend's message", async () => {
    const url = await serve((_request, response) =>
      json(response, 500, { status: "error", errorMessage: "Server Error" }),
    );
    await expect(
      createCloudFunctionsClient({ url }).call("query", "x:y", {}, "tok"),
    ).rejects.toMatchObject({ code: "server_error", message: "Server Error" });
    const bare = await serve((_request, response) => json(response, 500, { status: "error" }));
    await expect(
      createCloudFunctionsClient({ url: bare }).call("query", "x:y", {}, "tok"),
    ).rejects.toMatchObject({ code: "server_error", message: "x:y failed." });
  });

  it("a mutation that exhausted the backend's concurrency retries is contention: answered, nothing applied", async () => {
    // The body Convex's HTTP API sends with its 503 (as the pinned backend does).
    const url = await serve((_request, response) =>
      json(response, 503, {
        code: CONVEX_OCC_CODE,
        message:
          'Documents read from or written to the "projectCounters" table changed while this mutation was being run and on every subsequent retry. See https://docs.convex.dev/error#1',
      }),
    );
    const error = await createCloudFunctionsClient({ url })
      .call("mutation", "board:createTicket", {}, "tok")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudContentionError);
    // A refusal, so no caller reads it as a write that may have landed.
    expect(error).toBeInstanceOf(CloudFunctionError);
    expect(error).not.toBeInstanceOf(CloudOfflineError);
    expect(error).toMatchObject({ name: "CloudContentionError", code: "contention" });
    expect((error as Error).message).toContain("board:createTicket");
    // The platform's sentence names the contended table, kept for diagnosis.
    expect((error as CloudContentionError).data["detail"]).toContain('"projectCounters" table');

    // Only a mutation's: the same body for another kind is not a claim that nothing ran.
    await expect(
      createCloudFunctionsClient({ url }).call("action", "x:y", {}, "tok"),
    ).rejects.toMatchObject({ name: "CloudOfflineError", reason: "unavailable" });
  });

  it("a token the deployment does not accept is unauthenticated, not offline", async () => {
    const url = await serve((_request, response) =>
      json(response, 401, { code: "Unauthenticated", message: "Could not verify token" }),
    );
    await expect(
      createCloudFunctionsClient({ url }).call("query", "x:y", {}, "tok"),
    ).rejects.toMatchObject({ name: "CloudFunctionError", code: "unauthenticated" });
  });

  it("no answer is offline: a 5xx with no body, a closed port, a timeout", async () => {
    const down = await serve((_request, response) => {
      response.writeHead(502);
      response.end("bad gateway");
    });
    await expect(
      createCloudFunctionsClient({ url: down }).call("query", "x:y", {}, "tok"),
    ).rejects.toMatchObject({ name: "CloudOfflineError", reason: "unavailable" });

    const closed = await serve(() => {});
    const server = servers.pop()!;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const refused = await createCloudFunctionsClient({ url: closed })
      .call("query", "x:y", {}, "tok")
      .catch((caught: unknown) => caught);
    expect(refused).toBeInstanceOf(CloudOfflineError);
    // A refused connection sent nothing: the write cannot have landed.
    expect(refused).toMatchObject({
      code: "offline",
      retryable: true,
      reason: "network",
      delivery: "not_sent",
    });

    const slow = await serve(() => {
      // Never answers.
    });
    await expect(
      createCloudFunctionsClient({ url: slow, timeoutMs: 50 }).call("mutation", "x:y", {}, "tok"),
    ).rejects.toMatchObject({ name: "CloudOfflineError", reason: "timeout", delivery: "unknown" });
  });
});
