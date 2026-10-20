import { initTRPC, type AnyRouter } from "@trpc/server";
import {
  HOST_BASE_OPERATIONS,
  HOST_SCOPE_BASE_OPERATIONS,
  HOST_FEATURE_OPERATIONS,
  HOST_V1_FEATURES,
  negotiateFeatures,
} from "@volli/host-protocol";
import { CATALOG_ENTRIES } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { assertHostFeatureReadiness } from "./feature-readiness";
import { createHostRouter } from "./host-router";

const t = initTRPC.create();
const tableOperations: readonly string[] = [
  ...HOST_BASE_OPERATIONS,
  ...HOST_SCOPE_BASE_OPERATIONS,
  ...Object.values(HOST_FEATURE_OPERATIONS).flat(),
];
const featureOperations = Object.entries(HOST_FEATURE_OPERATIONS).flatMap(([feature, operations]) =>
  operations.map((operation) => ({ feature, operation })),
);

/** Select real procedures without mutating the actual router or its catalog. */
function selectPaths(router: AnyRouter, paths: readonly string[]): AnyRouter {
  // oxlint-disable-next-line no-underscore-dangle -- tRPC's procedure introspection door.
  const procedures = router._def.procedures;
  return t.router(Object.fromEntries(paths.map((path) => [path, procedures[path]!])));
}

const actual = createHostRouter();

describe("host feature readiness", () => {
  it("accepts the complete actual router and canonical offers", () => {
    expect(() => assertHostFeatureReadiness(actual, HOST_V1_FEATURES)).not.toThrow();
  });

  it("accepts only bootstrap and the chosen subscription feature", () => {
    const paths = [...HOST_BASE_OPERATIONS, ...HOST_FEATURE_OPERATIONS["sessions.subscribe"]];
    const subset = selectPaths(actual, paths);
    expect(() => assertHostFeatureReadiness(subset, ["sessions.subscribe"])).not.toThrow();
  });

  it("allows a bootstrap-only host offering no features", () => {
    expect(() =>
      assertHostFeatureReadiness(selectPaths(actual, HOST_BASE_OPERATIONS), []),
    ).not.toThrow();
  });

  it("requires host bootstrap when offering host workspace management", () => {
    const paths = tableOperations.filter((path) => path !== "protocol.hostWelcome");
    expect(() =>
      assertHostFeatureReadiness(selectPaths(actual, paths), ["host.workspaces"]),
    ).toThrow("Host router is missing host-scope bootstrap operation: protocol.hostWelcome");
    const entries = CATALOG_ENTRIES.filter((entry) => entry.key !== "protocol.hostWelcome");
    expect(() => assertHostFeatureReadiness(actual, ["host.workspaces"], { entries })).toThrow(
      "Host operation protocol.hostWelcome is not a public hostApi catalog entry",
    );
  });

  it.each(["unknown.feature", "toString", "__proto__"])(
    "refuses unknown offered feature %s, including inherited object names",
    (feature) => {
      expect(() => assertHostFeatureReadiness(actual, [feature])).toThrow(
        `Unknown offered host feature: ${feature}`,
      );
    },
  );

  it("continues to ignore unknown requested client features at negotiation", () => {
    expect(() => assertHostFeatureReadiness(actual, ["sessions.subscribe"])).not.toThrow();
    expect(
      negotiateFeatures(["unknown.feature", "sessions.subscribe"], ["sessions.subscribe"]),
    ).toStrictEqual(["sessions.subscribe"]);
  });

  it.each(HOST_BASE_OPERATIONS)(
    "refuses missing bootstrap operation %s even with no offers",
    (path) => {
      const router = selectPaths(
        actual,
        HOST_BASE_OPERATIONS.filter((operation) => operation !== path),
      );
      expect(() => assertHostFeatureReadiness(router, [])).toThrow(
        `Host router is missing bootstrap operation: ${path}`,
      );
    },
  );

  it.each(featureOperations)(
    "refuses advertised $feature missing fixed operation $operation",
    ({ feature, operation }) => {
      const router = selectPaths(
        actual,
        tableOperations.filter((path) => path !== operation),
      );
      expect(() => assertHostFeatureReadiness(router, [feature])).toThrow(
        `Host router is missing operation ${operation} for offered feature ${feature}`,
      );
    },
  );

  it.each(tableOperations)(
    "refuses table member %s absent from the public catalog",
    (operation) => {
      const entries = CATALOG_ENTRIES.filter((entry) => entry.key !== operation);
      // Even an unoffered feature's table must refer to the public catalog.
      expect(() => assertHostFeatureReadiness(actual, [], { entries })).toThrow(
        `Host operation ${operation} is not a public hostApi catalog entry`,
      );
    },
  );

  it.each(tableOperations)("refuses catalog row %s without hostApi access", (operation) => {
    const entries = CATALOG_ENTRIES.map((entry) =>
      entry.key === operation ? { ...entry, accessModes: [] } : entry,
    );
    expect(() => assertHostFeatureReadiness(actual, [], { entries })).toThrow(
      `Host operation ${operation} is not a public hostApi catalog entry`,
    );
  });

  it("does not require catalog membership for settings, lab or other non-table procedures", () => {
    const entries = CATALOG_ENTRIES.filter((entry) => tableOperations.includes(entry.key));
    const router = t.mergeRouters(
      selectPaths(actual, tableOperations),
      t.router({
        settings: { desktopOnly: t.procedure.query(() => null) },
        lab: { desktopOnly: t.procedure.query(() => null) },
      }),
    );
    expect(() => assertHostFeatureReadiness(router, HOST_V1_FEATURES, { entries })).not.toThrow();
  });
});
