import { describe, expect, it } from "vite-plus/test";

import { hostLinkRelayEventEnds, type HostLinkRelayEvent } from "./host-link-relay";

describe("a relayed subscription's events", () => {
  it("ends on every kind but a start or an emission", () => {
    const error = { code: "SERVICE_UNAVAILABLE", message: "gone", reason: "host-unreachable" };
    const events: [HostLinkRelayEvent, boolean][] = [
      [{ kind: "started" }, false],
      [{ kind: "data", data: { n: 1 }, id: "7" }, false],
      [{ kind: "data", data: null }, false],
      [{ kind: "resnapshot", error }, true],
      [{ kind: "lost", error }, true],
      [{ kind: "error", error }, true],
      [{ kind: "complete" }, true],
    ];
    for (const [event, ends] of events)
      expect(hostLinkRelayEventEnds(event), event.kind).toBe(ends);
  });
});
