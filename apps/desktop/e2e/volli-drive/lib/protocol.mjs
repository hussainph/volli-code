/**
 * The CLI ⇄ supervisor wire: one NDJSON request, one NDJSON response, over a
 * unix socket inside the instance's 0700 scratch dir.
 */
import { createConnection, createServer } from "node:net";

/** Send `{cmd, args}`; resolves with the response's result or throws its error. */
export function request(socketPath, cmd, args = {}, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`${cmd} timed out after ${timeoutMs}ms`))),
      timeoutMs,
    );
    socket.once("connect", () => socket.write(`${JSON.stringify({ cmd, args })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      let response;
      try {
        response = JSON.parse(buffer.slice(0, newline));
      } catch (error) {
        finish(() => reject(error));
        return;
      }
      finish(() =>
        response.ok ? resolve(response.result) : reject(new Error(response.error ?? "failed")),
      );
    });
    socket.once("error", (error) => finish(() => reject(error)));
    socket.once("end", () => finish(() => reject(new Error("supervisor closed the connection"))));
  });
}

/**
 * Serve requests ONE AT A TIME: a second CLI call waits for the first, so two
 * agents can never interleave actions on one window.
 */
export function serve(socketPath, handle) {
  let chain = Promise.resolve();
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = "";
      chain = chain.then(async () => {
        let response;
        try {
          const { cmd, args } = JSON.parse(line);
          response = { ok: true, result: await handle(cmd, args ?? {}) };
        } catch (error) {
          response = { ok: false, error: error?.message ?? String(error) };
        }
        if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
      });
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}
