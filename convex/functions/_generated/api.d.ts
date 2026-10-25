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
import type * as health from "../health.js";
import type * as invites from "../invites.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_firstSignIn from "../lib/firstSignIn.js";
import type * as lib_validators from "../lib/validators.js";
import type * as lib_workspaces from "../lib/workspaces.js";
import type * as members from "../members.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accounts: typeof accounts;
  health: typeof health;
  invites: typeof invites;
  "lib/audit": typeof lib_audit;
  "lib/auth": typeof lib_auth;
  "lib/firstSignIn": typeof lib_firstSignIn;
  "lib/validators": typeof lib_validators;
  "lib/workspaces": typeof lib_workspaces;
  members: typeof members;
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
