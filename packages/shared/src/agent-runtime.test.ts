import { describe, expect, it } from "vite-plus/test";

import { askChoice, askOffer, REASONING_LEVELS, type RuntimeAskRequest } from "./agent-runtime";
import {
  SESSION_ESCALATION_OPTIONS,
  SESSION_ESCALATION_STOP_ID,
  SESSION_PERMISSION_OPTIONS,
} from "./session-ledger";

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
    toolCallId: "call-1",
    turnId: "turn-1",
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
  });

  it("mints once and reject as the same objects SESSION_PERMISSION_OPTIONS defines, not rebuilt copies", () => {
    const offer = askOffer(askRequest({ overridable: true }));
    const once = SESSION_PERMISSION_OPTIONS.find((option) => option.id === "once")!;
    const reject = SESSION_PERMISSION_OPTIONS.find((option) => option.id === "reject")!;

    expect(offer.options[0]).toBe(once);
    expect(offer.options[1]).toBe(reject);
  });

  it("offers exactly continue and stop for a non-overridable ask", () => {
    const offer = askOffer(askRequest({ overridable: false }));

    expect(offer.kind).toBe("question");
    expect(offer.options.map((option) => option.id)).toEqual(["continue", "stop"]);
  });

  it("mints the non-overridable pair as the exact SESSION_ESCALATION_OPTIONS array, not a rebuilt equivalent", () => {
    const offer = askOffer(askRequest({ overridable: false }));

    expect(offer.options).toBe(SESSION_ESCALATION_OPTIONS);
  });
});

describe("askChoice", () => {
  it("round-trips every option askOffer offers for an overridable ask", () => {
    const request = askRequest({ overridable: true });
    const offer = askOffer(request);

    expect(askChoice(request, ["once"])).toBe("allow");
    expect(askChoice(request, ["reject"])).toBe("refuse");
    expect(offer.options.map((option) => option.id)).toEqual(["once", "reject"]);
  });

  it("resolves every id askOffer's non-overridable arm actually offers", () => {
    const request = askRequest({ overridable: false });
    const offer = askOffer(request);

    for (const option of offer.options) {
      const expected = option.id === SESSION_ESCALATION_STOP_ID ? "stop" : "refuse";
      expect(askChoice(request, [option.id])).toBe(expected);
    }
  });

  it("refuses an overridable ask with no recognised id, including one from the non-overridable pair", () => {
    const request = askRequest({ overridable: true });

    expect(askChoice(request, [])).toBe("refuse");
    expect(askChoice(request, ["unknown"])).toBe("refuse");
    expect(askChoice(request, ["stop"])).toBe("refuse");
  });

  it("refuses a non-overridable ask with no recognised id, including one from the overridable pair", () => {
    const request = askRequest({ overridable: false });

    expect(askChoice(request, [])).toBe("refuse");
    expect(askChoice(request, ["unknown"])).toBe("refuse");
    expect(askChoice(request, ["once"])).toBe("refuse");
  });

  it("resolves to the recognised id's outcome when the answer carries extra noise", () => {
    const overridable = askRequest({ overridable: true });
    const nonOverridable = askRequest({ overridable: false });

    expect(askChoice(overridable, ["mystery", "once", "unrelated"])).toBe("allow");
    expect(askChoice(nonOverridable, ["mystery", "stop", "unrelated"])).toBe("stop");
  });

  it("refuses an overridable ask whose answer carries both once and reject, rather than executing it", () => {
    const request = askRequest({ overridable: true });

    expect(askChoice(request, ["once", "reject"])).toBe("refuse");
  });

  it("treats every SESSION_REFUSAL_OPTION_IDS member as refusal, not only reject", () => {
    const overridable = askRequest({ overridable: true });
    const nonOverridable = askRequest({ overridable: false });

    expect(askChoice(overridable, ["deny"])).toBe("refuse");
    expect(askChoice(nonOverridable, ["deny"])).toBe("refuse");
  });

  it("reads option ids case-insensitively", () => {
    expect(askChoice(askRequest({ overridable: true }), ["REJECT"])).toBe("refuse");
    expect(askChoice(askRequest({ overridable: false }), ["Stop"])).toBe("stop");
  });
});
