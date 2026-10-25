/**
 * The Worker's environment: its vars, secrets and bindings (`wrangler.json`).
 *
 * The binding types are the narrow structural slice of the Workers runtime the
 * gateway uses, so its modules typecheck and unit-test under plain Node with
 * no Workers type package.
 */
import type { GatewayUsageRecord } from "@volli/shared/cloud";

/** A Cloudflare Queue producer binding. */
export interface QueueProducer<Body> {
  send(body: Body): Promise<void>;
}

/** A Workers KV namespace binding, reads only. */
export interface KvReader {
  get(key: string): Promise<string | null>;
}

/** The slice of a Worker's execution context the gateway uses. */
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

/** A batch delivered to the queue consumer. */
export interface UsageBatch {
  readonly messages: readonly { readonly body: unknown }[];
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
}

export interface GatewayEnv {
  /** The Volli issuer's `iss`: the backend's site URL. */
  GATEWAY_ISSUER?: string;
  /** The issuer's JWKS URL. Production. */
  GATEWAY_JWKS_URL?: string;
  /** The issuer's JWKS inline, as JSON. Local development and tests; wins over the URL. */
  GATEWAY_JWKS?: string;
  /** Secret: JSON of `kid` to X25519 private JWK (the current key, and the previous one mid-rotation). */
  GATEWAY_SEALING_KEYS?: string;
  /** Largest request body relayed, in bytes. Defaults to {@link DEFAULT_MAX_BODY_BYTES}. */
  GATEWAY_MAX_BODY_BYTES?: string;
  /** Metered usage goes here, one record per relayed call. */
  USAGE_QUEUE?: QueueProducer<GatewayUsageRecord>;
  /** Kill switch: `grant:<jti>`, `conn:<id>` or `conn:<id>:kv:<n>` present means revoked. */
  REVOCATIONS?: KvReader;
  /** Where the queue consumer posts usage batches (the backend's ingest endpoint). Unset: a local stub that logs counts. */
  USAGE_INGEST_URL?: string;
  /** Secret: the bearer token the ingest endpoint expects. */
  USAGE_INGEST_TOKEN?: string;
}

export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
