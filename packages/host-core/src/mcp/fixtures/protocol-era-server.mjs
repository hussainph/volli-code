import { createInterface } from "node:readline";

// A local wire fixture, independent of either SDK. Legacy revisions establish
// a handshake; the modern revision requires per-request metadata instead.
const revision = process.argv[2];
const modern = revision === "2026-07-28";
const refusalCode = process.argv[3] === "method-not-found" ? -32601 : -32022;
let initialized = false;

function reply(request) {
  const response = (result) => ({ jsonrpc: "2.0", id: request.id, result });
  const error = (code, message, data) => ({
    jsonrpc: "2.0",
    id: request.id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
  if (modern) {
    if (request.method === "initialize") {
      return error(refusalCode, "This endpoint is stateless", {
        supported: [revision],
        requested: request.params?.protocolVersion,
      });
    }
    if (request.params?.["_meta"]?.["io.modelcontextprotocol/protocolVersion"] !== revision) {
      return error(-32022, "Version refused", { supported: [revision] });
    }
    if (request.method === "server/discover") {
      return response({
        resultType: "complete",
        ttlMs: 0,
        cacheScope: "private",
        supportedVersions: [revision],
        capabilities: { tools: {} },
        serverInfo: { name: "modern-fixture", version: "1" },
      });
    }
  } else if (request.method === "initialize") {
    initialized = true;
    return response({
      protocolVersion: revision,
      capabilities: { tools: {} },
      serverInfo: { name: "legacy-fixture", version: "1" },
    });
  } else if (!initialized) {
    return error(-32602, "Initialize first");
  }
  if (request.method === "tools/list") {
    return response({
      ...(modern ? { resultType: "complete", ttlMs: 0, cacheScope: "private" } : {}),
      tools: [{ name: "fixture_echo", inputSchema: { type: "object" } }],
    });
  }
  if (request.method === "tools/call" && request.params?.name === "fixture_echo") {
    return response({
      ...(modern ? { resultType: "complete" } : {}),
      content: [{ type: "text", text: JSON.stringify(request.params.arguments) }],
    });
  }
  return error(-32601, "Method not found");
}

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if ("id" in request) process.stdout.write(`${JSON.stringify(reply(request))}\n`);
}
