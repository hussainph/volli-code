import { describe, expect, it } from "vite-plus/test";

import {
  AUTHORITY_ACTOR_KINDS,
  AUTHORITY_DEFAULTS_TOKEN,
  coordinationVerbAllowed,
  DEFAULT_AUTHORITY_POLICY,
  PEEK_DISCLOSURES,
  isEmptyAuthorityPolicyOverride,
  parseAuthorityPolicyOverride,
  resolveAuthorityPolicy,
  validateAuthorityPolicyOverride,
} from "./authority-config";
import { SESSION_AWAIT_KINDS } from "./session-await";
import { TICKET_AWAIT_KINDS } from "./ticket-await";
import { VERB_REGISTRY, verbTier } from "./verb-registry";

describe("DEFAULT_AUTHORITY_POLICY", () => {
  it("keeps the actor disclosure vocabulary and validates it", () => {
    expect(PEEK_DISCLOSURES).toEqual(["none", "own", "project"]);
    expect(validateAuthorityPolicyOverride({ actors: { user: { peek: "all" } } })).toEqual({
      ok: false,
      errors: ["actors.user.peek must be one of: none, own, project."],
    });
  });

  it("asks at a spent delegation allowance rather than refusing outright (VC-204)", () => {
    // The allowance itself stays fixed; what softened is only what its end
    // does. `refuse` remains available per project for unattended fleets.
    expect(DEFAULT_AUTHORITY_POLICY.budgets.delegationExceeded).toBe("ask");
  });

  it("gives an unauthenticated caller reads and nothing else (VC-92 ruling 2)", () => {
    const anonymous = DEFAULT_AUTHORITY_POLICY.actors.unauthenticated;
    expect(anonymous.coordinationVerbs).toEqual([]);
    expect(anonymous.peek).toBe("none");
    expect(anonymous.awaitable).toEqual([]);
    expect(anonymous.awaitableSessions).toEqual([]);
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

  it("takes the same posture on the Session vocabulary, in a list of its own (VC-324)", () => {
    // Two lists, never one merged vocabulary: `signal` is a Ticket verdict and
    // `verdict` is a Session's own, and a project must be able to allow one
    // without the other.
    expect(DEFAULT_AUTHORITY_POLICY.actors.user.awaitableSessions).toEqual([
      ...SESSION_AWAIT_KINDS,
    ]);
    expect(DEFAULT_AUTHORITY_POLICY.actors.session.awaitableSessions).toEqual([
      ...SESSION_AWAIT_KINDS,
    ]);
  });

  it("names a policy for every actor kind, so no caller falls through the table", () => {
    for (const kind of AUTHORITY_ACTOR_KINDS) {
      expect(DEFAULT_AUTHORITY_POLICY.actors[kind]).toBeDefined();
    }
  });
});

describe("resolveAuthorityPolicy", () => {
  it("resolves budget and actor departures without changing unstated defaults", () => {
    const policy = resolveAuthorityPolicy({
      budgets: { delegationExceeded: "refuse" },
      actors: { session: { peek: "project" } },
    });
    expect(policy.budgets.delegationExceeded).toBe("refuse");
    expect(policy.actors.session.peek).toBe("project");
    expect(policy.actors.user).toEqual(DEFAULT_AUTHORITY_POLICY.actors.user);
    expect(policy.actors.unauthenticated).toEqual(DEFAULT_AUTHORITY_POLICY.actors.unauthenticated);
  });
  it("answers the defaults for a project that states nothing", () => {
    expect(resolveAuthorityPolicy(null)).toEqual(DEFAULT_AUTHORITY_POLICY);
    expect(resolveAuthorityPolicy(undefined)).toEqual(DEFAULT_AUTHORITY_POLICY);
    expect(resolveAuthorityPolicy({})).toEqual(DEFAULT_AUTHORITY_POLICY);
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

  /**
   * A verb the defaults do NOT carry, which is the only kind that can show the
   * splice. These two cases used `worktree.sync` until VC-185 shipped it as a
   * default — at which point the splice de-duplicated it and the tests were
   * asserting the de-duplication instead of the position. The merge queue's
   * submission verb (VC-89, still deferred) is the honest stand-in: a verb a
   * project might one day widen its Sessions to, that no default grants.
   */
  const NOT_A_DEFAULT = "queue.submit";

  it("splices the defaults in where the token sits, so extending is the ordinary act", () => {
    const resolved = resolveAuthorityPolicy({
      actors: { session: { coordinationVerbs: [AUTHORITY_DEFAULTS_TOKEN, NOT_A_DEFAULT] } },
    });
    expect(resolved.actors.session.coordinationVerbs).toEqual([...defaults, NOT_A_DEFAULT]);
  });

  it("preserves position, so a project may put its own entries first", () => {
    const resolved = resolveAuthorityPolicy({
      actors: { session: { coordinationVerbs: [NOT_A_DEFAULT, AUTHORITY_DEFAULTS_TOKEN] } },
    });
    expect(resolved.actors.session.coordinationVerbs).toEqual([NOT_A_DEFAULT, ...defaults]);
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

  it("splices the Session awaitable list independently of the Ticket one", () => {
    const resolved = resolveAuthorityPolicy({
      actors: { session: { awaitableSessions: ["stopped"] } },
    });
    expect(resolved.actors.session.awaitableSessions).toEqual(["stopped"]);
    // Narrowing one list leaves the other exactly as the defaults had it.
    expect(resolved.actors.session.awaitable).toEqual([...TICKET_AWAIT_KINDS]);
  });

  it("resolves a document written before the Session list existed to the defaults", () => {
    // Tolerant on read: an older stored override records departures only, so an
    // absent field must inherit rather than deny.
    const resolved = resolveAuthorityPolicy({ actors: { session: { peek: "none" } } });
    expect(resolved.actors.session.awaitableSessions).toEqual([...SESSION_AWAIT_KINDS]);
  });
});

describe("parseAuthorityPolicyOverride", () => {
  it("answers null for anything that is not a document", () => {
    expect(parseAuthorityPolicyOverride(null)).toBeNull();
    expect(parseAuthorityPolicyOverride(undefined)).toBeNull();
    expect(parseAuthorityPolicyOverride("enforce")).toBeNull();
    expect(parseAuthorityPolicyOverride([1, 2])).toBeNull();
    expect(parseAuthorityPolicyOverride(7)).toBeNull();
  });

  it("reads a budget posture and drops one outside the vocabulary", () => {
    expect(parseAuthorityPolicyOverride({ budgets: { delegationExceeded: "refuse" } })).toEqual({
      budgets: { delegationExceeded: "refuse" },
    });
    expect(parseAuthorityPolicyOverride({ budgets: { delegationExceeded: "warn" } })).toEqual({});
    expect(parseAuthorityPolicyOverride({ budgets: "refuse" })).toEqual({});
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

  it("reads the two await vocabularies apart, so neither admits the other's words", () => {
    expect(
      parseAuthorityPolicyOverride({
        actors: { session: { awaitableSessions: [AUTHORITY_DEFAULTS_TOKEN, "turn"] } },
      }),
    ).toEqual({
      actors: { session: { awaitableSessions: [AUTHORITY_DEFAULTS_TOKEN, "turn"] } },
    });
    // Every Session kind is admitted to its own list, not just `turn`.
    expect(
      parseAuthorityPolicyOverride({
        actors: { session: { awaitableSessions: ["verdict", "stopped"] } },
      }),
    ).toEqual({ actors: { session: { awaitableSessions: ["verdict", "stopped"] } } });
    // A Ticket kind in the Session list, and a Session kind in the Ticket one.
    expect(
      parseAuthorityPolicyOverride({ actors: { session: { awaitableSessions: ["comment"] } } }),
    ).toEqual({});
    expect(
      parseAuthorityPolicyOverride({ actors: { session: { awaitable: ["verdict"] } } }),
    ).toEqual({});
    expect(
      parseAuthorityPolicyOverride({ actors: { session: { awaitableSessions: "all" } } }),
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
});

/**
 * The WRITE half (VC-172). Its whole reason to exist is refusing what the read
 * half drops, so most of what follows is the same input given to both.
 */
describe("validateAuthorityPolicyOverride", () => {
  it("rejects malformed actor containers and unknown actor fields", () => {
    for (const actors of [null, "all", []]) {
      expect(validateAuthorityPolicyOverride({ actors })).toEqual({
        ok: false,
        errors: ["actors must be an object."],
      });
    }
    for (const session of [null, "all", []]) {
      expect(validateAuthorityPolicyOverride({ actors: { session } })).toEqual({
        ok: false,
        errors: ["actors.session must be an object."],
      });
    }
    expect(validateAuthorityPolicyOverride({ actors: { session: { peeking: "own" } } })).toEqual({
      ok: false,
      errors: ["Unknown field: actors.session.peeking."],
    });
    expect(validateAuthorityPolicyOverride({ actors: { robot: {} } })).toEqual({
      ok: false,
      errors: ["Unknown field: actors.robot."],
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

  it("refuses a budget the read path would drop, naming the field and the vocabulary", () => {
    expect(validateAuthorityPolicyOverride({ budgets: { delegationExceeded: "warn" } })).toEqual({
      ok: false,
      errors: ["budgets.delegationExceeded must be one of: ask, refuse."],
    });
    expect(validateAuthorityPolicyOverride({ budgets: { delegationCap: 5 } })).toEqual({
      ok: false,
      errors: ["Unknown field: budgets.delegationCap."],
    });
    expect(validateAuthorityPolicyOverride({ budgets: ["ask"] })).toEqual({
      ok: false,
      errors: ["budgets must be an object."],
    });
    const stated = validateAuthorityPolicyOverride({ budgets: { delegationExceeded: "refuse" } });
    expect(stated).toEqual({ ok: true, override: { budgets: { delegationExceeded: "refuse" } } });
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

  it("validates the Session await list against its own vocabulary", () => {
    expect(
      validateAuthorityPolicyOverride({ actors: { session: { awaitableSessions: "all" } } }),
    ).toEqual({
      ok: false,
      errors: ["actors.session.awaitableSessions must be an array."],
    });
    expect(
      validateAuthorityPolicyOverride({ actors: { session: { awaitableSessions: ["comment"] } } }),
    ).toEqual({
      ok: false,
      errors: [
        `actors.session.awaitableSessions entries must be one of: ${[
          ...SESSION_AWAIT_KINDS,
          AUTHORITY_DEFAULTS_TOKEN,
        ].join(", ")}.`,
      ],
    });
    expect(
      validateAuthorityPolicyOverride({
        actors: { session: { awaitableSessions: [AUTHORITY_DEFAULTS_TOKEN, "verdict"] } },
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

  it("refuses anything that is not an object at all", () => {
    for (const bad of [null, [], "enforce", 3]) {
      expect(validateAuthorityPolicyOverride(bad)).toEqual({
        ok: false,
        errors: ["A policy override must be an object."],
      });
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
    // A `user` verb (VC-623) is coordination tier but never a Session's: the
    // admission gate judges it by the door's actor and reads no list for it.
    const coordination = VERB_REGISTRY.filter(
      (entry) => verbTier(entry) === "coordination" && entry.actor === "session",
    ).map((entry) => entry.key);

    expect(coordination.length).toBeGreaterThan(0);
    for (const verb of coordination) {
      expect(coordinationVerbAllowed(policy, "session", verb), verb).toBe(true);
    }
  });

  it("lists no person-only verb for any actor kind, by default (VC-623)", () => {
    for (const entry of VERB_REGISTRY.filter((candidate) => candidate.actor === "user")) {
      for (const kind of AUTHORITY_ACTOR_KINDS) {
        expect(coordinationVerbAllowed(policy, kind, entry.key), `${kind} ${entry.key}`).toBe(
          false,
        );
      }
    }
  });

  it("refuses a verb no policy lists, whoever asks", () => {
    for (const kind of AUTHORITY_ACTOR_KINDS) {
      expect(coordinationVerbAllowed(policy, kind, "verb.that.does.not.exist")).toBe(false);
    }
  });
});
