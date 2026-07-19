import { createConnection } from "node:net";

import { AGENT_ERROR_CODES } from "@volli/shared";
import type { AgentErrorCode, AgentRequest, AgentResponse } from "@volli/shared";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class AgentClientError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentClientError";
  }
}

function parseResponse(line: string): AgentResponse {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw new AgentClientError("SOCKET_PROTOCOL", "The app returned malformed JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentClientError("SOCKET_PROTOCOL", "The app returned an invalid response.");
  }
  const response = value as Record<string, unknown>;
  if (response["v"] !== 1 || typeof response["ok"] !== "boolean") {
    throw new AgentClientError("SOCKET_PROTOCOL", "The app returned an unsupported response.");
  }
  if (response["ok"] === true) {
    if (!("data" in response)) {
      throw new AgentClientError(
        "SOCKET_PROTOCOL",
        "The app returned an invalid success response.",
      );
    }
    return { v: 1, ok: true, data: response["data"] };
  }
  const error = response["error"];
  if (
    typeof error !== "object" ||
    error === null ||
    Array.isArray(error) ||
    typeof (error as Record<string, unknown>)["code"] !== "string" ||
    !(AGENT_ERROR_CODES as readonly string[]).includes(
      (error as Record<string, unknown>)["code"] as string,
    ) ||
    typeof (error as Record<string, unknown>)["message"] !== "string"
  ) {
    throw new AgentClientError("SOCKET_PROTOCOL", "The app returned an invalid error response.");
  }
  const typedError = error as { code: AgentErrorCode; message: string };
  return { v: 1, ok: false, error: { code: typedError.code, message: typedError.message } };
}

export interface AgentClientOptions {
  timeoutMs: number;
}

/** Performs one NDJSON request against the app-owned Unix socket. */
export function requestAgent(
  socketPath: string,
  request: AgentRequest,
  options: AgentClientOptions,
): Promise<AgentResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let receivedBytes = 0;
    let settled = false;
    let connected = false;
    const finish = (action: () => void): void => {
      /* v8 ignore next -- competing socket events may finish the same request; the guard is defensive */
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      action();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new AgentClientError("TIMEOUT", "Timed out waiting for Volli.")));
    }, options.timeoutMs);

    socket.once("connect", () => {
      connected = true;
      socket.end(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      receivedBytes += Buffer.byteLength(chunk);
      if (receivedBytes > MAX_RESPONSE_BYTES) {
        finish(() =>
          reject(new AgentClientError("SOCKET_PROTOCOL", "The app response is too large.")),
        );
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const response = parseResponse(buffer.slice(0, newline));
        finish(() => resolve(response));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    socket.once("error", (error) => {
      // A pre-connect failure (no listener, permission denied, ...) means the
      // app itself is unreachable — the retryable exit-3 class. An error
      // after "connect" fired (e.g. ECONNRESET mid-response) means the app
      // was there but the exchange broke, which is a protocol-level failure,
      // not an app-availability one.
      finish(() =>
        reject(
          connected
            ? new AgentClientError(
                "SOCKET_PROTOCOL",
                `The connection to Volli broke: ${error.message}`,
              )
            : new AgentClientError(
                "APP_UNREACHABLE",
                `Volli is not reachable at ${socketPath}: ${error.message}`,
              ),
        ),
      );
    });
    socket.once("end", () => {
      /* v8 ignore next -- a settled request destroys the socket before a meaningful late end event */
      if (settled || buffer.includes("\n")) return;
      finish(() =>
        reject(new AgentClientError("SOCKET_PROTOCOL", "The app closed without a response.")),
      );
    });
  });
}
