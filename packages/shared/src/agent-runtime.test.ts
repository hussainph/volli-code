import { describe, expect, it } from "vite-plus/test";

import {
  askChoice,
  askOffer,
  REASONING_LEVELS,
  sessionToolIds,
  type RuntimeAskRequest,
} from "./agent-runtime";
import { NON_CODING_TOOL_IDS } from "./authority";
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

/**
 * Stands in for any wired port. Never called: what these tests read off a spec
 * is whether a port is *there*, which is the whole of what decides membership.
 */
const port = async () => {
  throw new Error("a tool port fixture is presence only, and is never invoked");
};

/**
 * The one derivation of a Session's Agent Tool Surface.
 *
 * These are not tests of a list-builder. They are the tests that stand in for a
 * deleted rule: `tool.not-bundled` used to refuse any name the Snapshot did not
 * carry, and it was deletable only because the Snapshot's list and Pi's tool
 * array cannot disagree. This function is that "cannot", so what it guarantees
 * is pinned here rather than left to the runtime that consumes it.
 */
describe("sessionToolIds", () => {
  it("names the bundle alone when no port is wired", () => {
    expect(sessionToolIds({ tools: { tools: ["read", "execute"] } })).toEqual(["read", "execute"]);
  });

  it("names an interaction tool exactly when the port that answers it is wired", () => {
    // Each port is independent of the others: web search discloses a query to a
    // third party and web fetch does not, so a Session may hold either, both or
    // neither.
    expect(sessionToolIds({ tools: { tools: [] }, askUser: port })).toEqual(["ask_user"]);
    expect(sessionToolIds({ tools: { tools: [] }, webFetch: port })).toEqual(["web_fetch"]);
    expect(sessionToolIds({ tools: { tools: [] }, webSearch: port })).toEqual(["web_search"]);
  });

  it("puts the bundle first and the ports in vocabulary order, because the Cache Prefix is computed over it", () => {
    // Declared in this order whatever order the spec's keys arrive in: a
    // Session that reordered its own tool array between attachments would pay a
    // full cache miss for a list that had not changed.
    expect(
      sessionToolIds({
        webSearch: port,
        askUser: port,
        webFetch: port,
        tools: { tools: ["write", "read"] },
      }),
    ).toEqual(["write", "read", "ask_user", "web_fetch", "web_search"]);
  });

  it("names every tool the vocabulary holds, so no name can be offered without being recorded", () => {
    // The guarantee the deleted rule used to make, stated from the other side:
    // a Snapshot built from this call cannot under-report the surface, whatever
    // the surface holds.
    const everything = sessionToolIds({
      tools: { tools: ["read", "edit", "write", "execute"] },
      askUser: port,
      webFetch: port,
      webSearch: port,
    });

    for (const tool of NON_CODING_TOOL_IDS) expect(everything).toContain(tool);
    expect(everything).toHaveLength(7);
  });
});
