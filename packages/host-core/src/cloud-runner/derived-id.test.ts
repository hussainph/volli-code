import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_COMMAND_ID_NAMESPACE,
  AUTOMATION_RUN_ID_NAMESPACE,
  agentToolCommandId,
  automationRunIds,
  nameBasedUuid,
} from "./derived-id";

const runId = "12121212-2222-4333-8444-555555555555";

describe("runner-derived ids", () => {
  it("keep their frozen namespaces and spellings (cross-checked with Python's hashlib + uuid)", () => {
    expect(AUTOMATION_RUN_ID_NAMESPACE).toBe("bca938ed-df6e-465f-ad91-858129e62788");
    expect(AGENT_COMMAND_ID_NAMESPACE).toBe("e831af85-72f9-4b49-9a3d-0ce5e28fb083");
    expect(automationRunIds(runId)).toEqual({
      operationId: `automation-run:${runId}`,
      messageCommandId: "8a36dee5-ce77-864c-ac80-06a90b141764",
      messageId: "dadb07ef-a342-82bd-8e25-e9cb4ab04d3c",
    });
    expect(agentToolCommandId("s1", "call-1")).toBe("15545ca5-1f4d-8a28-abcf-a2983ac5de65");
  });

  it("are RFC 9562 UUIDv8 and distinct across namespaces and parts", () => {
    const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const ids = [
      nameBasedUuid(AUTOMATION_RUN_ID_NAMESPACE, "a"),
      nameBasedUuid(AGENT_COMMAND_ID_NAMESPACE, "a"),
      nameBasedUuid(AUTOMATION_RUN_ID_NAMESPACE, "a", "b"),
      nameBasedUuid(AUTOMATION_RUN_ID_NAMESPACE, "a\u0000b", ""),
    ];
    for (const id of ids) expect(id).toMatch(shape);
    expect(new Set(ids.slice(0, 3)).size).toBe(3);
  });
});
