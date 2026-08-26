import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_COMMAND_BINDINGS,
  AGENT_COMMANDS,
  agentCommandBindingsFrom,
  agentCommandsFrom,
  cliVerbName,
  DISCOVERABLE_VERBS,
  REFERENCE_VERBS,
  referenceVerbsFrom,
  VERB_REGISTRY,
  verbEntry,
  verbTier,
} from "./verb-registry";
import type { VerbEntry, VerbKey, VerbTier } from "./verb-registry";

/**
 * The socket surface as VC-85 and VC-163 leave it. VC-85 adds the typed
 * `ticket.signal` coordination verb; VC-163 removes `session.start` (tool-only
 * control tier) and `ticket.archive` (app-only curation). Every change is named
 * here so growing or shrinking the socket remains an explicit tier decision.
 */
const SOCKET_SURFACE = [
  "identify",
  "board",
  "ticket.list",
  "ticket.show",
  "ticket.events",
  "ticket.create",
  "ticket.update",
  "ticket.move",
  "ticket.comment",
  "ticket.signal",
  "ticket.brief",
  "worktree.status",
  "worktree.diff",
  "project.list",
  "label.list",
  "model.list",
  "cost",
  "session.list",
  "session.peek",
  "session.done",
  "session.blocked",
  "session.link",
  "session.harness",
  "notify",
  "hook",
  "doctor",
  "prompt.baseline",
];

/** The CLI reference as it stands: `COMMAND_HELP`'s entries plus `cost`, in its order. */
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
  "cost",
  "ticket.create",
  "ticket.update",
  "ticket.move",
  "ticket.comment",
  "ticket.signal",
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
 * Every row now agrees with VC-92's target. The two that used to disagree were
 * the ones VC-163 moved, and they are the whole of what this ticket changed
 * here:
 *
 * - `ticket.archive` — `null`. Not a tier of `none`: no access mode at all, so
 *   the verb is on no agent surface and holds no governance class to be
 *   assigned. App-only curation.
 * - `session.start` — `control`. VC-162 added the `tool` access mode beside
 *   `cli`, which left the verb dual-surface and therefore still coordination:
 *   a tier is the WEAKEST door a verb is reachable through, and claiming
 *   control while any socket caller reached it would have been a claim about a
 *   door standing open. Removing `cli` and flipping the actor to `role` is what
 *   shut that door, and only then does the row read `control`.
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
  // VC-92 staged it read tier explicitly: an orchestrator sampling spend must
  // not pay context rent to ask. Setting a budget is not here — that is
  // app-owned policy, and a cap the capped Session could write is decoration.
  cost: "read",
  "session.list": "read",
  "session.peek": "read",
  doctor: "read",
  "prompt.baseline": "read",
  "ticket.create": "coordination",
  "ticket.update": "coordination",
  "ticket.move": "coordination",
  "ticket.comment": "coordination",
  // VC-85's verdict channel, and the tier VC-92 pinned for it: a visible,
  // attributable, reversible write on the Agent CLI. It is the verb that will
  // be the first to REQUIRE its session actor rather than merely record one
  // (VC-163); until that door authenticates, the tier reads as it is.
  "ticket.signal": "coordination",
  notify: "coordination",
  "session.done": "coordination",
  "session.blocked": "coordination",
  "session.link": "coordination",
  "session.harness": "coordination",
  hook: "coordination",
  // The two VC-163 moved, named above.
  "ticket.archive": null,
  "session.start": "control",
  // The first verb born on VC-92's target assignment directly: tool-only,
  // Role-gated, never on the socket (VC-85). No delta to grow out of.
  "ticket.await": "control",
  // The second (VC-134, under VC-112's "the agent's verb"): starting an
  // Automation Run is agent control, so it is tool-only, Role-gated, and in
  // the `project` bundle alone. Filed as a registry entry rather than minted
  // as a verb surface of its own, exactly as the parent ruling asked.
  "automation.run": "control",
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
    handler: { site: "main", id: "socket.verb" },
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
    handler: { site: "main", id: "tool.verb" },
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
    handler: { site: "cli", id: "local.verb" },
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
    handler: { site: "main", id: "app.only" },
    listed: false,
    group: "Write",
    summary: "On no agent surface at all.",
    options: [],
  },
];

