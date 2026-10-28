import { describe, expect, it } from "vite-plus/test";

import { migrationDocument, storageProblem } from "@volli/shared/cloud";

import { sessionEventImportRecord } from "./session-event-record";

const SESSION = "00000000-0000-4000-8000-000000000020";
const target = {
  userId: "00000000-0000-4000-8000-000000000901",
  workspaceId: "00000000-0000-4000-8000-000000000902",
  runnerId: "00000000-0000-4000-8000-000000000903",
};

const event = (payload: Record<string, unknown>) => ({
  id: "event-1",
  sessionId: SESSION,
  sequence: 3,
  occurredAt: 1,
  recordedAt: 2,
  provenance: { source: { kind: "adapter", id: "pi", detail: { $schema: "p" } }, venue: null },
  attachmentId: null,
  commandId: null,
  payload,
});

describe("sessionEventImportRecord", () => {
  it("sends the payload and provenance as the text the backend stores", () => {
    const record = event({ kind: "brand.new.kind", value: { $ref: "#/x", ключ: 1 } });
    const sent = sessionEventImportRecord(record);
    expect(sent).toMatchObject({
      id: "event-1",
      payload: JSON.stringify(record.payload),
      provenance: JSON.stringify(record.provenance),
      kindKnown: false,
      quarantine: null,
    });
    // A wire argument: no key the backend refuses anywhere, and nothing spilled.
    expect(storageProblem(sent)).toBeNull();
    const doc = migrationDocument("sessionEvents", sent, target, 1);
    expect(doc).toMatchObject({
      payload: sent.payload,
      kind: "brand.new.kind",
      bytes:
        Buffer.byteLength(sent.payload as string) + Buffer.byteLength(sent.provenance as string),
    });
  });

  it("quarantines a known kind this build cannot read, with the codec's words", () => {
    const sent = sessionEventImportRecord(event({ kind: "session.created" }));
    expect(sent.kindKnown).toBe(true);
    expect(sent.quarantine).toMatchObject({ code: "malformed_event" });
    expect((sent.quarantine as { detail: string }).detail.length).toBeLessThanOrEqual(1_000);
  });

  it("passes a readable fact as known, and keeps a credential out of the stored text", () => {
    const sent = sessionEventImportRecord({
      ...event({ kind: "session.retitled", title: "A title" }),
      provenance: { source: { kind: "user", id: "u", detail: null }, venue: null },
    });
    expect(sent).toMatchObject({ kindKnown: true, quarantine: null });
    const malformed = sessionEventImportRecord(
      event({ kind: "x.y", nested: { credential: { value: "secret" }, n: Number.NaN } }),
    );
    expect(malformed.payload).not.toContain("secret");
  });
});
