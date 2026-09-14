/** A transport-level Session projection request used by the performance matrix. */
export function sessionProjectionRequest(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("Session RPC benchmark requires a non-empty session id");
  }
  const request = {
    procedure: "session.projection",
    input: { sessionId },
  };
  // The Electron IPC boundary accepts cloneable JSON-shaped data. Round-trip
  // here so callers cannot accidentally benchmark an in-process-only payload.
  return JSON.parse(JSON.stringify(request));
}

/**
 * Measure one request through the preload-facing Session RPC transport.
 *
 * The defaults deliberately reference renderer globals only inside the call,
 * which keeps this function serializable for Playwright's `page.evaluate` while
 * allowing a focused Node test to inject a fake bridge and clock.
 */
export async function sessionRpcRoundTrip(
  request,
  bridge = globalThis.window.api.sessionRpc,
  now = () => globalThis.performance.now(),
) {
  let wireRequest;
  try {
    wireRequest = JSON.parse(JSON.stringify(request));
  } catch (error) {
    throw new Error("Session RPC benchmark request must be JSON-safe", { cause: error });
  }
  if (
    wireRequest === null ||
    typeof wireRequest !== "object" ||
    typeof wireRequest.procedure !== "string" ||
    !("input" in wireRequest)
  ) {
    throw new Error("Session RPC benchmark request must be transport-facing");
  }

  const started = now();
  const response = await bridge.request(wireRequest);
  const latencyMs = now() - started;
  if (response?.ok !== true) {
    throw new Error(`Session RPC benchmark request failed: ${JSON.stringify(response)}`);
  }
  return { request: wireRequest, response, latencyMs };
}
