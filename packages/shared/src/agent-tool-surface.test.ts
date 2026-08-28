import { describe, expect, it } from "vite-plus/test";

import {
  isSessionToolId,
  resolveAgentToolSurface,
  roleVerbBundle,
  verbToolsOf,
  AgentToolSurfaceError,
} from "./agent-tool-surface";
import { CODING_TOOL_IDS, NON_CODING_TOOL_IDS } from "./authority";
import { VERB_REGISTRY, VERB_TOOL_KEYS, verbEntry, verbTier, verbToolsFrom } from "./verb-registry";
import type { VerbEntry } from "./verb-registry";

const EVERY_CODING = [...CODING_TOOL_IDS];
const EVERY_INTERACTION = [...NON_CODING_TOOL_IDS];

function capabilities(overrides: Partial<Parameters<typeof resolveAgentToolSurface>[0]> = {}) {
  return {
    role: "project" as const,
    capabilities: { coding: EVERY_CODING, interaction: EVERY_INTERACTION },
    ...overrides,
  };
}

describe("roleVerbBundle — Role decides what is in the room (VC-92, VC-162)", () => {
  it("gives a Project Session the agent-control family and a Ticket Role's default bundle none", () => {
    // The whole family travels together (VC-92's pairing rule; stop and send
    // joined start in VC-86, and `automation.run` rides with them per VC-134)
    // — shipping part of it would make the bundle no boundary.
    expect(roleVerbBundle("project")).toEqual([
      "session.start",
      "session.stop",
      "session.send",
      "ticket.await",
      "automation.run",
    ]);
    // The default-bundle property is asserted as absence rather than prose. An
    // injected instruction telling a Ticket Session to start ten Sessions has
    // nothing to call, and a durable birth grant is the explicit exception
    // (VC-183), never a bundle edit. `ticket.await` is not part of the
    // agent-control family — waiting controls nobody (VC-85/VC-92).
    expect(roleVerbBundle("ticket")).toEqual(["ticket.await"]);
    // VC-9 defines this one; until then an empty bundle is the honest answer.
    expect(roleVerbBundle("subagent")).toEqual([]);
  });

  it("names only verbs the registry can actually project as tools", () => {
    for (const role of ["project", "ticket", "subagent"] as const) {
      for (const verb of roleVerbBundle(role)) {
        expect(VERB_TOOL_KEYS).toContain(verb);
      }
    }
  });
});

describe("resolveAgentToolSurface — the three sets, kept apart", () => {
  it("resolves capability tools, then the Role's verbs, in canonical order", () => {
    // Verb order is REGISTRY DECLARATION order, not bundle order: stop and
    // send were appended after `automation.run` (VC-86), so they follow it —
    // that is what keeps `ticket.await`'s and `automation.run`'s positions
    // stable inside every tool-surface record frozen before they existed.
    expect(resolveAgentToolSurface(capabilities())).toEqual([
      "read",
      "edit",
      "write",
      "execute",
      "ask_user",
      "web_fetch",
      "web_search",
      "session.start",
      "ticket.await",
      "automation.run",
      "session.stop",
      "session.send",
    ]);
  });

  it("puts an ungranted Ticket Session in a room with no agent-control tool", () => {
    const surface = resolveAgentToolSurface(capabilities({ role: "ticket" }));
    expect(surface).not.toContain("session.start");
    // VC-134's whole enforcement, stated as absence: an Automation Run fans a
    // sweep out across Tickets, so the verb that starts one belongs to the
    // Role that orchestrates. A Ticket Session's room does not hold it, and
    // that is why no inheritance or capping rule is needed to keep it out.
    expect(surface).not.toContain("automation.run");
    // The await tool is deliberately in this room too (VC-92's ruling on
    // VC-85): blocking is a runtime property, not a privilege, and what may
    // be awaited is policy data judged at call time.
    expect(verbToolsOf(surface)).toEqual(["ticket.await"]);
    // Its capability half is untouched: Role scopes the verbs, not the tools a
    // Session needs to do the work it was given.
    expect(surface).toEqual([
      "read",
      "edit",
      "write",
      "execute",
      "ask_user",
      "web_fetch",
      "web_search",
      "ticket.await",
    ]);
  });

  it("offers no web tool to a profile that configured no provider", () => {
    // A port IS the capability: absent means the tool is not in the array at
    // all, rather than one that refuses when called.
    expect(
      resolveAgentToolSurface(
        capabilities({ capabilities: { coding: EVERY_CODING, interaction: ["ask_user"] } }),
      ),
    ).toEqual([
      "read",
      "edit",
      "write",
      "execute",
      "ask_user",
      "session.start",
      "ticket.await",
      "automation.run",
      "session.stop",
      "session.send",
    ]);
  });

  it("orders interaction tools by the vocabulary, not by the caller's array", () => {
    // Two Sessions that wired the same ports in different orders must resolve
    // the same surface, or they pay a full Cache Prefix miss for a list that
    // did not change.
    expect(
      resolveAgentToolSurface(
        capabilities({
          capabilities: { coding: EVERY_CODING, interaction: ["web_search", "ask_user"] },
        }),
      ),
    ).toEqual([
      "read",
      "edit",
      "write",
      "execute",
      "ask_user",
      "web_search",
      "session.start",
      "ticket.await",
      "automation.run",
      "session.stop",
      "session.send",
    ]);
  });
});

