import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_COMMANDS,
  agentCommandsFrom,
  cliVerbName,
  REFERENCE_VERBS,
  referenceVerbsFrom,
  VERB_REGISTRY,
  verbEntry,
  verbTier,
} from "./verb-registry";
import type { VerbEntry, VerbKey, VerbTier } from "./verb-registry";

/**
 * The socket surface as it stood before the registry existed: the 27 strings
 * `AGENT_COMMANDS` was authored with, in the order it authored them. The
 * projection has to reproduce this exactly — this ticket re-seats the surface,
 * it does not redesign it.
 */
const SOCKET_SURFACE_BEFORE_THE_REGISTRY = [
  "identify",
  "board",
  "ticket.list",
  "ticket.show",
  "ticket.events",
  "ticket.create",
  "ticket.update",
  "ticket.move",
  "ticket.comment",
  "ticket.archive",
  "ticket.brief",
  "worktree.status",
  "worktree.diff",
  "project.list",
  "label.list",
  "model.list",
  "session.list",
  "session.peek",
  "session.start",
  "session.done",
  "session.blocked",
  "session.link",
  "session.harness",
  "notify",
  "hook",
  "doctor",
  "prompt.baseline",
];

/** The CLI reference as it stands: `COMMAND_HELP`'s 27 entries, in its order. */
const REFERENCE_SURFACE = [
  "identify",
  "board",
  "ticket.list",
  "ticket.show",
  "ticket.events",
  "ticket.brief",
  "worktree.status",
  "worktree.diff",
  "project.list",
  "label.list",
  "model.list",
  "ticket.create",
  "ticket.update",
  "ticket.move",
  "ticket.comment",
  "ticket.archive",
  "session.start",
  "session.list",
  "session.peek",
  "session.done",
  "session.blocked",
  "session.link",
  "notify",
  "app.launch",
  "prompt.baseline",
  "doctor",
  "help",
];

/**
 * VC-92 §3's per-verb audit, as the registry derives it TODAY. A `Record` over
 * every key, so a new verb cannot be added without a tier answer — that is the
 * "adding a verb is a tier decision" discipline, enforced by the compiler.
 *
 * Two rows deliberately disagree with VC-92's target assignment, because this
 * ticket changes no behavior and both verbs are on the socket right now:
 *
 * - `ticket.archive` — target: off the agent surface entirely (no access mode,
 *   no tier). VC-163 empties its access modes; until then it is a coordination
 *   write like the other ticket writes.
 * - `session.start` — target: control tier, a named tool in the `project`
 *   bundle, absent from the socket. VC-162 flips its access mode to `tool` and
 *   ships it as the tracer-bullet control verb; until then the socket answers
 *   it, and coordination is the honest reading of where it lives.
 *
 * `app.launch` and `help` are not in VC-92's audit — they never reach the
 * socket. They are read tier by the same rule as any other any-caller verb.
 */
const TIER_TABLE: Record<VerbKey, VerbTier | null> = {
  identify: "read",
  board: "read",
  "ticket.list": "read",
  "ticket.show": "read",
  "ticket.events": "read",
  "ticket.brief": "read",
  "worktree.status": "read",
  "worktree.diff": "read",
  "project.list": "read",
  "label.list": "read",
  "model.list": "read",
  "session.list": "read",
  "session.peek": "read",
  doctor: "read",
  "prompt.baseline": "read",
  "ticket.create": "coordination",
  "ticket.update": "coordination",
  "ticket.move": "coordination",
  "ticket.comment": "coordination",
  notify: "coordination",
  "session.done": "coordination",
  "session.blocked": "coordination",
  "session.link": "coordination",
  "session.harness": "coordination",
  hook: "coordination",
  // The two deltas from VC-92's target, named above.
  "ticket.archive": "coordination",
  "session.start": "coordination",
  // Local verbs, outside the audit.
  "app.launch": "read",
  help: "read",
};

/** A registry that is not the real one, for projections nothing declares yet. */
const SYNTHETIC: readonly VerbEntry[] = [
  {
    key: "socket.verb",
    accessModes: ["cli"],
    actor: "any",
    handler: "main",
    listed: true,
    referenceOrder: 20,
    group: "Read",
    summary: "On the socket.",
    options: [],
  },
  {
    key: "tool.verb",
    accessModes: ["tool"],
    actor: "role",
    handler: "main",
    listed: true,
    referenceOrder: 0,
    group: "Session",
    summary: "A named tool, never a command.",
    options: [],
  },
  {
    key: "local.verb",
    accessModes: ["cli"],
    actor: "any",
    handler: "cli",
    listed: true,
    referenceOrder: 10,
    group: "App",
    summary: "Answered in the CLI process.",
    options: [],
  },
  {
    key: "app.only",
    accessModes: [],
    actor: "any",
    handler: "main",
    listed: false,
    group: "Write",
    summary: "On no agent surface at all.",
    options: [],
  },
];

