import { describe, expect, it } from "vite-plus/test";

import {
  AUTHORITY_ACTOR_KINDS,
  AUTHORITY_DEFAULTS_TOKEN,
  AUTHORITY_ENFORCEMENTS,
  coordinationVerbAllowed,
  DEFAULT_AUTHORITY_POLICY,
  JUDGMENT_MODES,
  PEEK_DISCLOSURES,
  isEmptyAuthorityPolicyOverride,
  parseAuthorityPolicyOverride,
  resolveAuthorityPolicy,
  validateAuthorityPolicyOverride,
} from "./authority-config";
import { TICKET_AWAIT_KINDS } from "./ticket-await";
import { VERB_REGISTRY, verbTier } from "./verb-registry";

describe("DEFAULT_AUTHORITY_POLICY", () => {
  it("observes rather than enforces, which is VC-44's recorded day-one posture", () => {
    // Enforcing the nine-rule pack on day one refuses reads the product itself
    // asks for: a personal-tier SKILL.md the skills index points at, and the
    // Main checkout a ticket brief offers as reference. Both are outside the
    // Session workspace. `observe` pins the Snapshot without re-activating a
    // pack that has been dormant since the sandbox came out.
    expect(DEFAULT_AUTHORITY_POLICY.enforcement).toBe("observe");
  });

  it("asks a person rather than naming a classifier that does not exist yet", () => {
    expect(DEFAULT_AUTHORITY_POLICY.judgmentMode).toBe("ask");
    expect(DEFAULT_AUTHORITY_POLICY.classifierModel).toBeNull();
  });

  it("gives an unauthenticated caller reads and nothing else (VC-92 ruling 2)", () => {
    const anonymous = DEFAULT_AUTHORITY_POLICY.actors.unauthenticated;
    expect(anonymous.coordinationVerbs).toEqual([]);
    expect(anonymous.peek).toBe("none");
    expect(anonymous.awaitable).toEqual([]);
  });

  it("lets an authenticated Session read only its own transcript (VC-92 ruling 3)", () => {
    expect(DEFAULT_AUTHORITY_POLICY.actors.session.peek).toBe("own");
  });

  it("grants a Session the coordination verbs it already uses to report progress", () => {
    expect(DEFAULT_AUTHORITY_POLICY.actors.session.coordinationVerbs).toContain("ticket.comment");
    expect(DEFAULT_AUTHORITY_POLICY.actors.session.coordinationVerbs).toContain("session.done");
    // Reporting a verdict is the same act as reporting progress (VC-85), so it
    // is a default rather than something a project has to grant — otherwise the
    // report goes back into a comment and nothing can query it.
    expect(DEFAULT_AUTHORITY_POLICY.actors.session.coordinationVerbs).toContain("ticket.signal");
  });

  it("lets the user and a Session await the whole vocabulary, and an unauthenticated caller nothing (VC-85)", () => {
    expect(DEFAULT_AUTHORITY_POLICY.actors.user.awaitable).toEqual([...TICKET_AWAIT_KINDS]);
    expect(DEFAULT_AUTHORITY_POLICY.actors.session.awaitable).toEqual([...TICKET_AWAIT_KINDS]);
    expect(DEFAULT_AUTHORITY_POLICY.actors.unauthenticated.awaitable).toEqual([]);
  });

  it("names a policy for every actor kind, so no caller falls through the table", () => {
    for (const kind of AUTHORITY_ACTOR_KINDS) {
      expect(DEFAULT_AUTHORITY_POLICY.actors[kind]).toBeDefined();
    }
  });

  it("declares each vocabulary it is written against", () => {
    expect(AUTHORITY_ENFORCEMENTS).toEqual(["off", "observe", "enforce"]);
    expect(JUDGMENT_MODES).toEqual(["ask", "auto"]);
    expect(PEEK_DISCLOSURES).toEqual(["none", "own", "project"]);
  });
});

