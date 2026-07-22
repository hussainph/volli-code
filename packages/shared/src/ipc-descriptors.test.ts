import { describe, expect, it } from "vite-plus/test";
import { DATA_CHANNELS, DATA_IPC } from "./ipc-descriptors";

describe("DATA_IPC descriptor table", () => {
  describe("volli:data-bootstrap (no-arg request)", () => {
    const { guard } = DATA_IPC["volli:data-bootstrap"];

    it("accepts an empty args tuple", () => {
      expect(guard([])).toBe(true);
    });

    it("rejects stray arguments", () => {
      expect(guard(["junk"])).toBe(false);
    });
  });

  describe("volli:ticket-move (single object request)", () => {
    const { guard, invalidError } = DATA_IPC["volli:ticket-move"];
    const valid = { projectId: "p1", ticketId: "t1", toStatus: "doing", toIndex: 0 };

    it("accepts a valid move payload", () => {
      expect(guard([valid])).toBe(true);
    });

    it("rejects a status outside the ticket vocabulary", () => {
      expect(guard([{ ...valid, toStatus: "review" }])).toBe(false);
    });

    it("rejects a fractional index", () => {
      expect(guard([{ ...valid, toIndex: 1.5 }])).toBe(false);
    });

    it("rejects a missing ticket id", () => {
      const { ticketId: _ticketId, ...rest } = valid;
      expect(guard([rest])).toBe(false);
    });

    it("rejects a non-object payload", () => {
      expect(guard([null])).toBe(false);
      expect(guard(["t1"])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard([])).toBe(false);
      expect(guard([valid, valid])).toBe(false);
    });

    it("carries the handler's exact invalid-input message", () => {
      expect(invalidError).toBe("Invalid ticket move");
    });
  });

  describe("volli:app-state-set (positional string pair)", () => {
    const { guard } = DATA_IPC["volli:app-state-set"];

    it("accepts a [key, value] string pair", () => {
      expect(guard(["volli:ui", "{}"])).toBe(true);
    });

    it("rejects a non-string member", () => {
      expect(guard(["volli:ui", 42])).toBe(false);
      expect(guard([42, "{}"])).toBe(false);
    });

    it("rejects a wrong arity", () => {
      expect(guard(["volli:ui"])).toBe(false);
      expect(guard(["volli:ui", "{}", "extra"])).toBe(false);
    });
  });

  describe("DATA_CHANNELS derivation", () => {
    it("is exactly the descriptor table's key set — membership cannot be forgotten", () => {
      expect(DATA_CHANNELS).toEqual(Object.keys(DATA_IPC));
    });

    it("covers the tracer channels", () => {
      expect(DATA_CHANNELS).toContain("volli:data-bootstrap");
      expect(DATA_CHANNELS).toContain("volli:ticket-move");
      expect(DATA_CHANNELS).toContain("volli:app-state-set");
    });
  });
});