describe("AGENT_COMMANDS projection", () => {
  it("reproduces the socket surface exactly, in its declared order", () => {
    expect([...AGENT_COMMANDS]).toEqual(SOCKET_SURFACE);
  });

  // The acceptance line, as an assertion rather than as prose: "No agent-control
  // verb exists on the socket." Absence is the enforcement — a tool call is
  // bound to the attachment that made it, and a socket call can only ever be
  // attributed, so the control tier is not gated on the socket, it is missing
  // from it (VC-92 §6.1).
  it("carries no control-tier verb at all", () => {
    const onSocket = VERB_REGISTRY.filter((entry) =>
      (AGENT_COMMANDS as readonly string[]).includes(entry.key),
    );
    expect(onSocket.filter((entry) => verbTier(entry) === "control")).toEqual([]);
  });

  it("no longer answers session.start or ticket.archive", () => {
    expect(AGENT_COMMANDS).not.toContain("session.start");
    expect(AGENT_COMMANDS).not.toContain("ticket.archive");
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

describe("the handler binding (VC-167)", () => {
  it("binds every verb to a handler id that is its own key", () => {
    // The whole discipline in one line: the binding id IS the canonical key, so
    // main's dispatch table keys on the registry's vocabulary rather than on a
    // second naming scheme that could drift from it.
    for (const entry of VERB_REGISTRY) {
      expect(entry.handler.id).toBe(entry.key);
      expect(["main", "cli"]).toContain(entry.handler.site);
    }
  });

  it("maps every socket verb to the binding that answers it", () => {
    expect(Object.keys(AGENT_COMMAND_BINDINGS)).toEqual([...AGENT_COMMANDS]);
    for (const command of AGENT_COMMANDS) {
      expect(AGENT_COMMAND_BINDINGS[command]).toBe(command);
    }
  });

  it("is derived from the registry rather than authored beside it", () => {
    expect(agentCommandBindingsFrom(VERB_REGISTRY)).toEqual(AGENT_COMMAND_BINDINGS);
  });

  it("leaves a locally handled or tool-only verb out of the socket's bindings", () => {
    // `app.launch` and `help` answer in the `volli` process, and a tool-only
    // verb never reaches the socket at all. Neither may appear here, because a
    // binding in this map is main promising to answer that verb over the wire.
    expect(agentCommandBindingsFrom(SYNTHETIC)).toEqual({ "socket.verb": "socket.verb" });
  });

  it("lets one verb's binding be resolved without its wire name", () => {
    // The seam VC-162 rides: a verb that moves to a `tool` access mode leaves
    // the socket's map, and the id it named goes on identifying the same one
    // handler for whichever surface kept it.
    const relocated: VerbEntry = {
      ...SYNTHETIC[0]!,
      accessModes: ["tool"],
      actor: "role",
    };
    expect(agentCommandBindingsFrom([relocated])).toEqual({});
    expect(relocated.handler.id).toBe("socket.verb");
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
      handler: { site: "main", id: "unordered.verb" },
      listed: true,
      group: "Read",
      summary: "Missing its reference position.",
      options: [],
    };
    expect(() => referenceVerbsFrom([unordered])).toThrow(
      "Listed verb unordered.verb requires referenceOrder",
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
    // 15 in VC-92's audit, plus `cost` — which the amendment staged read tier
    // in the same breath, on the grounds that spend has to be cheap to sample.
    expect(socketTiers.filter((tier) => tier === "read")).toHaveLength(16);
    // VC-163 removes archive/start from the socket; VC-85 adds ticket.signal
    // to the remaining coordination surface.
    expect(socketTiers.filter((tier) => tier === "coordination")).toHaveLength(11);
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

  it("gives every verb a handler binding, whatever surfaces project it", () => {
    for (const entry of VERB_REGISTRY) {
      expect(["main", "cli"]).toContain(entry.handler.site);
      expect(entry.handler.id.length).toBeGreaterThan(0);
      expect(entry.summary.length).toBeGreaterThan(0);
    }
  });

  // VC-161 required at least one access mode on every entry, because at the
  // time no verb could be on zero agent surfaces. VC-163 made one: an app-only
  // verb keeps its whole entry — binding, options, effects — and simply
  // projects onto nothing. The binding requirement above is what still holds
  // universally, and it is the one that matters: the entry stays resolvable, so
  // restoring a surface is putting a string back rather than rebuilding a verb.
  it("lets a verb be on no agent surface, and keeps its binding when it is", () => {
    const appOnly = VERB_REGISTRY.filter((entry) => entry.accessModes.length === 0);
    expect(appOnly.map((entry) => entry.key)).toEqual(["ticket.archive"]);
    for (const entry of appOnly) {
      expect(entry.handler.id).toBe(entry.key);
      expect(verbTier(entry)).toBeNull();
    }
  });

  // `positionalSubject` is what lets the socket's admission gate resolve the
  // project a write LANDS IN, rather than only the one the caller is standing
  // in (VC-163). A coordination verb that takes a Ticket and forgets to declare
  // it would be judged by the caller's policy alone — which is the bug the
  // field was added to close, so it is worth failing here rather than there.
  it("declares the subject of every Ticket positional", () => {
    // Widened off the `as const` table, whose per-entry literal types omit an
    // optional field entirely rather than typing it `undefined`.
    const entries: readonly VerbEntry[] = VERB_REGISTRY;
    for (const entry of entries.filter(({ key }) => key.startsWith("ticket."))) {
      // `ticket.create` names its project by flag and takes no positional.
      if (entry.positionalId === undefined) continue;
      expect(entry.positionalSubject, entry.key).toBe("ticket");
    }
  });

  it("never declares a subject for a positional it does not take", () => {
    const entries: readonly VerbEntry[] = VERB_REGISTRY;
    for (const entry of entries) {
      if (entry.positionalSubject === undefined) continue;
      expect(entry.positionalId, entry.key).toBeDefined();
    }
  });

  it("keys are dot-names that spell their own CLI form", () => {
    for (const entry of VERB_REGISTRY) {
      expect(entry.key).toMatch(/^[a-z]+(\.[a-z]+)?$/);
      expect(cliVerbName(entry.key)).toBe(entry.key.replace(".", " "));
    }
  });

  it("hides the two involuntary verbs and the tool-only await from the reference", () => {
    const unlisted = VERB_REGISTRY.filter((entry) => !entry.listed).map((entry) => entry.key);
    // `ticket.await` is unlisted for a different reason than the involuntary
    // pair: it has no cli access mode at all, so a reference line would teach
    // an invocation the socket refuses. Its discovery surface is the tool
    // schema itself.
    expect(unlisted).toEqual(["session.harness", "hook", "ticket.await", "automation.run"]);
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

  it("keeps a preview on every voluntary coordination write", () => {
    // Tier is derived from the registry, so this candidate set grows with a
    // newly declared coordination verb instead of preserving a stale list of
    // the ones that happened to exist when the test was written. Unlisted
    // harness plumbing is involuntary and intentionally has no preview.
    const voluntaryCoordinationWrites = VERB_REGISTRY.filter(
      (entry) => entry.listed && verbTier(entry) === "coordination",
    );
    expect(voluntaryCoordinationWrites).not.toHaveLength(0);
    for (const entry of voluntaryCoordinationWrites) {
      expect(
        entry.options.some((option) => option.name === "--dry-run"),
        entry.key,
      ).toBe(true);
    }
  });

  it("pins human-visible effects and explicit non-effects on every voluntary write", () => {
    const voluntaryWrites = VERB_REGISTRY.filter((entry) => entry.listed && entry.actor !== "any");
    for (const entry of voluntaryWrites) {
      expect(entry.effects, entry.key).toBeDefined();
      expect(entry.effects!.humanVisible.length, entry.key).toBeGreaterThan(0);
      expect(entry.effects!.nonEffects.length, entry.key).toBeGreaterThan(0);
    }

    for (const key of ["doctor", "app.launch"] as const) {
      expect(verbEntry(key)?.effects, key).toBeDefined();
    }
  });

  // VC-134, filed by VC-112 ("The agent's verb") under VC-92 §5's rules. The
  // whole ticket is this entry: one row in this table, in one Role bundle,
  // with no second implementation and no verb surface of its own.
  it("carries automation.run as a control-tier entry and nothing more", () => {
    const entry = verbEntry("automation.run");
    expect(entry).toBeDefined();
    // Tool-only and Role-gated, which is what makes the tier read `control`
    // (VC-92 §2). A `cli` mode here would be an orchestrator verb any same-uid
    // process could reach, which is the door VC-163 shut for `session.start`.
    expect(entry!.accessModes).toEqual(["tool"]);
    expect(entry!.actor).toBe("role");
    expect(verbTier(entry!)).toBe("control");
    expect(AGENT_COMMANDS).not.toContain("automation.run");
    // One handler binding, named by the verb's own key (VC-167).
    expect(entry!.handler).toEqual({ site: "main", id: "automation.run" });
  });

  it("shows automation.run a semantic schema with no caller field in it", () => {
    const tool = verbEntry("automation.run")?.tool;
    expect(tool?.name).toBe("automation_run");
    expect(tool?.input.map((field) => field.name)).toEqual(["automation", "ticket"]);
    for (const field of tool?.input ?? []) {
      expect(field.required).toBe(true);
      expect(field.name).not.toMatch(/^-/);
    }
    // Nothing names the caller: the door binds the Session and its project, so
    // there is no project, session or actor field a model could supply.
    for (const name of ["project", "session", "actor", "model", "reasoning"]) {
      expect(tool?.input.map((field) => field.name)).not.toContain(name);
    }
  });

  it("records that an agent's Run is written with the automation Actor", () => {
    // VC-112's observability rule, carried on the entry itself: the Run this
    // verb starts is the same record a person's Run by hand writes, so the
    // effects contract must not describe a second kind of Run.
    const effects = verbEntry("automation.run")?.effects;
    expect(effects?.durableWrites.map((write) => write.resource)).toEqual(["automation-run"]);
    expect(JSON.stringify(effects)).toContain("automation");
    expect(effects?.humanVisible.length).toBeGreaterThan(0);
    expect(effects?.nonEffects.length).toBeGreaterThan(0);
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

  // The reference is what the SHELL executes, which is no longer the same set
  // as what help may name (VC-163). `session.start` and `ticket.archive` are
  // still listed, and still discoverable, precisely so a wrong door can be
  // told apart from no door — but neither is executable here, so neither
  // belongs in the executable projection.
  it("covers every listed CLI verb exactly once, and nothing unlisted", () => {
    const listedOnCli = VERB_REGISTRY.filter(
      // Widened because `ticket.archive` now declares `readonly []`, whose own
      // `includes` accepts `never` — the const table proving, at the type level,
      // that the verb is on no surface.
      (entry) => entry.listed && (entry.accessModes as readonly string[]).includes("cli"),
    ).map((entry) => entry.key);
    expect(REFERENCE_VERBS.map((entry) => entry.key).toSorted()).toEqual(listedOnCli.toSorted());
  });

  it("still lets help name the two verbs the shell cannot run", () => {
    const discoverable = DISCOVERABLE_VERBS.map((entry) => entry.key);
    const reference = new Set(REFERENCE_VERBS.map((entry) => entry.key));
    expect(discoverable.filter((key) => !reference.has(key))).toEqual([
      "ticket.archive",
      "session.start",
    ]);
  });

  it("is a different surface from the socket, by two verbs each way", () => {
    const reference = new Set(REFERENCE_VERBS.map((entry) => entry.key));
    const socket = new Set<string>(AGENT_COMMANDS);
    expect([...socket].filter((key) => !reference.has(key))).toEqual(["session.harness", "hook"]);
    expect([...reference].filter((key) => !socket.has(key))).toEqual(["app.launch", "help"]);
  });
});
