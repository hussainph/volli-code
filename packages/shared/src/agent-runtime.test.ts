import { describe, expect, it } from "vite-plus/test";

import {
  askChoice,
  askOffer,
  REASONING_LEVELS,
  sessionToolBindings,
  sessionToolIds,
  UtilityCompletionError,
  type RuntimeAskRequest,
  type RuntimeBrowserPort,
} from "./agent-runtime";
import type { SessionUsage } from "./session-usage";
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
 * Stands in for a wired Browser port. Never called, for {@link port}'s reason:
 * membership reads presence, and the six browser tools ride this one port
 * together — a Session with somewhere to send a browser action has all of
 * them, and one with nowhere has none.
 */
const browserPort: RuntimeBrowserPort = {
  tabs: port,
  navigate: port,
  snapshot: port,
  act: port,
  screenshot: port,
  console: port,
};

/**
 * The verb port, which unlike the three above decides no membership — the
 * bundle does. Kept apart because it has a return type the others do not.
 */
const verbPort = async () => ({ text: "a verb port fixture is presence only" });

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

  it("offers all six browser tools together exactly when the one Browser port is wired", () => {
    // One port, six names: listing, navigating, snapshotting, acting, shooting
    // and reading the console are one capability with one answerer, so a spec
    // cannot offer a Session the ability to look without the ability to act —
    // that split is a later grant design, not a port shape.
    expect(sessionToolIds({ tools: { tools: [] }, browser: browserPort })).toEqual([
      "browser_tabs",
      "browser_navigate",
      "browser_snapshot",
      "browser_act",
      "browser_screenshot",
      "browser_console",
    ]);
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
      browser: browserPort,
    });

    for (const tool of NON_CODING_TOOL_IDS) expect(everything).toContain(tool);
    expect(everything).toHaveLength(13);
  });

  it("puts the Role's verbs last, after every capability tool (VC-162)", () => {
    // Appending the verb half is what keeps a verb added in a later product
    // version from shifting the position of anything already in a Session's
    // frozen record — which would be a full Cache Prefix miss for a surface
    // that did not otherwise change.
    expect(
      sessionToolIds({
        tools: { tools: ["read", "edit"], verbs: ["session.start"] },
        askUser: port,
        callVerb: verbPort,
      }),
    ).toEqual(["read", "edit", "ask_user", "session.start"]);
  });

  it("carries the port on the verb binding, so the runtime never null-checks one", () => {
    const bindings = sessionToolBindings({
      tools: { tools: [], verbs: ["session.start"] },
      callVerb: verbPort,
    });

    // The dot-key twice: once as the surface name every durable record spells,
    // once as the verb the host is asked to run. The provider-safe rendering
    // belongs to the runtime adapter and appears nowhere in here.
    expect(bindings).toEqual([{ tool: "session.start", verb: "session.start", port: verbPort }]);
  });

  it("refuses to build a surface whose bundle names a verb nothing can answer", () => {
    // Unlike an interaction port, this one decides no membership — the bundle
    // does. So a missing port is not a smaller surface; it is a Session whose
    // record claims a tool that was never offered, and that disagreement is
    // exactly what this derivation exists to make unrepresentable.
    expect(() => sessionToolIds({ tools: { tools: ["read"], verbs: ["session.start"] } })).toThrow(
      "This Session's bundle names session.start, but no verb port is wired to answer it.",
    );
  });
});

/**
 * The bill has to survive the throw.
 *
 * A provider charges for the prompt it accepted, not for whether the caller
 * could use the answer — so a utility completion that failed after being billed
 * is real spend, and it reaches its caller as an exception. Carrying the usage
 * on the error is what stops failed background work being the one kind of model
 * call a Session can never account for.
 */
describe("UtilityCompletionError", () => {
  const usage: SessionUsage = {
    cause: "utility",
    providerId: "anthropic",
    modelId: "claude-haiku-4-5",
    inputTokens: 210,
    outputTokens: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: 0.000_31,
    costBasis: "catalog-estimate",
  };

  it("is an Error a caller can catch by type, carrying what the call consumed", () => {
    const error = new UtilityCompletionError("The utility completion returned no text.", usage);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(UtilityCompletionError);
    expect(error.name).toBe("UtilityCompletionError");
    expect(error.message).toBe("The utility completion returned no text.");
    expect(error.usage).toEqual(usage);
  });

  // Null means nothing reached a provider, never that a request was free.
  it("carries null for a failure that was never billed", () => {
    expect(new UtilityCompletionError("not in this runtime's catalog", null).usage).toBeNull();
  });
});
