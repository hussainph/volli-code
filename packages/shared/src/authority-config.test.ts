import { describe, expect, it } from "vite-plus/test";

import {
  AUTHORITY_ACTOR_KINDS,
  AUTHORITY_DEFAULTS_TOKEN,
  AUTHORITY_ENFORCEMENTS,
  DEFAULT_AUTHORITY_POLICY,
  JUDGMENT_MODES,
  PEEK_DISCLOSURES,
  parseAuthorityPolicyOverride,
  resolveAuthorityPolicy,
} from "./authority-config";

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
  });

  it("awaits nothing anywhere, because VC-85 has not defined anything to await", () => {
    for (const kind of AUTHORITY_ACTOR_KINDS) {
      expect(DEFAULT_AUTHORITY_POLICY.actors[kind].awaitable).toEqual([]);
    }
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

  it("splices the awaitable list on the same terms", () => {
    const resolved = resolveAuthorityPolicy({
      actors: { session: { awaitable: [AUTHORITY_DEFAULTS_TOKEN, "ticket.signal"] } },
    });
    expect(resolved.actors.session.awaitable).toEqual(["ticket.signal"]);
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

  it("reads an awaitable list", () => {
    expect(parseAuthorityPolicyOverride({ actors: { session: { awaitable: ["x"] } } })).toEqual({
      actors: { session: { awaitable: ["x"] } },
    });
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
