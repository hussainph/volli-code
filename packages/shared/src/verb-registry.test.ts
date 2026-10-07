import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import {
  AGENT_COMMAND_BINDINGS,
  AGENT_COMMANDS,
  agentCommandBindingsFrom,
  agentCommandsFrom,
  BOARD_ENTRIES,
  CATALOG_ENTRIES,
  catalogActorOf,
  catalogEntriesFrom,
  catalogLookup,
  catalogEntry,
  SESSION_READ_VERBS,
  cliVerbName,
  VERB_IDEMPOTENCIES,
  VERB_SCOPES,
  DISCOVERABLE_VERBS,
  REFERENCE_VERBS,
  referenceVerbsFrom,
  VERB_REGISTRY,
  VERB_TOOLS,
  verbEntry,
  verbTier,
  verbToolWireName,
} from "./verb-registry";
import type {
  CatalogKey,
  CatalogKeyOf,
  CatalogKeyScopedTo,
  HostApiCatalogCoverage,
  HostApiKey,
  VerbEntry,
  VerbKey,
  VerbResultDetailsSchema,
  VerbTier,
} from "./verb-registry";
import { AGENT_MODEL_TIERS, modelTierRow } from "./model-access-policy";

/**
 * The socket surface as VC-85, VC-163 and VC-185 leave it. VC-85 adds the typed
 * `ticket.signal` coordination verb; VC-163 removes `session.start` (tool-only
 * control tier) and `ticket.archive` (app-only curation); VC-185 adds
 * `worktree.sync` (coordination) and `conflicts` (read). Every change is named
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
  "worktree.sync",
  "conflicts",
  "project.list",
  // VC-623: the operator's bootstrap write. A `user` verb, so no Session
  // reaches it whatever a policy grants.
  "project.add",
  "label.list",
  "label.merge",
  "model.list",
  "cost",
  "session.list",
  "session.show",
  "session.peek",
  "session.answer",
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
  "conflicts",
  "project.list",
  "label.list",
  "model.list",
  "cost",
  "ticket.create",
  "ticket.update",
  "ticket.move",
  "ticket.comment",
  "ticket.signal",
  "worktree.sync",
  "label.merge",
  "session.list",
  "session.show",
  "session.peek",
  "session.answer",
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
  // The radar (VC-185). Read tier by VC-92's amendment on VC-89: it projects
  // worktree diffs Volli already holds, and its whole value is being cheap
  // enough to run in a bash pipeline.
  conflicts: "read",
  "project.list": "read",
  // The person's write (VC-623): coordination tier, but judged by the door's
  // actor alone — an operator token — and never by a policy list.
  "project.add": "coordination",
  "label.list": "read",
  // A coordination write despite sitting beside a read: it retires a Label
  // and rewrites associations, so it is attributable or it does not happen.
  "label.merge": "coordination",
  "model.list": "read",
  // VC-92 staged it read tier explicitly: an orchestrator sampling spend must
  // not pay context rent to ask. Setting a budget is not here — that is
  // app-owned policy, and a cap the capped Session could write is decoration.
  cost: "read",
  "session.list": "read",
  "session.show": "read",
  "session.peek": "read",
  // The whole of a chat's last message (VC-9): a read, like the peek beside it.
  "session.answer": "read",
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
  // VC-185, and VC-92's audit principle in one row: sync mutates only a
  // worktree the `execute` coding tool already reaches, so it earns no
  // control-tier ceremony — an authenticated session actor on the Agent CLI.
  "worktree.sync": "coordination",
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
  // The Session-side await (VC-324 item 3): the same bargain as `ticket.await`
  // — tool-only, Role-gated, never on the socket, because a CLI verb must
  // never wait.
  "session.await": "control",
  // What replaced both awaits (VC-457): tool-only and Role-gated for the
  // reason they were — it reaches into its caller's own ledger later, so the
  // caller must be the bound attachment, never a socket request.
  watch: "control",
  // MCP management (VC-380). Control tier for the reason the whole family is
  // tool-only: an install starts a process as the user or opens a network
  // relationship on the project's behalf, which is exactly the misuse a
  // same-uid process must not be able to reach through the socket. Even
  // `mcp.list` stays off it — a project's configured servers and their
  // provenance are the map an attacker would want first.
  "mcp.list": "control",
  "mcp.preview": "control",
  "mcp.install": "control",
  "mcp.refresh": "control",
  "mcp.enable": "control",
  "mcp.disable": "control",
  "mcp.tools": "control",
  "mcp.remove": "control",
  // The supervision pair (VC-86), born control tier the same way: control
  // over OTHER agents is only safe where the caller is unspoofable, so
  // neither has ever had a socket door to shut.
  "session.stop": "control",
  "session.send": "control",
  // Delegation to a bounded helper (VC-9): control tier for the reason
  // `session.start` is — it opens agent work and spends a model — and in both
  // working bundles, because "go look at this and tell me" is what an
  // executor needs as much as an orchestrator does. The child's own bundle is
  // what makes that safe, and the child holds none of this family.
  "session.delegate": "control",
  // Local verbs, outside the audit.
  "app.launch": "read",
  help: "read",
  // The Session router's catalog entries (VC-564): `hostApi`-only, tiered by
  // the CLI's actor rule. Every one requires the person, so every one reads
  // coordination, the same answer VC-623 gave `project.add`; the bootstrap
  // `protocol.welcome` is any caller's, so it reads (VC-663).
  "protocol.welcome": "read",
  "protocol.hostWelcome": "coordination",
  "workspaces.list": "coordination",
  "workspaces.create": "coordination",
  "sessions.create": "coordination",
  "sessions.attach": "coordination",
  "settings.experiments": "coordination",
  "settings.setExperiment": "coordination",
  "logs.tail": "coordination",
  "logs.follow": "coordination",
  "modelAccess.inspect": "coordination",
  "modelAccess.defaults": "coordination",
  "modelAccess.setDefault": "coordination",
  "modelAccess.hiddenModels": "coordination",
  "modelAccess.setHiddenModels": "coordination",
  "modelAccess.compactionPolicy": "coordination",
  "modelAccess.setCompactionPolicy": "coordination",
  "modelAccess.codeModePolicy": "coordination",
  "modelAccess.setCodeModePolicy": "coordination",
  "modelAccess.pickerView": "coordination",
  "modelAccess.setPickerView": "coordination",
  "session.snapshot": "coordination",
  "session.history": "coordination",
  "session.projection": "coordination",
  "session.subscribe": "coordination",
  "session.subscribeQueue": "coordination",
  "session.command": "coordination",
  "session.cancelQueued": "coordination",
  "session.editQueued": "coordination",
  "session.cancelInteraction": "coordination",
  "session.reconcile": "coordination",
  "session.listing": "coordination",
  "session.listingForTicket": "coordination",
  // Sign-ins on a host (VC-702): the person's, on the WebSocket only.
  "signIns.status": "coordination",
  "signIns.setApiKey": "coordination",
  "signIns.signOut": "coordination",
  "signIns.start": "coordination",
  "signIns.subscribe": "coordination",
  "signIns.answer": "coordination",
  "signIns.cancel": "coordination",
  "signIns.setGitCredential": "coordination",
  "signIns.clearGitCredential": "coordination",
  "auth.callback.deliver": "coordination",
  // The board router's own operations (VC-565): the person's, on no agent
  // surface, so coordination by the same rule.
  "board.snapshot": "coordination",
  "board.roster": "coordination",
  "board.changes": "coordination",
  "board.projectFolder": "coordination",
  "board.ticketBody": "coordination",
  "board.archivedTickets": "coordination",
  "board.ticketEvents": "coordination",
  "board.latestSignals": "coordination",
  "board.statusEntries": "coordination",
  "board.comments": "coordination",
  "board.updateProject": "coordination",
  "board.setSkillModes": "coordination",
  "board.setSessionDefaults": "coordination",
  "board.createTicket": "coordination",
  "board.moveTickets": "coordination",
  "board.setPriority": "coordination",
  "board.updateTicket": "coordination",
  "board.setLabels": "coordination",
  "board.archiveTicket": "coordination",
  "board.unarchiveTicket": "coordination",
  "board.deleteTicket": "coordination",
  "board.createComment": "coordination",
  "board.updateComment": "coordination",
  "board.removeComment": "coordination",
  "board.setLabelColor": "coordination",
  // Declared and policed, projected by no door: no tier, like ticket.archive.
  "labDiagnostics.list": null,
  "labDiagnostics.subscribe": null,
};

/** A router-only catalog entry: on the WebSocket projection at most, on no agent surface. */
function routerOnly(entry: VerbEntry): boolean {
  return entry.catalog !== undefined && entry.accessModes.every((mode) => mode === "hostApi");
}

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

  // Agent control stays tool-only. The socket's one exception is verified
  // by hostd's operator credential, never by a Session environment.
  it("carries only the person-only exception to the control tier", () => {
    const onSocket = VERB_REGISTRY.filter((entry) =>
      (AGENT_COMMANDS as readonly string[]).includes(entry.key),
    );
    expect(
      onSocket.filter((entry) => verbTier(entry) === "control").map((entry) => entry.key),
    ).toEqual(["session.start"]);
    expect(verbEntry("session.start")).toMatchObject({ accessModes: ["tool"], operatorCli: true });
  });

  it("answers the operator start but never ticket.archive", () => {
    expect(AGENT_COMMANDS).toContain("session.start");
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
    // in the same breath, on the grounds that spend has to be cheap to sample —
    // plus VC-185's `conflicts`, staged read tier by the same amendment.
    // VC-9 adds `session.answer`, a read beside the peek.
    expect(socketTiers.filter((tier) => tier === "read")).toHaveLength(19);
    // VC-163 removes archive/start from the socket; VC-85 adds ticket.signal
    // and VC-185 adds worktree.sync to the remaining coordination surface.
    // VC-310 adds label.merge, the label cleanup write. VC-623 adds
    // project.add, the one write only the person may make.
    expect(socketTiers.filter((tier) => tier === "coordination")).toHaveLength(14);
    expect(socketTiers.filter((tier) => tier === "control")).toHaveLength(1);
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
      { accessModes: ["tool", "hostApi"], actor: "role" },
    ] as const) {
      expect(() => verbTier(entry)).toThrow(
        "Control tier requires tool-only access and a role actor",
      );
    }
  });

  // VC-564: `hostApi` is the WebSocket projection, a door like the socket.
  it("tiers a hostApi-only verb by the socket's actor rule, and never as control", () => {
    expect(verbTier({ accessModes: ["hostApi"], actor: "any" })).toBe("read");
    expect(verbTier({ accessModes: ["hostApi"], actor: "user" })).toBe("coordination");
    expect(verbTier({ accessModes: ["hostApi"], actor: "session" })).toBe("coordination");
    expect(verbTier({ accessModes: ["cli", "hostApi"], actor: "any" })).toBe("read");
    expect(() => verbTier({ accessModes: ["hostApi"], actor: "role" })).toThrow(
      "A control-tier verb cannot carry a hostApi access mode",
    );
  });

  it("splits the socket by actor: any caller reads, a session actor coordinates", () => {
    expect(verbTier({ accessModes: ["cli"], actor: "any" })).toBe("read");
    expect(verbTier({ accessModes: ["cli", "tool"], actor: "session" })).toBe("coordination");
    expect(verbTier({ accessModes: ["cli"], actor: "user" })).toBe("coordination");
  });

  it("keeps the person's verbs off every Session surface (VC-623)", () => {
    const personVerbs = (VERB_REGISTRY as readonly VerbEntry[]).filter(
      (entry) => entry.actor === "user",
    );
    // The router's catalog entries (VC-564) are the person's too, and reach no
    // agent surface at all: no `cli`, no `tool`, unlisted.
    for (const entry of personVerbs.filter(routerOnly)) {
      expect(entry.listed, entry.key).toBe(false);
    }
    const userVerbs = personVerbs.filter((entry) => !routerOnly(entry));
    expect(userVerbs.map((entry) => entry.key)).toEqual(["project.add"]);
    for (const entry of userVerbs) {
      // Never a tool, so no Role bundle can carry it; never listed, so neither
      // help nor the managed skill an agent reads offers it.
      expect(entry.accessModes, entry.key).toEqual(["cli"]);
      expect(entry.listed, entry.key).toBe(false);
      expect(
        entry.options.some((option) => option.name === "--dry-run"),
        entry.key,
      ).toBe(true);
      expect(entry.effects?.nonEffects.length, entry.key).toBeGreaterThan(0);
    }
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
    expect(appOnly.map((entry) => entry.key)).toEqual([
      "ticket.archive",
      // The lab's diagnostics (VC-564): declared so the router can police
      // them, served by no door.
      "labDiagnostics.list",
      "labDiagnostics.subscribe",
    ]);
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
    for (const entry of VERB_REGISTRY.filter((candidate) => !routerOnly(candidate))) {
      expect(entry.key).toMatch(/^[a-z]+(\.[a-z]+)?$/);
      expect(cliVerbName(entry.key)).toBe(entry.key.replace(".", " "));
    }
  });

  // A router-only entry is keyed by its tRPC path (VC-564), which no CLI spells.
  it("keys a router-only catalog entry by its procedure path", () => {
    // A path may nest (`auth.callback.deliver`, HP § Auth-callback relay).
    for (const entry of VERB_REGISTRY.filter(routerOnly)) {
      expect(entry.key).toMatch(/^[a-z][A-Za-z]*(?:\.[a-z][A-Za-z]*)+$/);
    }
  });

  it("hides the two involuntary verbs and the tool-only await from the reference", () => {
    const unlisted = VERB_REGISTRY.filter((entry) => !entry.listed && !routerOnly(entry)).map(
      (entry) => entry.key,
    );
    // `ticket.await` is unlisted for a different reason than the involuntary
    // pair: it has no cli access mode at all, so a reference line would teach
    // an invocation the socket refuses. Its discovery surface is the tool
    // schema itself. `automation.run` used to sit beside it, but VC-329 moved
    // it to listed (with the session.start precedent): an agent that could not
    // discover it substituted a hand-written session_start kickoff for the
    // person's saved Automation. `session.await` stays unlisted beside it;
    // both are retired (VC-457). `watch`, which replaced them, is discovered
    // through its tool schema the same way.
    // `project.add` (VC-623) is unlisted because no agent can run it: it is the
    // person's verb, and the reference is what agents read.
    expect(unlisted).toEqual([
      "project.add",
      "session.harness",
      "hook",
      "ticket.await",
      "session.await",
      "watch",
    ]);
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
    // Read as `VerbEntry`, not as the const-asserted tuple's literal member
    // types: an optional field is absent from the literal type of every entry
    // that omits it, so the union has no `previewsByDefault` to ask about.
    const voluntaryCoordinationWrites = (VERB_REGISTRY as readonly VerbEntry[]).filter(
      (entry) => entry.listed && verbTier(entry) === "coordination",
    );
    expect(voluntaryCoordinationWrites).not.toHaveLength(0);
    for (const entry of voluntaryCoordinationWrites) {
      // TWO ways to satisfy the rule, because the rule is "a caller can see
      // this write before it happens", not "this flag exists". A verb that
      // previews unless told to apply already keeps that promise, and more
      // strongly than one whose safe mode has to be remembered — see
      // `previewsByDefault`. What is refused is a coordination write offering
      // neither.
      expect(
        entry.previewsByDefault === true ||
          entry.options.some((option) => option.name === "--dry-run"),
        entry.key,
      ).toBe(true);
    }
  });

  it("pins the default-preview shape and never lets it contradict --dry-run", () => {
    // `--dry-run` means "this run writes unless you ask otherwise";
    // `previewsByDefault` means the opposite. A verb declaring both leaves a
    // caller no way to know what the plain form does.
    const defaultPreviews = (VERB_REGISTRY as readonly VerbEntry[]).filter(
      (entry) => entry.previewsByDefault === true,
    );
    // VC-380 adds the two MCP writes on the same ground `label.merge` earned
    // it: both are destructive and not usefully reversible — an install starts
    // a process or opens a network relationship, and a removal breaks
    // reattachment for older Sessions that cannot be put back.
    expect(defaultPreviews.map((entry) => entry.key)).toEqual([
      "label.merge",
      "mcp.install",
      "mcp.remove",
    ]);
    for (const entry of defaultPreviews) {
      expect(
        entry.options.some((option) => option.name === "--dry-run"),
        entry.key,
      ).toBe(false);
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

  it("describes armed arrival Runs and interruption as ticket-move effects", () => {
    const effects = verbEntry("ticket.move")?.effects;
    expect(effects?.humanVisible.join(" ")).toContain("Automatic triggers");
    expect(effects?.humanVisible.join(" ")).toContain("interrupts");
    expect(effects?.nonEffects.join(" ")).toContain("Without an enabled, armed Automation");
  });

  it("locates delegated Sessions in the parent's Activity Island", () => {
    const effects = verbEntry("session.delegate")?.effects;
    expect(effects?.humanVisible.join(" ")).toContain("Activity Island");
    expect(effects?.humanVisible.join(" ")).toContain("no separate Session-list row");
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

  // VC-329's item 6: agents that could not discover `automation.run` rewrote
  // the person's saved Automation as a hand-written `session_start` kickoff.
  // These pin the two halves of the fix: the Run verb is discoverable, and
  // both descriptions cross-reference so the substitution is named where the
  // model is about to make it.
  it("lets an agent reading the reference discover automation.run (VC-329)", () => {
    const entry = verbEntry("automation.run");
    expect(entry?.listed).toBe(true);
    expect(DISCOVERABLE_VERBS.map((candidate) => candidate.key)).toContain("automation.run");
    // Listed but still tool-only: the reference teaches the real door, and the
    // parser refusal (parser.test.ts) names it for a shell attempt.
    expect(entry?.accessModes).toEqual(["tool"]);
  });

  it("cross-references the Run verb from both substitution-prone descriptions", () => {
    const start = verbEntry("session.start")?.tool?.description ?? "";
    const run = verbEntry("automation.run")?.tool?.description ?? "";
    expect(start).toContain("automation_run");
    expect(start).toMatch(/Automation/);
    expect(start).toContain("If this Session holds");
    expect(start).toContain("do not bypass the missing tool");
    expect(run).toContain("session_start");
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

  // VC-259: a delegating Session names a KIND of work, not an exact model id.
  // The tier field is the tool's rendering of the same fixed set Settings and
  // `volli model list` read, so the schema is pinned to that list rather than
  // to a copy of it.
  it("lets session_start name a model tier as the alternative to an exact model", () => {
    const tool = verbEntry("session.start")?.tool;
    const tier = tool?.input.find((field) => field.name === "tier");
    expect(tier).toBeDefined();
    expect(tier?.required).toBeUndefined();
    expect(tier?.type === "enum" ? tier.values : []).toEqual(AGENT_MODEL_TIERS);
    // Every tier says in one line what it is for — the same line its Settings
    // row's (i) carries — and the field says it is an alternative to `model`,
    // which is what the door refuses when both arrive.
    for (const name of AGENT_MODEL_TIERS) {
      expect(tier?.description).toContain(`${name}: ${modelTierRow(name).hint}`);
    }
    expect(tier?.description).toMatch(/instead of `model`/);
    expect(tool?.input.map((field) => field.name)).toEqual([
      "ticket",
      "message",
      "title",
      "model",
      "tier",
      "reasoning",
    ]);
  });

  // VC-431: the delegate door offers the SAME rungs, for the reason the owner
  // gave — "it gives a working session an anchor to the user's preferences for
  // models and effort". A delegation that names neither a tier nor a model is
  // anchored to its parent's own, which is why `model` no longer speaks of a
  // utility default: nothing on a chat path resolves that row.
  it("lets session_delegate name the same model tiers, and never the Utility row", () => {
    const tool = verbEntry("session.delegate")?.tool;
    const tier = tool?.input.find((field) => field.name === "tier");
    expect(tier).toBeDefined();
    expect(tier?.required).toBeUndefined();
    // Written out rather than compared against `AGENT_MODEL_TIERS`, which is
    // the constant the schema is BUILT from: that comparison holds however the
    // constant changes, so it could never fail on the one thing this test is
    // named for. The literal is what refuses `utility` here.
    expect(tier?.type === "enum" ? tier.values : []).toEqual([
      "fast",
      "deep",
      "visual",
      "ticket",
      "global",
    ]);
    for (const name of AGENT_MODEL_TIERS) {
      expect(tier?.description).toContain(`${name}: ${modelTierRow(name).hint}`);
    }
    expect(tier?.description).not.toMatch(/utility/i);
    expect(tier?.description).toMatch(/instead of `model`/);
    expect(tool?.input.find((field) => field.name === "model")?.description).not.toMatch(
      /utility/i,
    );
    expect(tool?.input.map((field) => field.name)).toEqual([
      "task",
      "title",
      "model",
      "tier",
      "reasoning",
    ]);
  });

  // Documentation parity only: `session.start` has had no shell door since
  // VC-163, so the option table is what the reference prints beside the tool
  // schema, never argv the shell would parse.
  it("lists --tier beside --model in session.start's option table", () => {
    const options = verbEntry("session.start")?.options ?? [];
    const tier = options.find((option) => option.name === "--tier");
    expect(tier).toMatchObject({ kind: "value", placeholder: "<tier>" });
    expect(tier?.values).toBe(`valid: ${AGENT_MODEL_TIERS.join(", ")}`);
    expect(options.map((option) => option.name)).toEqual([
      "-m",
      "--message",
      "--title",
      "--model",
      "--tier",
      "--reasoning",
    ]);
  });

  it("tells model list readers the tier table is printed beside the catalog", () => {
    const notes = verbEntry("model.list")?.notes ?? [];
    expect(notes.some((note) => /tier/.test(note))).toBe(true);
    expect(notes.some((note) => note.includes("session start --tier"))).toBe(true);
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

  it("declares the ticket comment a lifecycle signal now leaves behind (VC-6)", () => {
    // The two verbs used to promise a session-ledger write and nothing else,
    // and `--dry-run` prints these words verbatim. A verb that quietly grew a
    // second durable write would make the preview describe the wrong command.
    for (const key of ["session.done", "session.blocked"] as const) {
      const effects = verbEntry(key)?.effects;
      expect(
        effects?.durableWrites.map((write) => write.resource),
        key,
      ).toEqual(["session-ledger", "ticket-comment"]);
      expect(JSON.stringify(effects), key).toContain("todo list");
      // Still no board move: the comment is a record, not a state change.
      expect(effects?.nonEffects.join(" "), key).toContain("No Ticket moves");
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

  it("still lets help name the verbs the shell cannot run", () => {
    const discoverable = DISCOVERABLE_VERBS.map((entry) => entry.key);
    const reference = new Set(REFERENCE_VERBS.map((entry) => entry.key));
    // In reference order: the app-only archive, then the agent-control family
    // — start (VC-163), stop, send (VC-86) and delegate — plus the
    // orchestrator's `automation.run` (VC-134, listed by VC-329), each listed
    // so a wrong door teaches instead of reading as no door.
    // The MCP family joins them (VC-380), listed for `automation.run`'s reason:
    // an agent that cannot discover a verb substitutes something worse — here,
    // hand-editing configuration or shelling out.
    expect(discoverable.filter((key) => !reference.has(key))).toEqual([
      "ticket.archive",
      "session.start",
      "session.stop",
      "session.send",
      "session.delegate",
      "automation.run",
      "mcp.list",
      "mcp.preview",
      "mcp.install",
      "mcp.refresh",
      "mcp.enable",
      "mcp.disable",
      "mcp.tools",
      "mcp.remove",
    ]);
  });

  it("is a different surface from the socket: the involuntary pair and the person's verb", () => {
    const reference = new Set(REFERENCE_VERBS.map((entry) => entry.key));
    const socket = new Set<string>(AGENT_COMMANDS);
    expect([...socket].filter((key) => !reference.has(key))).toEqual([
      "project.add",
      "session.start",
      "session.harness",
      "hook",
    ]);
    expect([...reference].filter((key) => !socket.has(key))).toEqual(["app.launch", "help"]);
  });
});

/**
 * The MCP management family (VC-380).
 *
 * VC-8 drew the line these tests keep: an MCP server's own tools are NOT Volli
 * verbs and never enter this registry — they are dynamic, settings-backed, and
 * frozen into a Session's surface by id. The verbs that MANAGE those servers
 * are ordinary Volli verbs and belong here like any other.
 */
const MCP_VERBS = [
  "mcp.list",
  "mcp.preview",
  "mcp.install",
  "mcp.refresh",
  "mcp.enable",
  "mcp.disable",
  "mcp.tools",
  "mcp.remove",
] as const;

describe("the MCP management verbs (VC-380)", () => {
  it("declares all eight as control tier: tool-only, Role-gated, off the socket", () => {
    for (const key of MCP_VERBS) {
      const entry = verbEntry(key);
      expect(entry, key).toBeDefined();
      expect(entry!.accessModes, key).toEqual(["tool"]);
      expect(entry!.actor, key).toBe("role");
      expect(verbTier(entry!), key).toBe("control");
      expect(AGENT_COMMANDS as readonly string[], key).not.toContain(key);
      expect(entry!.handler, key).toEqual({ site: "main", id: key });
    }
  });

  it("freezes management wire names separately from the durable dot-keys", () => {
    expect(verbToolWireName("mcp.list")).toBe("mcp_list");
    expect(verbToolWireName("mcp.list", "server")).toBe("server_list");
    expect(verbToolWireName("session.start")).toBe("session_start");
    expect(verbToolWireName("mcp.unknown" as never)).toBeUndefined();
  });

  it("projects a wire name a provider accepts, with no caller field in any schema", () => {
    for (const key of MCP_VERBS) {
      const tool = verbEntry(key)!.tool;
      // Management is a native Volli verb, not an MCP-discovered tool. The
      // single-underscore mcp_ prefix routes Anthropic OAuth to extra usage.
      expect(tool?.name, key).toBe(key.replace("mcp.", "server_"));
      expect(tool!.description.length, key).toBeGreaterThan(0);
      for (const field of tool!.input) {
        expect(field.name, `${key}.${field.name}`).not.toMatch(/^-/);
      }
      // The door binds the Session and its project. Nothing in the input could
      // name another, because there is no field for one.
      const names = tool!.input.map((field) => field.name);
      for (const forbidden of ["project", "projectId", "session", "actor"]) {
        expect(names, key).not.toContain(forbidden);
      }
    }
  });

  it("makes the two destructive verbs preview unless explicitly told to apply", () => {
    for (const key of ["mcp.install", "mcp.remove"] as const) {
      const entry = verbEntry(key)!;
      expect(entry.previewsByDefault, key).toBe(true);
      const confirm = entry.tool!.input.find((field) => field.name === "confirm");
      expect(confirm, key).toBeDefined();
      expect(confirm?.required, key).toBeUndefined();
      expect(confirm?.type === "enum" ? confirm.values : [], key).toEqual(["preview", "apply"]);
    }
    // Every other MCP verb is an ordinary call: previewing a listing or a
    // toggle would be ceremony over an act that is already reversible.
    for (const key of MCP_VERBS.filter((candidate) => !/install|remove/.test(candidate))) {
      expect(verbEntry(key)!.previewsByDefault, key).toBeUndefined();
    }
  });

  it("warns in the schema itself about the two hazards a caller cannot see", () => {
    const install = verbEntry("mcp.install")!.tool!.description;
    expect(install).toMatch(/runs .*as you|as you, with your/i);
    expect(install).toMatch(/remote/i);
    // The frozen-surface fact, told where a model will read it before calling.
    expect(install).toMatch(/next Session|new Session/i);

    const remove = verbEntry("mcp.remove")!.tool!.description;
    expect(remove).toMatch(/reattach/i);
    expect(remove).toContain("server_disable");
  });

  it("spells args as the array the whole MCP ecosystem spells it as", () => {
    // Claude Code, Claude Desktop, Cursor, VS Code and Zed all use
    // `{ command, args: string[] }`. A model that has read any MCP
    // documentation sends an array, and a schema declaring `string` would meet
    // the ecosystem's own idiom with a provider-level type error.
    for (const key of ["mcp.preview", "mcp.install"] as const) {
      const args = verbEntry(key)!.tool!.input.find((field) => field.name === "args");
      expect(args?.type, key).toBe("array");
      expect(args?.required, key).toBeUndefined();
    }
  });

  it("offers provenance as recorded metadata, never as a promise to fetch or verify", () => {
    const install = verbEntry("mcp.install")!;
    const names = install.tool!.input.map((field) => field.name);
    expect(names).toContain("source");
    expect(names).toContain("version");
    expect(names).toContain("digest");
    const digest = install.tool!.input.find((field) => field.name === "digest");
    expect(digest!.description).toMatch(/record|not verif|never verif/i);
    // Volli downloads nothing: the notes must not imply a package manager.
    expect(JSON.stringify(install.notes)).toMatch(/already on PATH|downloads nothing/i);
  });

  it("declares what each write does and what it explicitly does not", () => {
    for (const key of ["mcp.install", "mcp.remove"] as const) {
      const effects = verbEntry(key)!.effects;
      expect(
        effects?.durableWrites.map((write) => write.resource),
        key,
      ).toContain("mcp-operation");
      expect(effects?.humanVisible.length, key).toBeGreaterThan(0);
      expect(effects?.nonEffects.length, key).toBeGreaterThan(0);
      // The one non-effect every MCP write shares, and the one a model most
      // needs: the Session making the call does not gain the tools.
      expect(JSON.stringify(effects?.nonEffects), key).toMatch(/frozen|current Session/i);
    }
  });

  it("appends the family after every previously frozen tool position", () => {
    const keys = VERB_TOOLS.map((entry) => entry.key);
    // `watch` (VC-457) is appended after the family, for the same reason.
    expect(keys.slice(-(MCP_VERBS.length + 1), -1)).toEqual([...MCP_VERBS]);
    expect(keys.at(-1)).toBe("watch");
    // `session.await` was the last tool before this family; nothing may be
    // inserted ahead of it, because declaration order IS the frozen tool order.
    expect(keys.at(-(MCP_VERBS.length + 2))).toBe("session.await");
  });
});

/** One verb's declared result details, failing the test when it declares none. */
function schemaOf(key: VerbKey): VerbResultDetailsSchema {
  const schema = verbEntry(key)?.tool?.resultDetails;
  expect(schema, key).toBeDefined();
  return schema!;
}

/** Every key required, every key described, no undeclared key — at every level. */
function expectClosedAndDescribed(
  schema: Pick<VerbResultDetailsSchema, "properties" | "required" | "additionalProperties">,
  path: string,
): void {
  expect(schema.additionalProperties, path).toBe(false);
  expect([...schema.required].toSorted(), path).toEqual(Object.keys(schema.properties).toSorted());
  for (const [name, field] of Object.entries(schema.properties)) {
    expect(field.description.trim().length, `${path}.${name}`).toBeGreaterThan(0);
    if (field.type === "object") expectClosedAndDescribed(field, `${path}.${name}`);
  }
}

/**
 * What a verb's result carries as data (VC-471). A Code Mode program reads
 * these keys instead of the prose, so the schema is a promise: every key is
 * there on a successful call, nothing else is, and each one says what it is.
 */
describe("verb result details (VC-471)", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });

  it("is declared for the verbs a program fans out with, and no others yet", () => {
    expect(
      VERB_TOOLS.filter((entry) => entry.tool.resultDetails !== undefined).map(
        (entry) => entry.key,
      ),
    ).toEqual(["session.start", "session.delegate", "watch"]);
  });

  it("is a strict JSON Schema whose every key is required, described, and closed", () => {
    for (const entry of VERB_TOOLS) {
      const schema = entry.tool.resultDetails;
      if (schema === undefined) continue;
      // Compiling under Ajv's strict mode refuses any keyword a standard
      // validator would not recognise, so a renderer reads the same schema.
      expect(() => ajv.compile(schema), entry.key).not.toThrow();
      expect(schema.description.trim().length, entry.key).toBeGreaterThan(0);
      expectClosedAndDescribed(schema, entry.key);
    }
  });

  it("gives session_start the handle, Ticket and model a fan-out acts on", () => {
    const validate = ajv.compile(schemaOf("session.start"));
    const started = {
      sessionId: "abcdef12-3456-7890-abcd-ef1234567890",
      handle: "abcdef12",
      ticket: "VC-12",
      title: "Fix the flaky auth test",
      model: { providerId: "openai-codex", modelId: "gpt-5.6-sol", reasoningLevel: "high" },
      state: "running",
    };
    expect(validate(started)).toBe(true);
    const { handle: _handle, ...unhandled } = started;
    expect(validate(unhandled)).toBe(false);
    expect(validate({ ...started, state: "ready" })).toBe(false);
    expect(validate({ ...started, extra: 1 })).toBe(false);
    expect(validate({ ...started, model: { ...started.model, reasoningLevel: "turbo" } })).toBe(
      false,
    );
    // The handle is the id the other doors accept, and its description is
    // where a program's author learns that the full id is not.
    expect(schemaOf("session.start").properties.handle?.description).toMatch(/watch/);
    expect(schemaOf("session.start").properties.sessionId?.description).toMatch(/handle/);
  });

  it("keeps the two keys session_delegate's transcript row reads, beside the same fields", () => {
    const delegate = schemaOf("session.delegate");
    const start = schemaOf("session.start");
    expect(delegate.required).toEqual(["sessionId", "handle", "title", "model", "state"]);
    // One field set, so a program reads a start and a delegation alike.
    for (const name of delegate.required) {
      expect(delegate.properties[name], name).toBe(start.properties[name]);
    }
    expect(
      ajv.compile(delegate)({
        sessionId: "c0ffee00-0000-0000-0000-000000000000",
        handle: "c0ffee00",
        title: "Find the auth refresh",
        model: { providerId: "anthropic", modelId: "claude-sonnet", reasoningLevel: "off" },
        state: "needs-recovery",
      }),
    ).toBe(true);
  });

  it("gives watch the targets it resolved, as lists a program can compare", () => {
    const validate = ajv.compile(schemaOf("watch"));
    expect(
      validate({ action: "watch", sessions: ["abcdef12"], tickets: ["VC-1", "VC-2"], ended: 0 }),
    ).toBe(true);
    expect(validate({ action: "unwatch", sessions: [], tickets: ["VC-1"], ended: 1 })).toBe(true);
    expect(validate({ action: "watch", sessions: "abcdef12", tickets: [], ended: 0 })).toBe(false);
    expect(validate({ action: "rewatch", sessions: [], tickets: [], ended: 0 })).toBe(false);
  });
});

/** The socket's Session reads, projected onto the WebSocket by VC-663 (D4). */
const SESSION_READS: readonly string[] = SESSION_READ_VERBS;

describe("the host-protocol command catalog (VC-564)", () => {
  // VC-564 A2: one entry serves both doors, each with its own actor policy.
  it("lets a socket verb's agent actor and its router actor differ", () => {
    const socketVerb: VerbEntry = {
      key: "area.write",
      accessModes: ["cli", "hostApi"],
      actor: "session",
      handler: { site: "main", id: "area.write" },
      listed: true,
      group: "App",
      summary: "A synthetic both-doors write.",
      options: [],
      catalog: { actor: "session-own", scope: "workspace", idempotency: "command-id" },
    };
    const [declared] = catalogEntriesFrom([socketVerb]);
    // The router reads its own; the socket, tools and CLI still read `actor`.
    expect(catalogActorOf(declared!)).toBe("session-own");
    expect(declared!.actor).toBe("session");
    expect(verbTier(socketVerb)).toBe("coordination");
    // Every Session-router row judges its own `actor`, but for two kinds of
    // both-door row: `ticket.move` keeps `session` for the socket and admits
    // only the person on a router, and the socket's Session reads (VC-663)
    // keep `any` for the socket and require the person on the WebSocket.
    for (const entry of CATALOG_ENTRIES) {
      expect(catalogActorOf(entry), entry.key).toBe(
        entry.key === "ticket.move" || SESSION_READS.includes(entry.key) ? "user" : entry.actor,
      );
    }
  });

  it("looks a key up in any checked catalog", () => {
    const lookup = catalogLookup(CATALOG_ENTRIES);
    expect(lookup("session.snapshot")).toBe(catalogEntry("session.snapshot"));
    expect(() => lookup("rogue.verb")).toThrow("No catalog entry declares rogue.verb");
  });

  /** The Session router, procedure by procedure: the catalog's first area. */
  const SESSION_ROUTER = {
    "session.list": ["workspace", "read"],
    "session.show": ["workspace", "read"],
    "session.peek": ["workspace", "read"],
    "session.answer": ["workspace", "read"],
    "protocol.welcome": ["host", "read"],
    "protocol.hostWelcome": ["host", "read"],
    "sessions.create": ["workspace", "command-id"],
    "sessions.attach": ["workspace", "command-id"],
    "settings.experiments": ["host", "read"],
    "settings.setExperiment": ["host", "natural"],
    "modelAccess.inspect": ["host", "read"],
    "modelAccess.defaults": ["host", "read"],
    "modelAccess.setDefault": ["host", "natural"],
    "modelAccess.hiddenModels": ["host", "read"],
    "modelAccess.setHiddenModels": ["host", "natural"],
    "modelAccess.compactionPolicy": ["host", "read"],
    "modelAccess.setCompactionPolicy": ["host", "natural"],
    "modelAccess.codeModePolicy": ["host", "read"],
    "modelAccess.setCodeModePolicy": ["host", "natural"],
    "modelAccess.pickerView": ["host", "read"],
    "modelAccess.setPickerView": ["host", "natural"],
    "session.snapshot": ["workspace", "read"],
    "session.history": ["workspace", "read"],
    "session.projection": ["workspace", "read"],
    "session.subscribe": ["workspace", "read"],
    "session.subscribeQueue": ["workspace", "read"],
    "session.command": ["workspace", "command-id"],
    "session.cancelQueued": ["workspace", "command-id"],
    "session.editQueued": ["workspace", "command-id"],
    "session.cancelInteraction": ["workspace", "natural"],
    "session.reconcile": ["workspace", "natural"],
    "session.listing": ["workspace", "read"],
    "session.listingForTicket": ["workspace", "read"],
    "logs.tail": ["host", "read"],
    "logs.follow": ["host", "read"],
    "labDiagnostics.list": ["host", "read"],
    "labDiagnostics.subscribe": ["host", "read"],
    "signIns.status": ["host", "read"],
    "signIns.setApiKey": ["host", "natural"],
    "signIns.signOut": ["host", "natural"],
    "signIns.start": ["host", "natural"],
    "signIns.subscribe": ["host", "read"],
    "signIns.answer": ["host", "natural"],
    "signIns.cancel": ["host", "natural"],
    "signIns.setGitCredential": ["host", "natural"],
    "signIns.clearGitCredential": ["host", "natural"],
    "auth.callback.deliver": ["host", "natural"],
    "workspaces.list": ["host", "read"],
    "workspaces.create": ["host", "command-id"],
  } as const satisfies Record<
    Exclude<CatalogKey, CatalogKeyOf<(typeof BOARD_ENTRIES)[number]>>,
    readonly [string, string]
  >;

  /** The board router: `ticket.move`, both doors' (VC-668), and the board's own (VC-565). */
  const BOARD_ROUTER = {
    "ticket.move": ["workspace", "natural"],
    "board.snapshot": ["workspace", "read"],
    "board.roster": ["workspace", "read"],
    "board.changes": ["workspace", "read"],
    "board.projectFolder": ["workspace", "read"],
    "board.ticketBody": ["workspace", "read"],
    "board.archivedTickets": ["workspace", "read"],
    "board.ticketEvents": ["workspace", "read"],
    "board.latestSignals": ["workspace", "read"],
    "board.statusEntries": ["workspace", "read"],
    "board.comments": ["workspace", "read"],
    "board.updateProject": ["workspace", "command-id"],
    "board.setSkillModes": ["workspace", "command-id"],
    "board.setSessionDefaults": ["workspace", "command-id"],
    "board.createTicket": ["workspace", "command-id"],
    "board.moveTickets": ["workspace", "command-id"],
    "board.setPriority": ["workspace", "command-id"],
    "board.updateTicket": ["workspace", "command-id"],
    "board.setLabels": ["workspace", "command-id"],
    "board.archiveTicket": ["workspace", "command-id"],
    "board.unarchiveTicket": ["workspace", "command-id"],
    "board.deleteTicket": ["workspace", "command-id"],
    "board.createComment": ["workspace", "command-id"],
    "board.updateComment": ["workspace", "command-id"],
    "board.removeComment": ["workspace", "command-id"],
    "board.setLabelColor": ["workspace", "command-id"],
  } as const satisfies Record<
    CatalogKeyOf<(typeof BOARD_ENTRIES)[number]>,
    readonly [string, string]
  >;

  it("declares every router procedure, with its scope and idempotency", () => {
    expect(
      Object.fromEntries(
        CATALOG_ENTRIES.map((entry) => [
          entry.key,
          [entry.catalog.scope, entry.catalog.idempotency],
        ]),
      ),
    ).toEqual({ ...BOARD_ROUTER, ...SESSION_ROUTER });
    expectTypeOf<
      Exclude<
        CatalogKey,
        CatalogKeyOf<(typeof BOARD_ENTRIES)[number]> | keyof typeof SESSION_ROUTER
      >
    >().toEqualTypeOf<never>();
    for (const entry of CATALOG_ENTRIES.filter(({ key }) => key in SESSION_ROUTER)) {
      expect(VERB_SCOPES).toContain(entry.catalog.scope);
      expect(VERB_IDEMPOTENCIES).toContain(entry.catalog.idempotency);
      if (SESSION_READS.includes(entry.key)) {
        // Socket verbs first (D4): listed for agents there, the person's here.
        expect(entry.accessModes, entry.key).toEqual(["cli", "hostApi"]);
        continue;
      }
      // The person's, on no agent surface (D3, D8); the bootstrap read is anyone's.
      expect(entry.actor, entry.key).toBe(entry.key === "protocol.welcome" ? "any" : "user");
      expect(entry.listed, entry.key).toBe(false);
    }
  });

  it("projects onto the WebSocket every entry but the lab's", () => {
    const projected = CATALOG_ENTRIES.filter((entry) => entry.accessModes.includes("hostApi"));
    expect(projected.map((entry) => entry.key)).toEqual([
      ...Object.keys(BOARD_ROUTER),
      ...Object.keys(SESSION_ROUTER).filter((key) => !key.startsWith("labDiagnostics.")),
    ]);
    expectTypeOf<HostApiCatalogCoverage>().toEqualTypeOf<never>();
    expectTypeOf<Exclude<HostApiKey, CatalogKey>>().toEqualTypeOf<never>();
    expectTypeOf<CatalogKeyScopedTo<"workspace">>().toEqualTypeOf<
      | "ticket.move"
      | "board.snapshot"
      | "board.roster"
      | "board.changes"
      | "board.projectFolder"
      | "board.ticketBody"
      | "board.archivedTickets"
      | "board.ticketEvents"
      | "board.latestSignals"
      | "board.statusEntries"
      | "board.comments"
      | "board.updateProject"
      | "board.setSkillModes"
      | "board.setSessionDefaults"
      | "board.createTicket"
      | "board.moveTickets"
      | "board.setPriority"
      | "board.updateTicket"
      | "board.setLabels"
      | "board.archiveTicket"
      | "board.unarchiveTicket"
      | "board.deleteTicket"
      | "board.createComment"
      | "board.updateComment"
      | "board.removeComment"
      | "board.setLabelColor"
      | "session.list"
      | "session.show"
      | "session.peek"
      | "session.answer"
      | "sessions.create"
      | "sessions.attach"
      | "session.snapshot"
      | "session.history"
      | "session.projection"
      | "session.subscribe"
      | "session.subscribeQueue"
      | "session.command"
      | "session.cancelQueued"
      | "session.editQueued"
      | "session.cancelInteraction"
      | "session.reconcile"
      | "session.listing"
      | "session.listingForTicket"
    >();
  });

  it("withholds the start kinds from session.command, whoever asks", () => {
    expect(catalogEntry("session.command").catalog.refusedIntents).toEqual([
      "session.create",
      "adapter.attach",
      "message.cancel",
      "message.edit",
    ]);
  });

  it("answers by key, and refuses a key it does not declare", () => {
    expect(catalogEntry("session.snapshot").key).toBe("session.snapshot");
    expect(() => catalogEntry("ticket.list" as CatalogKey)).toThrow(
      "No catalog entry declares ticket.list",
    );
  });

  const base: VerbEntry = {
    key: "area.verb",
    accessModes: ["hostApi"],
    actor: "user",
    handler: { site: "main", id: "area.verb" },
    listed: false,
    group: "App",
    summary: "A synthetic entry.",
    options: [],
    catalog: { scope: "workspace", idempotency: "command-id" },
  };

  it("refuses an entry no router could police", () => {
    expect(
      catalogEntriesFrom([
        base,
        { ...base, key: "other.verb", catalog: undefined, accessModes: ["cli"] },
      ]),
    ).toEqual([base]);
    expect(() => catalogEntriesFrom([{ ...base, catalog: undefined }])).toThrow(
      "Verb area.verb declares a hostApi access mode with no catalog entry",
    );
    for (const actor of ["session", "role"] as const) {
      const refusal = `Catalog entry area.verb requires a ${actor} actor; a router judges only any, user and session-own (declare catalog.actor)`;
      expect(() => catalogEntriesFrom([{ ...base, actor }])).toThrow(refusal);
      expect(() =>
        catalogEntriesFrom([
          {
            ...base,
            actor: "user",
            catalog: { scope: "workspace", idempotency: "natural", actor },
          },
        ]),
      ).toThrow(refusal);
    }
    expect(catalogEntriesFrom([{ ...base, actor: "any" }])).toHaveLength(1);
    expect(() =>
      catalogEntriesFrom([
        { ...base, catalog: { actor: "session-own", scope: "host", idempotency: "natural" } },
      ]),
    ).toThrow("Catalog entry area.verb is session-own but names no subject to act on");
    for (const catalog of [
      { scope: "workspace", idempotency: "natural", refusedIntents: ["x"] },
      { scope: "host", idempotency: "command-id", refusedIntents: ["x"] },
    ] as const) {
      expect(() => catalogEntriesFrom([{ ...base, catalog }])).toThrow(
        "Catalog entry area.verb refuses intents but is no workspace command",
      );
    }
  });
});