describe("automation.run is the orchestrator's verb, and only that (VC-134)", () => {
  it("is in the project bundle only, with no cap or inheritance rule beside it", () => {
    expect(roleVerbBundle("project")).toContain("automation.run");
    // VC-112 is explicit that OpenClaw's "cap a created job to the creating
    // turn's tools" rule is NOT adopted: it patches a hole that
    // `bundle(Role) ∪ grants(session)` never opens. Absence from these two
    // bundles is the entire mechanism, so it is asserted rather than described.
    expect(roleVerbBundle("ticket")).not.toContain("automation.run");
    expect(roleVerbBundle("subagent")).not.toContain("automation.run");
  });

  it("names a verb the registry can actually project as a tool", () => {
    expect(VERB_TOOL_KEYS).toContain("automation.run");
    expect(isSessionToolId("automation.run")).toBe(true);
    // The durable identity keeps its dot; `automation_run` is the wire
    // rendering and is not what a record or a grant may spell.
    expect(isSessionToolId("automation_run")).toBe(false);
  });

  it("holds its canonical index, so no frozen surface shifted under it", () => {
    // Appended, never inserted: a Session frozen before this verb existed must
    // find every tool it already held at the position it already had, or it
    // pays a full Cache Prefix miss for a list that did not change for it.
    //
    // Asserted as a PREFIX rather than as "automation.run is last", because
    // last is an incidental fact about the newest verb while the prefix is the
    // invariant. VC-86's supervision pair appended behind this row and would
    // have falsified the incidental spelling of a discipline it in fact kept.
    expect(VERB_TOOL_KEYS.slice(0, 3)).toEqual(["session.start", "ticket.await", "automation.run"]);
  });
});

describe("resolveAgentToolSurface — grants stay distinct from Role bundles", () => {
  it("adds a granted verb to a Role that does not carry it", () => {
    // The resolver remains the fail-closed vocabulary seam for the durable
    // store: it validates grants before a Session receives a tool.
    expect(
      resolveAgentToolSurface(capabilities({ role: "ticket", grants: ["session.start"] })),
    ).toContain("session.start");
  });

  it("is a set: a grant that repeats the Role's own bundle offers one tool", () => {
    const surface = resolveAgentToolSurface(capabilities({ grants: ["session.start"] }));
    expect(surface.filter((tool) => tool === "session.start")).toHaveLength(1);
  });

  it("refuses a verb this build cannot offer as a tool", () => {
    // Both halves of the refusal are one message on purpose: to whoever holds
    // a bad grant, "no such verb" and "that verb is not a tool" are the same
    // mistake. `ticket.list` is real and CLI-only; `vault.rotate` is neither.
    for (const grant of ["ticket.list", "vault.rotate"]) {
      expect(() => resolveAgentToolSurface(capabilities({ grants: [grant] }))).toThrow(
        AgentToolSurfaceError,
      );
    }
  });

  it("refuses a grant reaching for a capability tool", () => {
    // The reason the three sets are kept apart: collapsed into one list, this
    // grant would hand a Session a web tool with no boundary behind it.
    expect(() => resolveAgentToolSurface(capabilities({ grants: ["web_fetch"] }))).toThrow(
      "not a verb this build can offer as a tool",
    );
  });

  it("refuses a capability outside its own vocabulary", () => {
    expect(() =>
      resolveAgentToolSurface(
        capabilities({ capabilities: { coding: ["compile" as never], interaction: [] } }),
      ),
    ).toThrow("not a coding tool this build can load");
    expect(() =>
      resolveAgentToolSurface(
        capabilities({ capabilities: { coding: [], interaction: ["telepathy" as never] } }),
      ),
    ).toThrow("not an interaction tool this build can wire");
  });
});

describe("isSessionToolId — the durable vocabulary, both halves", () => {
  it("admits capability tools and registry tool keys, and nothing else", () => {
    for (const tool of [...EVERY_CODING, ...EVERY_INTERACTION, ...VERB_TOOL_KEYS]) {
      expect(isSessionToolId(tool)).toBe(true);
    }
    // `ticket.list` is a real verb with no tool projection; the rest are not
    // names at all. A record naming any of them cannot be honestly rebound.
    for (const value of ["ticket.list", "credential-value", "session_start", "", 7, null]) {
      expect(isSessionToolId(value)).toBe(false);
    }
  });

  it("spells a verb tool with its dot, which is the durable identity", () => {
    // The provider-safe rendering is `session_start` and it is NOT what the
    // record holds: a durable surface is read back long after the wire name
    // that carried it, so it keeps the key every other product surface spells.
    expect(isSessionToolId("session.start")).toBe(true);
    expect(isSessionToolId("session_start")).toBe(false);
  });
});

