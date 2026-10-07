// The v1 feature table against the catalog it grants from (VC-663).
import {
  HOST_BASE_OPERATIONS,
  HOST_SCOPE_BASE_OPERATIONS,
  HOST_FEATURE_OPERATIONS,
} from "@volli/host-protocol";
import { CATALOG_ENTRIES } from "@volli/shared";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import type { HostRouterFeatureBinding } from "./host-router";

const granted: readonly string[] = [
  ...HOST_BASE_OPERATIONS,
  ...HOST_SCOPE_BASE_OPERATIONS,
  ...Object.values(HOST_FEATURE_OPERATIONS).flat(),
];
const projected = CATALOG_ENTRIES.filter((entry) => entry.accessModes.includes("hostApi"));

describe("the v1 features against the catalog", () => {
  it("grant only procedures the router serves", () => {
    expectTypeOf<HostRouterFeatureBinding>().toEqualTypeOf<never>();
  });

  it("grant only entries the WebSocket projects", () => {
    const keys = new Set<string>(projected.map((entry) => entry.key));
    expect(granted.filter((key) => !keys.has(key))).toStrictEqual([]);
  });

  // An entry on the WebSocket that no feature grants is refused there. Each
  // one is named, so leaving a new entry out of every feature is a decision.
  // The board's commands, `ticket.move` included, are `board.read` and
  // `board.write`'s (VC-565).
  it("leave out only the experiment switches, for VC-572 to name", () => {
    expect(
      projected.map((entry) => entry.key).filter((key) => !granted.includes(key)),
    ).toStrictEqual(["settings.experiments", "settings.setExperiment"]);
  });
});