describe("AGENT_COMMANDS projection", () => {
  it("reproduces the socket surface exactly, in its original order", () => {
    expect([...AGENT_COMMANDS]).toEqual(SOCKET_SURFACE_BEFORE_THE_REGISTRY);
  });

  it("is derived from the registry rather than authored beside it", () => {
    expect(agentCommandsFrom(VERB_REGISTRY)).toEqual([...AGENT_COMMANDS]);
  });

  it("keeps a tool-only verb and a locally handled verb off the socket", () => {
    expect(agentCommandsFrom(SYNTHETIC)).toEqual(["socket.verb"]);
  });

  it("names every socket verb exactly once", () => {
    expect(new Set(AGENT_COMMANDS).size).toBe(AGENT_COMMANDS.length);
  });
});

describe("CLI reference projection", () => {
  it("keeps only listed CLI entries and orders them from entry data", () => {
    expect(referenceVerbsFrom(SYNTHETIC).map((entry) => entry.key)).toEqual([
      "local.verb",
      "socket.verb",
    ]);
  });

  it("lets listed remove a CLI entry without another projection edit", () => {
    const hidden = { ...SYNTHETIC[0]!, listed: false } satisfies VerbEntry;
    expect(referenceVerbsFrom([hidden])).toEqual([]);
  });

  it("requires a listed CLI entry to declare its order on that entry", () => {
    const unordered: VerbEntry = {
      key: "unordered.verb",
      accessModes: ["cli"],
      actor: "any",
      handler: "main",
      listed: true,
      group: "Read",
      summary: "Missing its reference position.",
      options: [],
    };
    expect(() => referenceVerbsFrom([unordered])).toThrow(
      "Listed CLI verb unordered.verb requires referenceOrder",
    );
  });
});

describe("verbTier", () => {
  it("derives VC-92's audit for every declared verb", () => {
    const derived = Object.fromEntries(VERB_REGISTRY.map((entry) => [entry.key, verbTier(entry)]));
    expect(derived).toEqual(TIER_TABLE);
  });

  it("holds the audit's arithmetic over the socket surface", () => {
    const socketTiers = VERB_REGISTRY.filter((entry) =>
      (AGENT_COMMANDS as readonly string[]).includes(entry.key),
    ).map((entry) => verbTier(entry));
    expect(socketTiers.filter((tier) => tier === "read")).toHaveLength(15);
    // VC-92 assigns 10 coordination verbs; `ticket.archive` and `session.start`
    // ride here too until VC-163 and VC-162 move them.
    expect(socketTiers.filter((tier) => tier === "coordination")).toHaveLength(12);
    expect(socketTiers.filter((tier) => tier === "control")).toHaveLength(0);
  });

  it("gives an app-only verb no tier at all", () => {
    expect(verbTier({ accessModes: [], actor: "any" })).toBeNull();
  });

  it("derives control only when a Role-gated verb is absent from the CLI", () => {
    expect(verbTier({ accessModes: ["tool"], actor: "role" })).toBe("control");
    expect(() => verbTier({ accessModes: ["cli"], actor: "role" })).toThrow(
      "A control-tier verb cannot carry a cli access mode",
    );
  });

  it("rejects non-Role and non-tool attempts to declare control tier", () => {
    for (const entry of [
      { accessModes: ["tool"], actor: "session" },
      { accessModes: ["hostApi"], actor: "any" },
      { accessModes: ["tool", "hostApi"], actor: "role" },
    ] as const) {
      expect(() => verbTier(entry)).toThrow(
        "Control tier requires tool-only access and a role actor",
      );
    }
  });

  it("splits the socket by actor: any caller reads, a session actor coordinates", () => {
    expect(verbTier({ accessModes: ["cli"], actor: "any" })).toBe("read");
    expect(verbTier({ accessModes: ["cli", "tool"], actor: "session" })).toBe("coordination");
  });

  it("is the only way to get a tier — no entry stores one", () => {
    for (const entry of VERB_REGISTRY) {
      expect(Object.keys(entry)).not.toContain("tier");
    }
  });

  /**
   * VC-44's non-negotiable, held here because this table is what would break it.
   *
   * The agent must not be able to author the policy that governs it. Authority
   * policy is app-owned state written through one IPC channel
   * (`volli:project-authority-policy`) with no verb behind it, and that has to
   * stay true as the registry grows — a `volli authority set` added later would
   * hand the agent its own permissions back, and would do it quietly.
   *
   * The check is a floor, not a proof: it catches a verb NAMED for the write.
   * What actually enforces the rule is `verbTier` refusing a `cli` access mode
   * on a role actor, which is tested above and cannot be worked around — any
   * such verb must be `tool`-only, and a tool bundle is not the agent socket.
   */
  it("puts no authority-policy WRITE on the agent surface", () => {
    const authorityWrites = VERB_REGISTRY.filter(
      (entry) => entry.key.startsWith("authority") && entry.actor !== "any",
    );
    expect(authorityWrites).toEqual([]);

    // Reads would be legitimate on the socket — VC-44's `authority
    // defaults|effective` are two read verbs. If one lands, it stays read tier.
    for (const entry of VERB_REGISTRY.filter((candidate) =>
      candidate.key.startsWith("authority"),
    )) {
      expect(verbTier(entry)).toBe("read");
    }
  });
});