describe("resolveAuthorityPolicy", () => {
  it("answers the defaults for a project that states nothing", () => {
    expect(resolveAuthorityPolicy(null)).toEqual(DEFAULT_AUTHORITY_POLICY);
    expect(resolveAuthorityPolicy(undefined)).toEqual(DEFAULT_AUTHORITY_POLICY);
    expect(resolveAuthorityPolicy({})).toEqual(DEFAULT_AUTHORITY_POLICY);
  });

  it("takes each stated scalar and inherits every field left unsaid", () => {
    const resolved = resolveAuthorityPolicy({ enforcement: "enforce" });
    expect(resolved.enforcement).toBe("enforce");
    expect(resolved.judgmentMode).toBe(DEFAULT_AUTHORITY_POLICY.judgmentMode);
    expect(resolved.fallback).toEqual(DEFAULT_AUTHORITY_POLICY.fallback);
  });

  it("turns the gate off entirely when a project asks for it", () => {
    expect(resolveAuthorityPolicy({ enforcement: "off" }).enforcement).toBe("off");
  });

  it("distinguishes an explicit null classifier from an unstated one", () => {
    expect(resolveAuthorityPolicy({ classifierModel: null }).classifierModel).toBeNull();
    expect(resolveAuthorityPolicy({ classifierModel: "haiku" }).classifierModel).toBe("haiku");
    expect(resolveAuthorityPolicy({}).classifierModel).toBe(
      DEFAULT_AUTHORITY_POLICY.classifierModel,
    );
  });

  it("takes one fallback threshold without disturbing the other", () => {
    const resolved = resolveAuthorityPolicy({ fallback: { consecutiveDenials: 1 } });
    expect(resolved.fallback.consecutiveDenials).toBe(1);
    expect(resolved.fallback.sessionDenials).toBe(DEFAULT_AUTHORITY_POLICY.fallback.sessionDenials);
  });

  it("takes a judgment mode and a peek disclosure", () => {
    const resolved = resolveAuthorityPolicy({
      judgmentMode: "auto",
      actors: { session: { peek: "project" } },
    });
    expect(resolved.judgmentMode).toBe("auto");
    expect(resolved.actors.session.peek).toBe("project");
  });

  it("resolves an actor the override never mentions", () => {
    const resolved = resolveAuthorityPolicy({ actors: { session: { peek: "none" } } });
    expect(resolved.actors.unauthenticated).toEqual(
      DEFAULT_AUTHORITY_POLICY.actors.unauthenticated,
    );
    expect(resolved.actors.user).toEqual(DEFAULT_AUTHORITY_POLICY.actors.user);
  });
});

describe("additive inheritance", () => {
  const defaults = DEFAULT_AUTHORITY_POLICY.actors.session.coordinationVerbs;

  it("splices the defaults in where the token sits, so extending is the ordinary act", () => {
    const resolved = resolveAuthorityPolicy({
      actors: { session: { coordinationVerbs: [AUTHORITY_DEFAULTS_TOKEN, "worktree.sync"] } },
    });
    expect(resolved.actors.session.coordinationVerbs).toEqual([...defaults, "worktree.sync"]);
  });

  it("preserves position, so a project may put its own entries first", () => {
    const resolved = resolveAuthorityPolicy({
      actors: { session: { coordinationVerbs: ["worktree.sync", AUTHORITY_DEFAULTS_TOKEN] } },
    });
    expect(resolved.actors.session.coordinationVerbs).toEqual(["worktree.sync", ...defaults]);
  });

  it("replaces wholesale when the token is absent, which is the visible act", () => {
    const resolved = resolveAuthorityPolicy({
      actors: { session: { coordinationVerbs: ["ticket.comment"] } },
    });
    expect(resolved.actors.session.coordinationVerbs).toEqual(["ticket.comment"]);
  });

  it("empties a list when a project states an empty one", () => {
    const resolved = resolveAuthorityPolicy({
      actors: { session: { coordinationVerbs: [] } },
    });
    expect(resolved.actors.session.coordinationVerbs).toEqual([]);
  });

  it("de-duplicates, so naming an inherited entry does not repeat it", () => {
    const resolved = resolveAuthorityPolicy({
      actors: { session: { coordinationVerbs: [AUTHORITY_DEFAULTS_TOKEN, "ticket.comment"] } },
    });
    expect(resolved.actors.session.coordinationVerbs).toEqual([...defaults]);
  });

  it("splices the typed awaitable list on the same terms", () => {
    const resolved = resolveAuthorityPolicy({
      actors: { session: { awaitable: ["status", AUTHORITY_DEFAULTS_TOKEN] } },
    });
    expect(resolved.actors.session.awaitable).toEqual(["status", "signal", "comment"]);
  });
});

