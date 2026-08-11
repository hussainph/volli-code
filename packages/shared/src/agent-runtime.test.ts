import { describe, expect, it } from "vite-plus/test";

import { askOffer, askOutcome, REASONING_LEVELS, type RuntimeAskRequest } from "./agent-runtime";
import { SESSION_PERMISSION_OPTIONS } from "./session-ledger";

describe("REASONING_LEVELS", () => {
  it("keeps the product reasoning policy ordered from disabled through maximum", () => {
    expect(REASONING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});

// `cause` and `overridable` are independent inputs here — neither function reads
// the cause — but the default pair is kept honest anyway: `path.git-internals`
// is one of `OVERRIDABLE_AUTHORITY_RULES`, so a reader who later wires the two
// together does not inherit a fixture that was already contradicting itself.
function askRequest(overrides: Partial<RuntimeAskRequest> = {}): RuntimeAskRequest {
  return {
    cause: "path.git-internals",
    tool: "edit",
    reason: "the sandbox refused this call",
    trip: "consecutive",
    overridable: true,
    ...overrides,
  };
}

describe("askOffer", () => {
  it("offers exactly once and reject for an overridable ask, never always", () => {
    const offer = askOffer(askRequest({ overridable: true }));

    expect(offer.kind).toBe("permission");
    expect(offer.options.map((option) => option.id)).toEqual(["once", "reject"]);
    expect(offer.options.map((option) => option.id)).not.toContain("always");
  });

  it("takes the once and reject labels from SESSION_PERMISSION_OPTIONS rather than restating them", () => {
    const offer = askOffer(askRequest({ overridable: true }));
    const expected = SESSION_PERMISSION_OPTIONS.filter(
      (option) => option.id === "once" || option.id === "reject",
    );

    expect(offer.options).toEqual(expected);
  });

  it("offers exactly continue and stop for a non-overridable ask", () => {
    const offer = askOffer(askRequest({ overridable: false }));

    expect(offer.kind).toBe("question");
    expect(offer.options.map((option) => option.id)).toEqual(["continue", "stop"]);
  });

  it("is unaffected by which fallback trip produced the ask", () => {
    const consecutive = askOffer(askRequest({ overridable: true, trip: "consecutive" }));
    const session = askOffer(askRequest({ overridable: true, trip: "session" }));

    expect(consecutive).toEqual(session);
  });
});

describe("askOutcome", () => {
  it("round-trips every option askOffer offers for an overridable ask", () => {
    const request = askRequest({ overridable: true });
    const offer = askOffer(request);

    expect(askOutcome(request, ["once"])).toBe("allow");
    expect(askOutcome(request, ["reject"])).toBe("refuse");
    expect(offer.options.map((option) => option.id)).toEqual(["once", "reject"]);
  });

  it("round-trips every option askOffer offers for a non-overridable ask", () => {
    const request = askRequest({ overridable: false });
    const offer = askOffer(request);

    expect(askOutcome(request, ["stop"])).toBe("stop");
    expect(askOutcome(request, ["continue"])).toBe("refuse");
    expect(offer.options.map((option) => option.id)).toEqual(["continue", "stop"]);
  });

  it("refuses an overridable ask with no recognised id, including one from the non-overridable pair", () => {
    const request = askRequest({ overridable: true });

    expect(askOutcome(request, [])).toBe("refuse");
    expect(askOutcome(request, ["unknown"])).toBe("refuse");
    expect(askOutcome(request, ["stop"])).toBe("refuse");
  });

  it("refuses a non-overridable ask with no recognised id, including one from the overridable pair", () => {
    const request = askRequest({ overridable: false });

    expect(askOutcome(request, [])).toBe("refuse");
    expect(askOutcome(request, ["unknown"])).toBe("refuse");
    expect(askOutcome(request, ["once"])).toBe("refuse");
  });

  it("resolves to the recognised id's outcome when the answer carries extra noise", () => {
    const overridable = askRequest({ overridable: true });
    const nonOverridable = askRequest({ overridable: false });

    expect(askOutcome(overridable, ["mystery", "once", "unrelated"])).toBe("allow");
    expect(askOutcome(nonOverridable, ["mystery", "stop", "unrelated"])).toBe("stop");
  });

  it("is unaffected by which fallback trip produced the ask", () => {
    const consecutive = askRequest({ overridable: true, trip: "consecutive" });
    const session = askRequest({ overridable: true, trip: "session" });

    expect(askOutcome(consecutive, ["once"])).toBe(askOutcome(session, ["once"]));
  });
});
