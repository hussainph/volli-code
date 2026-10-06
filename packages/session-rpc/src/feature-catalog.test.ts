// The v1 feature table against the catalog it grants from (VC-663).
import { HOST_BASE_OPERATIONS, HOST_FEATURE_OPERATIONS } from "@volli/host-protocol";
import { CATALOG_ENTRIES } from "@volli/shared";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import type { SessionRouterFeatureBinding } from "./index";

const granted: readonly string[] = [
  ...HOST_BASE_OPERATIONS,
  ...Object.values(HOST_FEATURE_OPERATIONS).flat(),
];
const projected = CATALOG_ENTRIES.filter((entry) => entry.accessModes.includes("hostApi"));

describe("the v1 features against the catalog", () => {
  it("grant only procedures the router serves", () => {
    expectTypeOf<SessionRouterFeatureBinding>().toEqualTypeOf<never>();
  });

  it("grant only entries the WebSocket projects", () => {
    const keys = new Set<string>(projected.map((entry) => entry.key));
    expect(granted.filter((key) => !keys.has(key))).toStrictEqual([]);
  });

  // An entry on the WebSocket that no feature grants is refused there. Each
  // one is named, so leaving a new entry out of every feature is a decision.
  // `ticket.move` (VC-668) is the board router's, which no listener serves
  // yet; VC-565 gives it its board feature (VC-669).
  it("leave out only the experiment switches and the board's move, for VC-572 and VC-565 to name", () => {
    expect(
      projected.map((entry) => entry.key).filter((key) => !granted.includes(key)),
    ).toStrictEqual(["ticket.move", "settings.experiments", "settings.setExperiment"]);
  });
});
