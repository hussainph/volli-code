/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accounts from "../accounts.js";
import type * as activity from "../activity.js";
import type * as board from "../board.js";
import type * as boardReceipts from "../boardReceipts.js";
import type * as crons from "../crons.js";
import type * as files from "../files.js";
import type * as github from "../github.js";
import type * as githubFlows from "../githubFlows.js";
import type * as githubHttp from "../githubHttp.js";
import type * as githubIngest from "../githubIngest.js";
import type * as githubTokens from "../githubTokens.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as invites from "../invites.js";
import type * as lib_activity from "../lib/activity.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_board from "../lib/board.js";
import type * as lib_boardEffects from "../lib/boardEffects.js";
import type * as lib_boardReceipts from "../lib/boardReceipts.js";
import type * as lib_firstSignIn from "../lib/firstSignIn.js";
import type * as lib_github_client from "../lib/github/client.js";
import type * as lib_github_config from "../lib/github/config.js";
import type * as lib_github_crypto from "../lib/github/crypto.js";
import type * as lib_github_installations from "../lib/github/installations.js";
import type * as lib_github_seal from "../lib/github/seal.js";
import type * as lib_jobs from "../lib/jobs.js";
import type * as lib_objectStore from "../lib/objectStore.js";
import type * as lib_runnerAuth from "../lib/runnerAuth.js";
import type * as lib_runnerSecrets from "../lib/runnerSecrets.js";
import type * as lib_sealing from "../lib/sealing.js";
import type * as lib_secrets from "../lib/secrets.js";
import type * as lib_sessionDerived from "../lib/sessionDerived.js";
import type * as lib_sessionIntake from "../lib/sessionIntake.js";
import type * as lib_streamChunks from "../lib/streamChunks.js";
import type * as lib_testWorld from "../lib/testWorld.js";
import type * as lib_validators from "../lib/validators.js";
import type * as lib_visibility from "../lib/visibility.js";
import type * as lib_workspaces from "../lib/workspaces.js";
import type * as members from "../members.js";
import type * as migration from "../migration.js";
import type * as projects from "../projects.js";
import type * as runnerHttp from "../runnerHttp.js";
import type * as runnerJobs from "../runnerJobs.js";
import type * as runners from "../runners.js";
import type * as secretKeys from "../secretKeys.js";
import type * as secrets from "../secrets.js";
import type * as secretsDelivery from "../secretsDelivery.js";
import type * as sessionViewers from "../sessionViewers.js";
import type * as sessionVisibility from "../sessionVisibility.js";
import type * as sessions from "../sessions.js";
import type * as streamChunks from "../streamChunks.js";
import type * as testJobs from "../testJobs.js";
import type * as testSeed from "../testSeed.js";
import type * as transcripts from "../transcripts.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accounts: typeof accounts;
  activity: typeof activity;
  board: typeof board;
  boardReceipts: typeof boardReceipts;
  crons: typeof crons;
  files: typeof files;
  github: typeof github;
  githubFlows: typeof githubFlows;
  githubHttp: typeof githubHttp;
  githubIngest: typeof githubIngest;
  githubTokens: typeof githubTokens;
  health: typeof health;
  http: typeof http;
  invites: typeof invites;
  "lib/activity": typeof lib_activity;
  "lib/audit": typeof lib_audit;
  "lib/auth": typeof lib_auth;
  "lib/board": typeof lib_board;
  "lib/boardEffects": typeof lib_boardEffects;
  "lib/boardReceipts": typeof lib_boardReceipts;
  "lib/firstSignIn": typeof lib_firstSignIn;
  "lib/github/client": typeof lib_github_client;
  "lib/github/config": typeof lib_github_config;
  "lib/github/crypto": typeof lib_github_crypto;
  "lib/github/installations": typeof lib_github_installations;
  "lib/github/seal": typeof lib_github_seal;
  "lib/jobs": typeof lib_jobs;
  "lib/objectStore": typeof lib_objectStore;
  "lib/runnerAuth": typeof lib_runnerAuth;
  "lib/runnerSecrets": typeof lib_runnerSecrets;
  "lib/sealing": typeof lib_sealing;
  "lib/secrets": typeof lib_secrets;
  "lib/sessionDerived": typeof lib_sessionDerived;
  "lib/sessionIntake": typeof lib_sessionIntake;
  "lib/streamChunks": typeof lib_streamChunks;
  "lib/testWorld": typeof lib_testWorld;
  "lib/validators": typeof lib_validators;
  "lib/visibility": typeof lib_visibility;
  "lib/workspaces": typeof lib_workspaces;
  members: typeof members;
  migration: typeof migration;
  projects: typeof projects;
  runnerHttp: typeof runnerHttp;
  runnerJobs: typeof runnerJobs;
  runners: typeof runners;
  secretKeys: typeof secretKeys;
  secrets: typeof secrets;
  secretsDelivery: typeof secretsDelivery;
  sessionViewers: typeof sessionViewers;
  sessionVisibility: typeof sessionVisibility;
  sessions: typeof sessions;
  streamChunks: typeof streamChunks;
  testJobs: typeof testJobs;
  testSeed: typeof testSeed;
  transcripts: typeof transcripts;
  workspaces: typeof workspaces;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
