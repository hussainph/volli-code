/**
 * An in-memory S3-compatible store for `convex-test` suites: the global
 * `fetch` an action sends its signed requests through. Every request is
 * checked by the independent fixture verifier (`fixture/s3-boundary.ts`),
 * never by the production signer, and an upload's body must match its signed
 * length and SHA-256. Write-once PUTs (`If-None-Match: *`) answer 412 on a
 * key that holds an object.
 *
 * Install it with {@link S3StandIn.install}, which also sets the deployment's
 * `VOLLI_S3_*` variables; `vi.unstubAllGlobals()` / `vi.unstubAllEnvs()` undo it.
 */

import { createHash } from "node:crypto";

import { vi } from "vite-plus/test";

import { verifyS3ListRequest, verifyS3PurgeOrWriteOnceRequest } from "../fixture/s3-boundary.ts";

export const S3_CONFIG = {
  endpoint: "http://s3.standin.test",
  bucket: "volli-test",
  accessKeyId: "standin-access",
  secretAccessKey: "standin-secret",
  region: "auto",
} as const;

type Logged = { method: string; key?: string; prefix?: string; status: number };

export class S3StandIn {
  readonly objects = new Map<string, Uint8Array>();
  readonly log: Logged[] = [];
  /** Keys a list answers besides the stored ones, as a misbehaving store would. */
  readonly extraListed: string[] = [];
  /** HTTP status every DELETE answers instead of succeeding, when set. */
  failDeletesWith: number | null = null;

  install(): this {
    vi.stubEnv("VOLLI_S3_ENDPOINT", S3_CONFIG.endpoint);
    vi.stubEnv("VOLLI_S3_BUCKET", S3_CONFIG.bucket);
    vi.stubEnv("VOLLI_S3_ACCESS_KEY_ID", S3_CONFIG.accessKeyId);
    vi.stubEnv("VOLLI_S3_SECRET_ACCESS_KEY", S3_CONFIG.secretAccessKey);
    vi.stubGlobal("fetch", this.fetch);
    return this;
  }

  /** Stores `key` directly (what an earlier upload left). */
  seed(...keys: string[]): this {
    for (const key of keys) this.objects.set(key, new TextEncoder().encode(key));
    return this;
  }

  keys(): string[] {
    return [...this.objects.keys()].toSorted();
  }

  /** Sends one request the way a client would with a presigned PUT. */
  async upload(
    request: { url: string; headers: Record<string, string> },
    body: Uint8Array,
  ): Promise<number> {
    const response = await this.fetch(request.url, {
      method: "PUT",
      headers: request.headers,
      body,
    });
    return response.status;
  }

  readonly fetch = async (
    input: string | URL | Request,
    init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<Response> => {
    const url = new URL(String(input));
    const headers: Record<string, string> = { host: url.host };
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      headers[name.toLowerCase()] = value;
    }
    const request = { method: init.method ?? "GET", headers };
    const answer = (status: number, entry: Omit<Logged, "status">, body: string | null = null) => {
      this.log.push({ ...entry, status });
      return new Response(body, { status });
    };
    const config = { ...S3_CONFIG };
    if (request.method === "GET" && url.searchParams.has("list-type")) {
      const { prefix, continuationToken, maxKeys } = verifyS3ListRequest(request, url, config);
      const all = [...new Set([...this.objects.keys(), ...this.extraListed])]
        .filter((key) => key.startsWith(prefix) || this.extraListed.includes(key))
        .toSorted();
      const after = continuationToken === null ? null : atob(continuationToken);
      const remaining = after === null ? all : all.filter((key) => key > after);
      const page = remaining.slice(0, maxKeys);
      const truncated = remaining.length > page.length;
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
        `<Name>${S3_CONFIG.bucket}</Name><Prefix>${encodeURIComponent(prefix)}</Prefix>` +
        `<KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys>` +
        `<IsTruncated>${truncated}</IsTruncated>` +
        (truncated ? `<NextContinuationToken>${btoa(page.at(-1)!)}</NextContinuationToken>` : "") +
        page
          .map((key) => `<Contents><Key>${encodeURIComponent(key)}</Key><Size>1</Size></Contents>`)
          .join("") +
        `</ListBucketResult>`;
      return answer(200, { method: "LIST", prefix }, xml);
    }
    const key = verifyS3PurgeOrWriteOnceRequest(request, url, config);
    if (request.method === "DELETE") {
      if (this.failDeletesWith !== null)
        return answer(this.failDeletesWith, { method: "DELETE", key });
      this.objects.delete(key);
      return answer(204, { method: "DELETE", key });
    }
    const body =
      init.body instanceof Uint8Array ? init.body : new TextEncoder().encode(String(init.body));
    const checksum = createHash("sha256").update(body).digest("base64");
    if (
      String(body.length) !== headers["content-length"] ||
      checksum !== headers["x-amz-checksum-sha256"]
    ) {
      return answer(400, { method: "PUT", key });
    }
    if (headers["if-none-match"] === "*" && this.objects.has(key)) {
      return answer(412, { method: "PUT", key });
    }
    this.objects.set(key, body);
    return answer(200, { method: "PUT", key });
  };
}
