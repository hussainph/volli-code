/**
 * The Volli Cloud account commands' validators (VC-884; wire types in
 * `@volli/shared`'s `account.ts`), for the desktop-only tier's `account.*`
 * procedures. Strict inputs, exact outputs, no transforms, so they publish
 * with `z.toJSONSchema`. A snapshot never carries a token: the schema has no
 * field that could hold one.
 */
import {
  ACCOUNT_BACKEND_STATES,
  ACCOUNT_CONNECTIONS,
  ACCOUNT_PROVIDERS,
  ACCOUNT_STATES,
  ACCOUNT_TEXT_MAX,
  type AccountSnapshot,
  type AccountSummary,
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