describe("the registry table", () => {
  it("declares each key once", () => {
    const keys = VERB_REGISTRY.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every verb a handler binding and at least one access mode", () => {
    for (const entry of VERB_REGISTRY) {
      expect(["main", "cli"]).toContain(entry.handler);
      expect(entry.accessModes.length).toBeGreaterThan(0);
      expect(entry.summary.length).toBeGreaterThan(0);
    }
  });

  it("keys are dot-names that spell their own CLI form", () => {
    for (const entry of VERB_REGISTRY) {
      expect(entry.key).toMatch(/^[a-z]+(\.[a-z]+)?$/);
      expect(cliVerbName(entry.key)).toBe(entry.key.replace(".", " "));
    }
  });

  it("hides only the two involuntary verbs from the reference", () => {
    const unlisted = VERB_REGISTRY.filter((entry) => !entry.listed).map((entry) => entry.key);
    expect(unlisted).toEqual(["session.harness", "hook"]);
  });

  it("stores each listed verb's reference position on that entry", () => {
    const listed = VERB_REGISTRY.filter((entry) => entry.listed);
    const orders = listed.map((entry) => entry.referenceOrder);
    expect(orders.every((order) => Number.isFinite(order))).toBe(true);
    expect(new Set(orders).size).toBe(listed.length);
    for (const entry of VERB_REGISTRY.filter((candidate) => !candidate.listed)) {
      expect("referenceOrder" in entry).toBe(false);
    }
  });

  it("gives every listed verb the example its detail page prints", () => {
    for (const entry of VERB_REGISTRY.filter((candidate) => candidate.listed)) {
      expect(entry.example).toMatch(/^volli /);
    }
  });

  it("describes every option, and only flags omit a value shape", () => {
    for (const entry of VERB_REGISTRY) {
      const names = entry.options.map((option) => option.name);
      expect(new Set(names).size).toBe(names.length);
      for (const option of entry.options) {
        expect(option.name).toMatch(/^-/);
        expect(option.help.length).toBeGreaterThan(0);
        expect("placeholder" in option).toBe(option.kind !== "flag");
      }
    }
  });

  it("looks an entry up by key, and admits when it holds none", () => {
    expect(verbEntry("ticket.move")?.group).toBe("Write");
    expect(verbEntry("ticket.teleport")).toBeUndefined();
  });
});

describe("REFERENCE_VERBS", () => {
  it("is derived from the registry's listing data", () => {
    expect(referenceVerbsFrom(VERB_REGISTRY)).toEqual(REFERENCE_VERBS);
  });

  it("is the CLI reference in the order it prints", () => {
    expect(REFERENCE_VERBS.map((entry) => entry.key)).toEqual(REFERENCE_SURFACE);
  });

  it("covers every listed verb exactly once, and nothing unlisted", () => {
    const listed = VERB_REGISTRY.filter((entry) => entry.listed).map((entry) => entry.key);
    expect(REFERENCE_VERBS.map((entry) => entry.key).toSorted()).toEqual(listed.toSorted());
  });

  it("is a different surface from the socket, by two verbs each way", () => {
    const reference = new Set(REFERENCE_VERBS.map((entry) => entry.key));
    const socket = new Set<string>(AGENT_COMMANDS);
    expect([...socket].filter((key) => !reference.has(key))).toEqual(["session.harness", "hook"]);
    expect([...reference].filter((key) => !socket.has(key))).toEqual(["app.launch", "help"]);
  });
});
