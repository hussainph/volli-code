import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import {
  hostLinkRelayEventEnds,
  type HostLinkRelayEvent,
  type HostScopeRelayCall,
  type HostScopeRelaySubscribeCall,
} from "./host-link-relay";

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

// The HOST relay adds only its address: no Workspace or alternate event wire.
it("addresses HOST relay calls by host id, never Workspace id", () => {
  expectTypeOf<keyof HostScopeRelayCall>().toEqualTypeOf<"hostId" | "path" | "input">();
  expectTypeOf<keyof HostScopeRelaySubscribeCall>().toEqualTypeOf<
    "hostId" | "path" | "input" | "lastEventId"
  >();
});
