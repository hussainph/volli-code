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
 */

import type { S3Credentials } from "@volli/shared/cloud";

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