describe("the registry's tool projection (VC-162)", () => {
  it("gives every projected verb a name a provider will accept", () => {
    // Both providers publish the same bound and neither is negotiable:
    // OpenAI's generated FunctionDefinition allows only letters, digits,
    // underscores and dashes to 64 characters, and Anthropic answers 400 with
    // `String should match pattern '^[a-zA-Z0-9_-]{1,64}$'`. A dot-key on the
    // wire is a failed request, not a degraded one.
    for (const entry of verbToolsFrom(VERB_REGISTRY)) {
      expect(entry.tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(entry.tool.name.length).toBeLessThanOrEqual(64);
    }
  });

  it("renders session.start as session_start and keeps the key intact", () => {
    const entry = verbEntry("session.start");
    expect(entry?.tool?.name).toBe("session_start");
    expect(entry?.key).toBe("session.start");
  });

  it("collides with no other tool name, on the wire or in the vocabulary", () => {
    const wireNames = verbToolsFrom(VERB_REGISTRY).map((entry) => entry.tool.name);
    expect(new Set(wireNames).size).toBe(wireNames.length);
    for (const name of wireNames) {
      expect([...EVERY_CODING, ...EVERY_INTERACTION]).not.toContain(name);
    }
  });

  it("shows the model a semantic schema, never the CLI's argv", () => {
    const fields = verbEntry("session.start")?.tool?.input ?? [];
    expect(fields.map((field) => field.name)).toEqual([
      "ticket",
      "message",
      "title",
      "model",
      "reasoning",
    ]);
    // `-m`, `--message` and `--project` are the parser's business. A model
    // shown `-m` writes `-m`; a model given no project field cannot name one.
    for (const field of fields) {
      expect(field.name).not.toMatch(/^-/);
    }
    expect(fields.map((field) => field.name)).not.toContain("project");
    expect(fields.find((field) => field.name === "ticket")?.required).toBe(true);
  });

  it("requires a projection exactly when a verb declares the tool mode", () => {
    const missing: VerbEntry = {
      key: "vault.rotate",
      accessModes: ["tool"],
      actor: "role",
      handler: { site: "main", id: "vault.rotate" },
      listed: false,
      group: "App",
      summary: "A named tool with nothing to build it from.",
      options: [],
    };
    expect(() => verbToolsFrom([missing])).toThrow("no tool projection");
    expect(() =>
      verbToolsFrom([{ ...missing, tool: { name: "vault.rotate", description: "", input: [] } }]),
    ).toThrow("no provider will accept");
  });

  it("refuses two verbs reaching for one wire name", () => {
    // A provider is handed one array; two tools of the same name in it is a
    // request no provider accepts, and a collision is silent at every other
    // layer — the keys differ, so nothing upstream notices.
    const tool = { name: "vault_rotate", description: "Rotate it.", input: [] };
    const entry = (key: string): VerbEntry => ({
      key,
      accessModes: ["tool"],
      actor: "role",
      handler: { site: "main", id: key },
      listed: false,
      group: "App",
      summary: "A named tool.",
      options: [],
      tool,
    });
    expect(() => verbToolsFrom([entry("vault.rotate"), entry("secret.rotate")])).toThrow(
      "projected by more than one verb",
    );
  });
});

describe("Verb Tier once the socket door is shut (VC-162 → VC-163)", () => {
  it("reads session.start as control, now that no socket caller reaches it", () => {
    const entry = verbEntry("session.start");
    // VC-162 left this `["cli", "tool"]` and the tier read as coordination — a
    // tier is the WEAKEST door a verb is reachable through, and claiming
    // control while any socket caller still reached it would have claimed a
    // closed door that was standing open. VC-163 removed `cli` and flipped the
    // actor to `role`, and that is what makes the control claim true.
    expect(entry?.accessModes).toEqual(["tool"]);
    expect(entry?.actor).toBe("role");
    expect(verbTier(entry!)).toBe("control");
  });

  // The ticket names this one in as many words: "`ticket.archive` is absent
  // from the CLI projection and from every bundle". The type system already
  // makes it unsayable — `VerbToolKey` is derived from the `tool` access mode,
  // so no bundle CAN name a verb that has none — but the acceptance is worth an
  // assertion that does not depend on reading the type to see it.
  it("puts ticket.archive in no Role's bundle at all", () => {
    for (const role of ["project", "ticket", "subagent"] as const) {
      expect(roleVerbBundle(role) as readonly string[], role).not.toContain("ticket.archive");
    }
    expect(VERB_TOOL_KEYS as readonly string[]).not.toContain("ticket.archive");
    // And a grant cannot smuggle it in either: the resolver fails closed on a
    // key this build cannot project as a tool.
    expect(() =>
      resolveAgentToolSurface({
        role: "project",
        capabilities: { coding: [], interaction: [] },
        grants: ["ticket.archive"],
      }),
    ).toThrow("is not a verb this build can offer as a tool");
  });

  it("keeps the verb in the `project` bundle it was put in", () => {
    // Closing the socket door did not move the tool. The Role that could start
    // Sessions before this ticket is the Role that can start them after it;
    // what changed is that nothing ELSE can.
    expect(roleVerbBundle("project")).toContain("session.start");
    expect(roleVerbBundle("ticket")).not.toContain("session.start");
  });
});
