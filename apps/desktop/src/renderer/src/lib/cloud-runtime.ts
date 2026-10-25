/**
 * The Volli Cloud client's code (VC-889): Convex's React client and the
 * backend's generated function references. Only a cloud launch loads this
 * module (`cloud-client.ts` imports it dynamically), so a local launch never
 * loads Convex at all.
 */
export { ConvexReactClient } from "convex/react";
export { api } from "@volli/convex/api";
