/** Shared fixtures for the gateway's tests: an issuer, a sealing key, a grant and a fake provider. */
import {
  createDevIssuer,
  createDevSealingKey,
  type DevIssuer,
  type DevRoute,
  type DevSealingKey,
  mintDevGrant,
} from "../scripts/dev-credentials.ts";
import type { GatewayEnv, UsageBatch, WaitUntil } from "../src/env.ts";

export const CONN = "0e9a7c51-3d2b-4f86-8a14-7b5c6d2e9f03";
export const SESSION = "6f1c2a4e-0b8d-4c39-9a57-2d1e8f3b7c60";
export const CALL_ID = "3d8f2b6a-9c1e-4a57-8b0d-6e2f4a9c7b15";
export const PROVIDER_KEY = "sk-test-real-provider-key";

export interface Fixture {
  issuer: DevIssuer;
  sealingKey: DevSealingKey;
  env: GatewayEnv;
}

let shared: Promise<Pick<Fixture, "issuer" | "sealingKey">> | null = null;

/** One issuer and sealing key per test file: key generation is the slow part. */
export async function fixture(env: Partial<GatewayEnv> = {}): Promise<Fixture> {
  shared ??= Promise.all([createDevIssuer(), createDevSealingKey()]).then(
    ([issuer, sealingKey]) => ({
      issuer,
      sealingKey,
    }),
  );
  const { issuer, sealingKey } = await shared;
  return {
    issuer,
    sealingKey,
    env: {
      GATEWAY_ISSUER: issuer.issuer,
      GATEWAY_JWKS: issuer.jwks,
      GATEWAY_SEALING_KEYS: sealingKey.keyring,
      ...env,
    },
  };
}

export function route(overrides: Partial<DevRoute> = {}): DevRoute {
  return {
    providerId: "anthropic",
    connectionId: CONN,
    keyVersion: 3,
    upstream: "https://api.anthropic.com",
    api: "anthropic-messages",
    key: PROVIDER_KEY,
    ...overrides,
  };
}

export async function grant(
  f: Fixture,
  overrides: {
    routes?: DevRoute[];
    issuedAt?: number;
    lifetimeSeconds?: number;
    claims?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const { token } = await mintDevGrant({
    issuer: f.issuer,
    sealingKey: f.sealingKey,
    routes: overrides.routes ?? [route()],
    sessionId: SESSION,
    workspaceId: "9e2b5d8a-4c7f-4b13-a6e9-0f3c8d1b5a27",
    projectId: "1c5e8a2d-6b9f-4d37-8e1a-3f7c0b4d9e62",
    runnerId: "8c3e1f5a-7b2d-4a96-8e0c-1d4f6b9a2c75",
    userId: "4a9d2c7e-1f6b-4e05-9c38-5b7e0a1d3f86",
    ...(overrides.issuedAt === undefined ? {} : { issuedAt: overrides.issuedAt }),
    ...(overrides.lifetimeSeconds === undefined
      ? {}
      : { lifetimeSeconds: overrides.lifetimeSeconds }),
    ...(overrides.claims ? { claims: overrides.claims } : {}),
  });
  return token;
}

/** An execution context that keeps every `waitUntil` promise for the test to await. */
export function context(): WaitUntil & { settled(): Promise<unknown[]> } {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil(promise) {
      pending.push(promise);
    },
    settled: () => Promise.all(pending),
  };
}

/** An SSE response body from `events`, one chunk per event unless `chunks` splits it differently. */
export function sse(events: { event?: string; data: unknown }[]): string {
  return events
    .map(
      ({ event, data }) =>
        `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
    )
    .join("");
}

export function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

export function batch(
  bodies: unknown[],
): UsageBatch & { acked: boolean; retried: { delaySeconds?: number } | null } {
  const result = {
    messages: bodies.map((body) => ({ body })),
    acked: false,
    retried: null as { delaySeconds?: number } | null,
    ackAll() {
      result.acked = true;
    },
    retryAll(options: { delaySeconds?: number } = {}) {
      result.retried = options;
    },
  };
  return result;
}
