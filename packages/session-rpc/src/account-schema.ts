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
  ACCOUNT_GITHUB_ACCOUNT_TYPES,
  ACCOUNT_GITHUB_CONNECTION_STATUSES,
  ACCOUNT_GITHUB_FLOWS,
  ACCOUNT_GITHUB_INSTALLATIONS_MAX,
  ACCOUNT_GITHUB_REPOSITORY_SELECTIONS,
  ACCOUNT_GITHUB_STATES,
  ACCOUNT_PROVIDERS,
  ACCOUNT_STATES,
  ACCOUNT_TEXT_MAX,
  type AccountAccessToken,
  type AccountGithubConnection,
  type AccountGithubInstallation,
  type AccountGithubSnapshot,
  type AccountSnapshot,
  type AccountSummary,
  type CloudLaunch,
} from "@volli/shared";
import { z } from "zod";

const text = z.string().max(ACCOUNT_TEXT_MAX);

export const accountSignInInputSchema = z.strictObject({
  connection: z.enum(ACCOUNT_CONNECTIONS),
  inviteCode: z.string().min(16).max(128).optional(),
  acceptedAgreementVersion: z.string().min(1).max(128).optional(),
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
    deployment: z.enum(["cloud", "local"]).optional(),
    siteUrl: text.min(1).nullable().optional(),
  }),
]) satisfies z.ZodType<CloudLaunch>;

const githubConnectionSchema = z.object({
  status: z.enum(ACCOUNT_GITHUB_CONNECTION_STATUSES),
  login: text,
  name: text.nullable(),
}) satisfies z.ZodType<AccountGithubConnection>;

const githubInstallationSchema = z.object({
  installationId: text,
  accountLogin: text,
  accountType: z.enum(ACCOUNT_GITHUB_ACCOUNT_TYPES),
  repositorySelection: z.enum(ACCOUNT_GITHUB_REPOSITORY_SELECTIONS),
  suspended: z.boolean(),
  configureUrl: text.regex(/^https?:\/\//u),
}) satisfies z.ZodType<AccountGithubInstallation>;

/** The account's GitHub connection and installations (VC-897): never a token. */
export const accountGithubSnapshotSchema = z.object({
  state: z.enum(ACCOUNT_GITHUB_STATES),
  connection: githubConnectionSchema.nullable(),
  installations: z.array(githubInstallationSchema).max(ACCOUNT_GITHUB_INSTALLATIONS_MAX).nullable(),
  waiting: z.enum(ACCOUNT_GITHUB_FLOWS).nullable(),
  requested: z.boolean(),
  failure: text.nullable(),
}) satisfies z.ZodType<AccountGithubSnapshot>;
