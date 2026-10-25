/**
 * The Volli Cloud account commands' validators (VC-884; wire types in
 * `@volli/shared`'s `account.ts`), for the desktop-only tier's `account.*`
 * procedures. Strict inputs, exact outputs, no transforms, so they publish
 * with `z.toJSONSchema`. A snapshot never carries a token: the schema has no
 * field that could hold one. The one token on the wire is
 * `account.accessToken`'s short-lived access JWT for the window's own Volli
 * Cloud client (VC-889); there is no field for a refresh token anywhere.
 */
import {
  ACCOUNT_TOKEN_MAX,
  ACCOUNT_BACKEND_STATES,
  ACCOUNT_CONNECTIONS,
  ACCOUNT_PROVIDERS,
  ACCOUNT_STATES,
  ACCOUNT_TEXT_MAX,
  type AccountAccessToken,
  type AccountSnapshot,
  type AccountSummary,
  type CloudLaunch,
} from "@volli/shared";
import { z } from "zod";

const text = z.string().max(ACCOUNT_TEXT_MAX);

export const accountSignInInputSchema = z.strictObject({
  connection: z.enum(ACCOUNT_CONNECTIONS),
});

const accountSummarySchema = z.object({
  displayName: text,
  email: text.nullable(),
  userId: text.nullable(),
  deletionPurgeAfter: z.number().nullable(),
  backend: z.enum(ACCOUNT_BACKEND_STATES),
}) satisfies z.ZodType<AccountSummary>;

export const accountSnapshotSchema = z.object({
  state: z.enum(ACCOUNT_STATES),
  provider: z.enum(ACCOUNT_PROVIDERS).nullable(),
  signingInWith: z.enum(ACCOUNT_CONNECTIONS).nullable(),
  account: accountSummarySchema.nullable(),
  failure: text.nullable(),
}) satisfies z.ZodType<AccountSnapshot>;

export const accountAccessTokenInputSchema = z.strictObject({ force: z.boolean() });

export const accountAccessTokenSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("token"),
    token: z.string().min(1).max(ACCOUNT_TOKEN_MAX),
    expiresAt: z.number(),
  }),
  z.object({ kind: z.literal("signed-out") }),
  z.object({ kind: z.literal("unavailable"), retryAfterMs: z.number().int().nonnegative() }),
]) satisfies z.ZodType<AccountAccessToken>;

export const cloudLaunchSchema = z.discriminatedUnion("store", [
  z.object({ store: z.literal("local") }),
  z.object({
    store: z.literal("cloud"),
    userId: text.min(1),
    backendUrl: text.min(1),
  }),
]) satisfies z.ZodType<CloudLaunch>;
