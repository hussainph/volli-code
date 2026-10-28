/**
 * The object store the backend signs for: an S3-compatible bucket (R2 in
 * production), configured by deployment environment variables. Only signing
 * happens here; bytes never pass through the backend.
 *
 * - `VOLLI_S3_ENDPOINT`: the store's origin, e.g. `https://<account>.r2.cloudflarestorage.com`
 * - `VOLLI_S3_BUCKET`
 * - `VOLLI_S3_ACCESS_KEY_ID`, `VOLLI_S3_SECRET_ACCESS_KEY`: a token scoped to that bucket
 * - `VOLLI_S3_REGION`: optional, `auto` (R2's) by default
 *
 * A deployment without them refuses to sign (`storage_unconfigured`).
 *
 * Signing is all a client ever gets. The backend itself only lists and
 * deletes, for a purge ({@link listObjectKeys}, {@link deleteObject}), with
 * requests it signs the same way and sends from an action.
 */

import { presignS3ListObjects, presignS3Request, type S3Credentials } from "@volli/shared/cloud";

export interface ObjectStoreConfig extends S3Credentials {
  endpoint: string;
  bucket: string;
}

/** How long a signed upload or download URL lives. */
export const PRESIGN_EXPIRES_SECONDS = 5 * 60;

/** The configured store, or `null` when any required variable is unset. */
export function objectStoreConfig(
  env: Readonly<Record<string, string | undefined>>,
): ObjectStoreConfig | null {
  const endpoint = env.VOLLI_S3_ENDPOINT;
  const bucket = env.VOLLI_S3_BUCKET;
  const accessKeyId = env.VOLLI_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.VOLLI_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, bucket, accessKeyId, secretAccessKey, region: env.VOLLI_S3_REGION || "auto" };
}

/** What one listed page holds: its keys, and the token for the next page (`null` at the end). */
export interface ObjectListPage {
  keys: string[];
  nextContinuationToken: string | null;
}

/** A refused or failed request to the store. Its message names the status, never a URL. */
export class ObjectStoreError extends Error {
  readonly code = "object_store_failed";
  constructor(
    readonly operation: "list" | "delete",
    readonly status: number,
  ) {
    super(`Object store ${operation} failed with HTTP ${status}`);
    this.name = "ObjectStoreError";
  }
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function xmlText(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return XML_ENTITIES[entity] ?? whole;
  });
}

/**
 * The keys and continuation token of a ListObjectsV2 answer listed with
 * `encoding-type=url`: each `<Contents><Key>` is percent-encoded inside the
 * XML. Only what the purge needs is read; anything else is ignored.
 */
export function parseListObjectsV2(xml: string): ObjectListPage {
  const keys: string[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(match[1]!)?.[1];
    if (key === undefined) throw new Error("A listed object has no key");
    keys.push(decodeURIComponent(xmlText(key)));
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml);
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  if (truncated && token === undefined) {
    throw new Error("A truncated list carries no continuation token");
  }
  return { keys, nextContinuationToken: truncated ? xmlText(token!) : null };
}

/** One page of the keys under `prefix`, signed and sent from the backend itself. */
export async function listObjectKeys(
  config: ObjectStoreConfig,
  prefix: string,
  continuationToken: string | null,
  maxKeys: number,
): Promise<ObjectListPage> {
  const request = presignS3ListObjects({
    ...config,
    prefix,
    continuationToken,
    maxKeys,
    now: Date.now(),
    expiresSeconds: PRESIGN_EXPIRES_SECONDS,
  });
  const response = await fetch(request.url, { method: "GET", headers: request.headers });
  if (!response.ok) throw new ObjectStoreError("list", response.status);
  return parseListObjectsV2(await response.text());
}

/** Deletes one object. An object that is already gone counts as deleted (S3 answers 204 either way). */
export async function deleteObject(config: ObjectStoreConfig, key: string): Promise<void> {
  const request = presignS3Request({
    ...config,
    method: "DELETE",
    key,
    now: Date.now(),
    expiresSeconds: PRESIGN_EXPIRES_SECONDS,
  });
  const response = await fetch(request.url, { method: "DELETE", headers: request.headers });
  if (!response.ok && response.status !== 404)
    throw new ObjectStoreError("delete", response.status);
}
