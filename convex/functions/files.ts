/**
 * Presigned object-storage URLs (A3 §5.4). A writer asks for a URL bound to
 * one key, its exact length and its SHA-256, uploads to the store directly,
 * then calls the commit mutation that records the row. Re-uploading the same
 * bytes to the same key is harmless; the commit decides what is recorded.
 *
 * Today only a Session's producer uploads its own history objects
 * (`transcripts.authorizeSessionUpload`). Blobs and downloads add their own
 * authorization beside it.
 */

import { ConvexError, v } from "convex/values";

import {
  presignS3Request,
  sha256ChecksumHeader,
  type PresignedS3Request,
} from "@volli/shared/cloud";

import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { PRESIGN_EXPIRES_SECONDS, objectStoreConfig } from "./lib/objectStore";

/** A URL for one PUT of exactly `bytes` bytes hashing to `sha256`, valid for five minutes. */
export const presignPut = action({
  args: {
    sessionId: v.string(),
    claim: v.object({ runnerId: v.string(), generation: v.number() }),
    key: v.string(),
    bytes: v.number(),
    sha256: v.string(),
  },
  handler: async (ctx, args): Promise<PresignedS3Request> => {
    const { key } = await ctx.runQuery(internal.transcripts.authorizeSessionUpload, args);
    const config = objectStoreConfig(process.env);
    if (config === null) {
      throw new ConvexError({
        code: "storage_unconfigured",
        message: "Object storage is not configured on this deployment.",
      });
    }
    return presignS3Request({
      ...config,
      method: "PUT",
      key,
      now: Date.now(),
      expiresSeconds: PRESIGN_EXPIRES_SECONDS,
      headers: {
        "content-length": String(args.bytes),
        "x-amz-checksum-sha256": sha256ChecksumHeader(args.sha256),
      },
    });
  },
});
