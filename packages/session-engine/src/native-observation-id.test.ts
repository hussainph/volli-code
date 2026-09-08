import { describe, expect, it } from "vite-plus/test";

import { compactNativeObservationEventId, nativeObservationEventId } from "./native-observation-id";

const adapterId = "pi";
const sessionId = "c8d1f5dc-1111-4222-8333-0123456789ab";
const attachmentId = "runtime-attachment:d17dbc96-1111-4222-8333-0123456789ab";
const observationId =
  "pi:activity:runtime-attachment:d17dbc96-1111-4222-8333-0123456789ab:c76055a6-1111-4222-8333-0123456789ab:call_jTUfZAmS4Rr2JTddTHdvatp3|fc_0e4e5266:completed";
const legacyId = `native-event:${adapterId}:${sessionId}:${attachmentId}:${observationId}`;

describe("native observation event ids", () => {
  it("hashes the complete legacy identity into a short, pinned 128-bit id", () => {
    const expected = "native-event:v2:9415eae284911f9a944f15588076b071";

    expect(nativeObservationEventId(adapterId, sessionId, attachmentId, observationId)).toBe(
      expected,
    );
    expect(compactNativeObservationEventId(legacyId)).toBe(expected);
    expect(expected).toMatch(/^native-event:v2:[a-f0-9]{32}$/);
    expect(expected.length).toBe(48);
  });

  it("is deterministic, component-sensitive, and safe to apply more than once", () => {
    const compact = compactNativeObservationEventId(legacyId);

    expect(compactNativeObservationEventId(legacyId)).toBe(compact);
    expect(compactNativeObservationEventId(compact)).toBe(compact);
    expect(compactNativeObservationEventId(`${legacyId}:different`)).not.toBe(compact);
  });

  it("leaves unrelated and receipt ids untouched", () => {
    expect(compactNativeObservationEventId("event-1")).toBe("event-1");
    expect(compactNativeObservationEventId("native-receipt:command:accepted:1")).toBe(
      "native-receipt:command:accepted:1",
    );
    expect(compactNativeObservationEventId("native-receipt-event:command:accepted:1")).toBe(
      "native-receipt-event:command:accepted:1",
    );
  });
});