describe("parseAuthorityPolicyOverride", () => {
  it("reads a document that states everything", () => {
    const parsed = parseAuthorityPolicyOverride({
      enforcement: "enforce",
      judgmentMode: "auto",
      classifierModel: "haiku",
      fallback: { consecutiveDenials: 2, sessionDenials: 30 },
      actors: { unauthenticated: { coordinationVerbs: ["ticket.comment"], peek: "own" } },
    });
    expect(parsed).toEqual({
      enforcement: "enforce",
      judgmentMode: "auto",
      classifierModel: "haiku",
      fallback: { consecutiveDenials: 2, sessionDenials: 30 },
      actors: { unauthenticated: { coordinationVerbs: ["ticket.comment"], peek: "own" } },
    });
  });

  it("answers null for anything that is not a document", () => {
    expect(parseAuthorityPolicyOverride(null)).toBeNull();
    expect(parseAuthorityPolicyOverride(undefined)).toBeNull();
    expect(parseAuthorityPolicyOverride("enforce")).toBeNull();
    expect(parseAuthorityPolicyOverride([1, 2])).toBeNull();
    expect(parseAuthorityPolicyOverride(7)).toBeNull();
  });

  it("answers an empty override for a document that states nothing legible", () => {
    expect(parseAuthorityPolicyOverride({})).toEqual({});
    expect(parseAuthorityPolicyOverride({ enforcement: "yolo" })).toEqual({});
    expect(parseAuthorityPolicyOverride({ judgmentMode: 3 })).toEqual({});
  });

  it("drops the unreadable field and keeps the rest of the document", () => {
    // A misspelled enforcement must not cost a project the per-actor policy
    // stored beside it.
    const parsed = parseAuthorityPolicyOverride({
      enforcement: "ENFORCE",
      actors: { session: { peek: "project" } },
    });
    expect(parsed).toEqual({ actors: { session: { peek: "project" } } });
  });

  it("keeps an explicit null classifier and rejects a non-string one", () => {
    expect(parseAuthorityPolicyOverride({ classifierModel: null })).toEqual({
      classifierModel: null,
    });
    expect(parseAuthorityPolicyOverride({ classifierModel: 12 })).toEqual({});
  });

  it("refuses a threshold that is not a whole number of denials", () => {
    expect(parseAuthorityPolicyOverride({ fallback: { consecutiveDenials: 0 } })).toEqual({});
    expect(parseAuthorityPolicyOverride({ fallback: { consecutiveDenials: -1 } })).toEqual({});
    expect(parseAuthorityPolicyOverride({ fallback: { sessionDenials: 1.5 } })).toEqual({});
    expect(parseAuthorityPolicyOverride({ fallback: { sessionDenials: Number.NaN } })).toEqual({});
    expect(parseAuthorityPolicyOverride({ fallback: "often" })).toEqual({});
    expect(parseAuthorityPolicyOverride({ fallback: null })).toEqual({});
    expect(parseAuthorityPolicyOverride({ fallback: [3] })).toEqual({});
  });

  it("keeps one good threshold beside one bad one", () => {
    expect(
      parseAuthorityPolicyOverride({ fallback: { consecutiveDenials: 5, sessionDenials: 0 } }),
    ).toEqual({ fallback: { consecutiveDenials: 5 } });
  });

  it("drops a whole list rather than silently granting less than it says", () => {
    // Filtering the bad entry out would leave a document whose stored text and
    // resolved meaning disagree, with nothing on the surface to show it.
    expect(
      parseAuthorityPolicyOverride({ actors: { session: { coordinationVerbs: ["a", 7] } } }),
    ).toEqual({});
    expect(
      parseAuthorityPolicyOverride({ actors: { session: { coordinationVerbs: "a" } } }),
    ).toEqual({});
  });

  it("keeps an empty list, which is a project saying none", () => {
    expect(
      parseAuthorityPolicyOverride({ actors: { session: { coordinationVerbs: [] } } }),
    ).toEqual({ actors: { session: { coordinationVerbs: [] } } });
  });

  it("reads only the fixed awaitable vocabulary", () => {
    expect(
      parseAuthorityPolicyOverride({
        actors: { session: { awaitable: [AUTHORITY_DEFAULTS_TOKEN, "comment"] } },
      }),
    ).toEqual({
      actors: { session: { awaitable: [AUTHORITY_DEFAULTS_TOKEN, "comment"] } },
    });
    expect(
      parseAuthorityPolicyOverride({ actors: { session: { awaitable: ["ticket.signal"] } } }),
    ).toEqual({});
  });

  it("ignores an actor kind it does not know, and a malformed actor entry", () => {
    expect(parseAuthorityPolicyOverride({ actors: { robot: { peek: "project" } } })).toEqual({});
    expect(parseAuthorityPolicyOverride({ actors: { session: "all" } })).toEqual({});
    expect(parseAuthorityPolicyOverride({ actors: { session: null } })).toEqual({});
    expect(parseAuthorityPolicyOverride({ actors: { session: [] } })).toEqual({});
    expect(parseAuthorityPolicyOverride({ actors: "everyone" })).toEqual({});
    expect(parseAuthorityPolicyOverride({ actors: null })).toEqual({});
    expect(parseAuthorityPolicyOverride({ actors: [] })).toEqual({});
  });

  it("round-trips a stored document through resolution", () => {
    const stored = JSON.stringify({
      enforcement: "enforce",
      actors: { session: { peek: "none" } },
    });
    const resolved = resolveAuthorityPolicy(parseAuthorityPolicyOverride(JSON.parse(stored)));
    expect(resolved.enforcement).toBe("enforce");
    expect(resolved.actors.session.peek).toBe("none");
    expect(resolved.actors.session.coordinationVerbs).toEqual(
      DEFAULT_AUTHORITY_POLICY.actors.session.coordinationVerbs,
    );
  });
});

