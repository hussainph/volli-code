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
  it("gives a Project Session the agent-control family and a Ticket Session none", () => {
    expect(roleVerbBundle("project")).toEqual(["session.start", "ticket.await"]);
    // The property this ticket exists to make true, asserted as absence
    // rather than described. An injected instruction telling a Ticket Session
    // to start ten Sessions has nothing to call. `ticket.await` is not of the
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
    ]);
  });

  it("puts a Ticket Session in a room with no agent-control tool in it", () => {
    const surface = resolveAgentToolSurface(capabilities({ role: "ticket" }));
    expect(surface).not.toContain("session.start");
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
    ).toEqual(["read", "edit", "write", "execute", "ask_user", "session.start", "ticket.await"]);
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
    ]);
  });
});

describe("resolveAgentToolSurface — grants, as data with no store behind them", () => {
  it("adds a granted verb to a Role that does not carry it", () => {
    // The seam VC-162 ships. No product caller supplies grants yet; the rules
    // over them are enforced here so the slice that adds the durable store
    // inherits a resolver that already fails closed.
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

  it("keeps the verb in the `project` bundle it was put in", () => {
    // Closing the socket door did not move the tool. The Role that could start
    // Sessions before this ticket is the Role that can start them after it;
    // what changed is that nothing ELSE can.
    expect(roleVerbBundle("project")).toContain("session.start");
    expect(roleVerbBundle("ticket")).not.toContain("session.start");
  });
});
