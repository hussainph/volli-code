import { createConnection } from "node:net";

import type { AgentErrorCode, AgentRequest, AgentResponse } from "@volli/shared";

const MAX_RESPONSE_CHARS = 4 * 1024 * 1024;

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
  if (typeof value !== "object" || value === null) {
    throw new AgentClientError("SOCKET_PROTOCOL", "The app returned an invalid response.");
  }
  const response = value as Partial<AgentResponse>;
  if (response.v !== 1 || typeof response.ok !== "boolean") {
    throw new AgentClientError("SOCKET_PROTOCOL", "The app returned an unsupported response.");
  }
  return value as AgentResponse;
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
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      action();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new AgentClientError("TIMEOUT", "Timed out waiting for Volli.")));
    }, options.timeoutMs);

    socket.once("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_RESPONSE_CHARS) {
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
      finish(() =>
        reject(
          new AgentClientError(
            "APP_UNREACHABLE",
            `Volli is not reachable at ${socketPath}: ${error.message}`,
          ),
        ),
      );
    });
    socket.once("end", () => {
      if (settled || buffer.includes("\n")) return;
      finish(() =>
        reject(new AgentClientError("SOCKET_PROTOCOL", "The app closed without a response.")),
      );
    });
  });
}
