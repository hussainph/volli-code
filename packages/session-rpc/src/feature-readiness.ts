import type { AnyRouter } from "@trpc/server";
import {
  HOST_BASE_OPERATIONS,
  HOST_SCOPE_BASE_OPERATIONS,
  HOST_FEATURE_OPERATIONS,
  type HostFeature,
  type HostV1Feature,
} from "@volli/host-protocol";
import { CATALOG_ENTRIES, type CatalogEntry } from "@volli/shared";

export interface HostFeatureReadinessOptions {
  /** Production uses the public catalog; isolated tests may supply its rows. */
  readonly entries?: readonly CatalogEntry[];
}

/**
 * Assert before binding a listener that its advertised features are honest.
 * Every fixed table member must be a public hostApi catalog entry, but only
 * bootstrap and the offered features must be present on this actual router.
 * Desktop-only procedures and unoffered features need not be served.
 * This checks server offers, not client requests: negotiation ignores unknown
 * requested features, as before.
 */
export function assertHostFeatureReadiness(
  router: AnyRouter,
  offered: readonly HostFeature[],
  options: HostFeatureReadinessOptions = {},
): void {
  for (const feature of offered) {
    if (!Object.hasOwn(HOST_FEATURE_OPERATIONS, feature)) {
      throw new Error(`Unknown offered host feature: ${feature}`);
    }
  }

  const publicHostApiKeys = new Set(
    (options.entries ?? CATALOG_ENTRIES)
      .filter((entry) => entry.accessModes.includes("hostApi"))
      .map((entry) => entry.key),
  );
  for (const operation of [
    ...HOST_BASE_OPERATIONS,
    ...HOST_SCOPE_BASE_OPERATIONS,
    ...Object.values(HOST_FEATURE_OPERATIONS).flat(),
  ]) {
    if (!publicHostApiKeys.has(operation)) {
      throw new Error(`Host operation ${operation} is not a public hostApi catalog entry`);
    }
  }

  // oxlint-disable-next-line no-underscore-dangle -- tRPC's procedure introspection door.
  const procedures = router._def.procedures;
  for (const operation of HOST_BASE_OPERATIONS) {
    if (!Object.hasOwn(procedures, operation)) {
      throw new Error(`Host router is missing bootstrap operation: ${operation}`);
    }
  }
  if (offered.includes("host.workspaces")) {
    for (const operation of HOST_SCOPE_BASE_OPERATIONS) {
      if (!Object.hasOwn(procedures, operation)) {
        throw new Error(`Host router is missing host-scope bootstrap operation: ${operation}`);
      }
    }
  }
  for (const feature of offered) {
    for (const operation of HOST_FEATURE_OPERATIONS[feature as HostV1Feature]) {
      if (!Object.hasOwn(procedures, operation)) {
        throw new Error(
          `Host router is missing operation ${operation} for offered feature ${feature}`,
        );
      }
    }
  }
}
