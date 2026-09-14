import { describe, expect, it } from "vitest";

import { assertSessionEvent } from "@volli/shared";

import {
  EVENT_FAMILIES,
  FAMILY_WEIGHT_TOTAL,
  allocateFamilyUnits,
  eventsInUnits,
  orderFamilyUnits,
} from "./event-mix.mjs";

describe("performance fixture event mix", () => {
  it("keeps the published weights and exact unit allocation", () => {
    expect(EVENT_FAMILIES.reduce((sum, family) => sum + family.weight, 0)).toBe(
      FAMILY_WEIGHT_TOTAL,
    );
    for (const total of [0, 1, 5, 101, 1_195, 26_035]) {
      const units = allocateFamilyUnits(total);
      expect(eventsInUnits(units)).toBe(total);
    }
  });

  it("orders a weighted history deterministically", () => {
    const units = allocateFamilyUnits(1_195);
    expect(orderFamilyUnits(units, 353)).toEqual(orderFamilyUnits(units, 353));
    expect(orderFamilyUnits(units, 353)).not.toEqual(orderFamilyUnits(units, 354));
  });

  it("builds payloads accepted by the production write gate", () => {
    const context = {
      sessionId: "perf-session-test",
      sessionTitle: "Fixture Session",
      projectId: "perf-project",
      ticketId: "perf-ticket-test",
      attachmentId: "perf-attachment-test",
      adapterId: "pi",
      occurredAt: 1_000,
      turnId: "perf-turn-test",
      unitIndex: 1,
      unitKey: "test-unit",
      toolIds: ["read", "execute", "edit", "write"],
      pick: () => 0,
      uuid: (scope, name) => `perf-${scope}-${name}`,
      body: (bytes) => "x".repeat(bytes),
      transcriptReference: () => ({
        id: "perf-transcript",
        mediaType: "application/json",
        digest: null,
      }),
    };
    let sequence = 1;
    for (const family of EVENT_FAMILIES) {
      for (const item of family.build(context)) {
        const event = {
          id: `perf-event-test-${sequence}`,
          sessionId: context.sessionId,
          sequence,
          occurredAt: context.occurredAt,
          recordedAt: context.occurredAt,
          provenance: {
            source: { kind: "adapter", id: "pi", detail: { fixture: true } },
            venue: { id: "local:perf", kind: "local" },
          },
          payload: item.payload,
          ...(item.attachment ? { attachmentId: context.attachmentId } : {}),
        };
        expect(() => assertSessionEvent(event, `event ${sequence}`)).not.toThrow();
        sequence += 1;
      }
    }
  });
});