/**
 * The WRITE half (VC-172). Its whole reason to exist is refusing what the read
 * half drops, so most of what follows is the same input given to both.
 */
describe("validateAuthorityPolicyOverride", () => {
  it("accepts a document that states only departures", () => {
    const result = validateAuthorityPolicyOverride({
      enforcement: "enforce",
      fallback: { consecutiveDenials: 5 },
      actors: { session: { peek: "project" } },
    });

    expect(result).toEqual({
      ok: true,
      override: {
        enforcement: "enforce",
        fallback: { consecutiveDenials: 5 },
        actors: { session: { peek: "project" } },
      },
    });
  });

  it("accepts an empty document, which states nothing and is not an error", () => {
    const result = validateAuthorityPolicyOverride({});
    expect(result.ok).toBe(true);
    if (result.ok) expect(isEmptyAuthorityPolicyOverride(result.override)).toBe(true);
  });

  it("REFUSES an unknown key that the read path would silently drop", () => {
    // The single most valuable divergence between the two halves. A typo'd
    // field stores cleanly, reads back cleanly, and governs nothing — so on the
    // read path it is indistinguishable from a project that never spoke, and
    // the only place anyone can be told is here.
    expect(parseAuthorityPolicyOverride({ enforcment: "enforce" })).toEqual({});

    const result = validateAuthorityPolicyOverride({ enforcment: "enforce" });
    expect(result).toEqual({ ok: false, errors: ["Unknown field: enforcment."] });
  });

  it("refuses an unknown key nested in fallback or in one actor, naming its path", () => {
    expect(validateAuthorityPolicyOverride({ fallback: { totalDenials: 4 } })).toEqual({
      ok: false,
      errors: ["Unknown field: fallback.totalDenials."],
    });
    expect(validateAuthorityPolicyOverride({ actors: { session: { peeking: "own" } } })).toEqual({
      ok: false,
      errors: ["Unknown field: actors.session.peeking."],
    });
    expect(validateAuthorityPolicyOverride({ actors: { robot: {} } })).toEqual({
      ok: false,
      errors: ["Unknown field: actors.robot."],
    });
  });

  it("refuses a value outside each enum, listing what was allowed", () => {
    expect(validateAuthorityPolicyOverride({ enforcement: "enforced" })).toEqual({
      ok: false,
      errors: [`enforcement must be one of: ${AUTHORITY_ENFORCEMENTS.join(", ")}.`],
    });
    expect(validateAuthorityPolicyOverride({ judgmentMode: "classifier" })).toEqual({
      ok: false,
      errors: [`judgmentMode must be one of: ${JUDGMENT_MODES.join(", ")}.`],
    });
    expect(validateAuthorityPolicyOverride({ actors: { user: { peek: "all" } } })).toEqual({
      ok: false,
      errors: [`actors.user.peek must be one of: ${PEEK_DISCLOSURES.join(", ")}.`],
    });
  });

  it("refuses a threshold that is not a whole number of denials, 1 or greater", () => {
    // `AuthorityEscalation` reads 0 and negatives as "never escalate", so a
    // stored 0 disables escalation while looking configured. The read path
    // drops it; this is where someone finds out.
    for (const bad of [0, -1, 2.5, "3", null]) {
      expect(validateAuthorityPolicyOverride({ fallback: { sessionDenials: bad } })).toEqual({
        ok: false,
        errors: ["fallback.sessionDenials must be a whole number of denials, 1 or greater."],
      });
    }
    expect(validateAuthorityPolicyOverride({ fallback: { sessionDenials: 1 } }).ok).toBe(true);
  });

  it("treats classifierModel: null as a statement and its absence as inheritance", () => {
    // `null` MEANS "no classifier" against a default that names one; only
    // `undefined` inherits. `resolveAuthorityPolicy` tests this field with
    // `=== undefined` for exactly this reason, so the write must keep the two
    // distinguishable.
    const stated = validateAuthorityPolicyOverride({ classifierModel: null });
    expect(stated.ok && "classifierModel" in stated.override).toBe(true);

    const absent = validateAuthorityPolicyOverride({});
    expect(absent.ok && "classifierModel" in absent.override).toBe(false);

    expect(validateAuthorityPolicyOverride({ classifierModel: 7 })).toEqual({
      ok: false,
      errors: ["classifierModel must be a string or null."],
    });
  });

  it("refuses a list whole when any entry is not a string", () => {
    // `parseStringList`'s all-or-nothing rule: a list that lost one entry
    // grants something different from what the document says.
    expect(
      validateAuthorityPolicyOverride({ actors: { session: { coordinationVerbs: ["a", 3] } } }),
    ).toEqual({
      ok: false,
      errors: ["actors.session.coordinationVerbs must contain only strings."],
    });
    expect(
      validateAuthorityPolicyOverride({ actors: { session: { coordinationVerbs: "all" } } }),
    ).toEqual({
      ok: false,
      errors: ["actors.session.coordinationVerbs must be an array of strings."],
    });
    expect(validateAuthorityPolicyOverride({ actors: { session: { awaitable: "all" } } })).toEqual({
      ok: false,
      errors: ["actors.session.awaitable must be an array."],
    });
  });

  it("refuses inert awaitable names instead of persisting a silent typo", () => {
    for (const awaitable of [["ticket.signal"], ["x"], ["signal", 3]]) {
      expect(validateAuthorityPolicyOverride({ actors: { session: { awaitable } } })).toEqual({
        ok: false,
        errors: [
          `actors.session.awaitable entries must be one of: ${[
            ...TICKET_AWAIT_KINDS,
            AUTHORITY_DEFAULTS_TOKEN,
          ].join(", ")}.`,
        ],
      });
    }

    expect(
      validateAuthorityPolicyOverride({
        actors: { session: { awaitable: [AUTHORITY_DEFAULTS_TOKEN, "status"] } },
      }).ok,
    ).toBe(true);
  });

  it("accepts the $defaults token as the ordinary string it is", () => {
    // The token needs no special case, and a list omitting it REPLACES rather
    // than extends — a legal thing to mean, and the reason the token is a token.
    const spliced = validateAuthorityPolicyOverride({
      actors: { session: { coordinationVerbs: [AUTHORITY_DEFAULTS_TOKEN, "deploy.run"] } },
    });
    expect(spliced.ok).toBe(true);
    if (!spliced.ok) return;
    expect(resolveAuthorityPolicy(spliced.override).actors.session.coordinationVerbs).toEqual([
      ...DEFAULT_AUTHORITY_POLICY.actors.session.coordinationVerbs,
      "deploy.run",
    ]);

    const replaced = validateAuthorityPolicyOverride({
      actors: { session: { coordinationVerbs: ["deploy.run"] } },
    });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(resolveAuthorityPolicy(replaced.override).actors.session.coordinationVerbs).toEqual([
      "deploy.run",
    ]);
  });

  it("reports EVERY reason at once rather than the first", () => {
    // A person fixing one field only to be told about the next is the
    // interaction a batch exists to avoid.
    const result = validateAuthorityPolicyOverride({
      enforcement: "enforced",
      judgmentMode: "classifier",
      fallback: { consecutiveDenials: 0 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(3);
  });

  it("refuses a non-object where a document is expected, naming the slot", () => {
    // The shapes the parse half answers `{}` for, given to the half that can
    // say WHERE the document stopped being one. A nested slot that is not an
    // object is the write-side failure a hand-edited column would hit first.
    expect(validateAuthorityPolicyOverride({ fallback: "often" })).toEqual({
      ok: false,
      errors: ["fallback must be an object."],
    });
    expect(validateAuthorityPolicyOverride({ actors: "everyone" })).toEqual({
      ok: false,
      errors: ["actors must be an object."],
    });
    expect(validateAuthorityPolicyOverride({ actors: { session: "all" } })).toEqual({
      ok: false,
      errors: ["actors.session must be an object."],
    });
  });

  it("refuses anything that is not an object at all", () => {
    for (const bad of [null, [], "enforce", 3]) {
      expect(validateAuthorityPolicyOverride(bad)).toEqual({
        ok: false,
        errors: ["A policy override must be an object."],
      });
    }
  });

  it("drops an emptied nested object rather than storing it as a departure", () => {
    // `{}` under `actors` says nothing, and must not read back as though the
    // project stated something about its actors.
    const result = validateAuthorityPolicyOverride({ actors: { session: {} }, fallback: {} });
    expect(result.ok).toBe(true);
    if (result.ok) expect(isEmptyAuthorityPolicyOverride(result.override)).toBe(true);
  });

  it("knows every actor kind and every enum member without being told twice", () => {
    // Guards the enums against drifting from the validator's own tables.
    for (const kind of AUTHORITY_ACTOR_KINDS) {
      expect(validateAuthorityPolicyOverride({ actors: { [kind]: { peek: "none" } } }).ok).toBe(
        true,
      );
    }
    for (const enforcement of AUTHORITY_ENFORCEMENTS) {
      expect(validateAuthorityPolicyOverride({ enforcement }).ok).toBe(true);
    }
    for (const judgmentMode of JUDGMENT_MODES) {
      expect(validateAuthorityPolicyOverride({ judgmentMode }).ok).toBe(true);
    }
  });
});

/**
 * The policy read VC-44 wrote this store for, and VC-163 wired to the door.
 *
 * VC-44's own comment named the split: "Read by VC-163 at the socket door …
 * nothing in this ticket enforces any of it." These are the enforcement tests.
 */
describe("coordinationVerbAllowed", () => {
  const policy = DEFAULT_AUTHORITY_POLICY;

  it("lets an authenticated Session run the verbs it works with", () => {
    for (const verb of ["ticket.comment", "ticket.move", "session.done", "notify"]) {
      expect(coordinationVerbAllowed(policy, "session", verb)).toBe(true);
    }
  });

  // The ticket's default posture, as one assertion: reads only. Every
  // coordination verb in the product is refused for a caller Volli could not
  // authenticate, without a project having to say anything.
  it("refuses every coordination verb to an unauthenticated caller by default", () => {
    for (const verb of [
      "ticket.create",
      "ticket.update",
      "ticket.move",
      "ticket.comment",
      "notify",
      "session.done",
      "session.blocked",
      "session.link",
      "session.harness",
      "hook",
    ]) {
      expect(coordinationVerbAllowed(policy, "unauthenticated", verb)).toBe(false);
    }
  });

  it("honours a project that granted one verb to unauthenticated callers", () => {
    const granted = resolveAuthorityPolicy({
      actors: { unauthenticated: { coordinationVerbs: ["ticket.comment"] } },
    });

    expect(coordinationVerbAllowed(granted, "unauthenticated", "ticket.comment")).toBe(true);
    // Granting one grants exactly one: the list replaces, and nothing about
    // commenting implies moving a Ticket.
    expect(coordinationVerbAllowed(granted, "unauthenticated", "ticket.move")).toBe(false);
  });

  it("lets a project withdraw a verb from its own Sessions", () => {
    const narrowed = resolveAuthorityPolicy({
      actors: { session: { coordinationVerbs: ["ticket.comment"] } },
    });

    expect(coordinationVerbAllowed(narrowed, "session", "ticket.comment")).toBe(true);
    expect(coordinationVerbAllowed(narrowed, "session", "ticket.move")).toBe(false);
  });

  // The invariant that would have caught VC-163's own bug. The default session
  // list was hand-written by VC-44 while nothing read it, and it had drifted
  // from VC-92 §3: `session.harness` and `hook` were missing, so wiring the
  // policy to the door would have silently refused every Session the two
  // involuntary channels its harness reports through.
  //
  // Derived from the registry rather than restated, so a coordination verb
  // added later fails here until someone decides whether a Session holds it.
  it("grants a Session every coordination-tier verb the registry declares", () => {
    const coordination = VERB_REGISTRY.filter((entry) => verbTier(entry) === "coordination").map(
      (entry) => entry.key,
    );

    expect(coordination.length).toBeGreaterThan(0);
    for (const verb of coordination) {
      expect(coordinationVerbAllowed(policy, "session", verb), verb).toBe(true);
    }
  });

  it("refuses a verb no policy lists, whoever asks", () => {
    for (const kind of AUTHORITY_ACTOR_KINDS) {
      expect(coordinationVerbAllowed(policy, kind, "verb.that.does.not.exist")).toBe(false);
    }
  });
});
