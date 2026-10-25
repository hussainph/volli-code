/**
 * Where each agent verb goes in a cloud launch: the one route table, keyed by
 * the handler key every agent door reaches (VC-894).
 *
 * The doors stay the doors: the `volli` CLI over this runner's socket and the
 * Agent Tool Surface reach the same handler map as in a local launch. What
 * changes in a cloud launch is what answers a key:
 *
 * - `cloud-board`: the backend, under the Session's Agent token (the agent
 *   acting for its owner). Fails fast offline: a board read or write never
 *   waits for a connection.
 * - `session-target`: a Session verb whose answer depends on where its target
 *   Session is claimed: on this runner, the local ledger (which buffers
 *   offline); elsewhere, the backend's Session functions.
 * - `ledger`: this runner's Session runtime and ledger; the drain sends its
 *   facts to the backend. Works offline.
 * - `machine`: this machine's own facts and tools, unchanged.
 * - `person-only`: a person's client does this, never an agent.
 * - `blocked`: waits on another ticket's backend work; until then the verb
 *   keeps its interim behaviour, named here.
 *
 * {@link CLOUD_AGENT_ROUTES} is total over {@link AgentDoorHandlerKey}: a verb
 * added to the Verb Registry fails to compile until it is classified here,
 * and a key that is not an agent-door key is an excess property. That is the
 * parity guard between the local and cloud launches.
 */
import {
  AGENT_COMMAND_BINDINGS,
  SOCKET_BOARD_PROJECTIONS,
  VERB_TOOL_KEYS,
  type AgentCommandBindingId,
  type SocketBoardProjections,
  type VerbToolKey,
} from "@volli/shared";

/**
 * Every handler key an agent door reaches: each socket verb's (a ticket write
 * under the board key it projects) and each Agent Tool Surface verb's.
 */
export type AgentDoorHandlerKey =
  | Exclude<AgentCommandBindingId, keyof SocketBoardProjections>
  | SocketBoardProjections[keyof SocketBoardProjections]
  | VerbToolKey;

/** The handler key a socket binding reaches: a ticket write is its board key. */
export function agentDoorKeyOf(binding: AgentCommandBindingId): AgentDoorHandlerKey {
  return (
    (SOCKET_BOARD_PROJECTIONS as Record<string, AgentDoorHandlerKey>)[binding] ??
    (binding as AgentDoorHandlerKey)
  );
}

/** {@link AgentDoorHandlerKey}, at runtime: the socket's, in registry order, then the tools'. */
export const AGENT_DOOR_HANDLER_KEYS: readonly AgentDoorHandlerKey[] = Object.freeze([
  ...new Set<AgentDoorHandlerKey>([
    ...Object.values(AGENT_COMMAND_BINDINGS).map(agentDoorKeyOf),
    ...VERB_TOOL_KEYS,
  ]),
]);

export type CloudRoute =
  | { readonly route: "cloud-board"; readonly access: "read" | "write" }
  | { readonly route: "session-target" }
  | { readonly route: "ledger" }
  | { readonly route: "machine" }
  | { readonly route: "person-only" }
  | {
      readonly route: "blocked";
      /** The ticket whose backend work routes it for real. */
      readonly until: string;
      /** What the verb does until then. */
      readonly interim: string;
    };

const read = { route: "cloud-board", access: "read" } as const;
const write = { route: "cloud-board", access: "write" } as const;
const ledger = { route: "ledger" } as const;
const machine = { route: "machine" } as const;
const target = { route: "session-target" } as const;
const watches = {
  route: "blocked",
  // VC-887 built the backend half: durable `watches` rows, auto-arms derived
  // when a Session-origin start or send is accepted, and `session.notice`
  // jobs this runner composes and delivers. A cloud launch builds no
  // in-process watches (`inProcessWatches: false`), so nothing is doubled.
  //
  // Receiving wiring (VC-894, S6-3): the explicit verbs call, under the
  // watcher's Agent token (`AgentBackend`), after the tool door's Role barrier
  // and project policy have judged each target:
  // - `watches:watch {watcherSessionId, target: {kind: "session" | "ticket", id}, commandId}`
  //   once per target, `commandId` minted before the first attempt → `{watchId}`;
  // - `watches:unwatch {watcherSessionId, targets?: [{kind, id}]}` → `{ended}`;
  // - `watches:list {watcherSessionId}` → `[{id, target, origin, turnArmed, createdAt}]`.
  until: "VC-894",
  interim:
    "Refused: nothing is watched in-process; Sessions it starts or steers are watched by Volli Cloud from their facts.",
} as const;

const ROUTES = {
  identify: machine,
  board: read,
  "ticket.list": read,
  "ticket.show": read,
  "ticket.events": read,
  "board.createTicket": write,
  "board.updateTicket": write,
  "ticket.move": write,
  "board.createComment": write,
  "ticket.signal": write,
  // Composed on the runner from the backend's reads: presentation, not a rule.
  "ticket.brief": read,
  "worktree.status": machine,
  "worktree.diff": machine,
  "worktree.sync": machine,
  conflicts: machine,
  "project.list": read,
  // A person's bootstrap write (`actor: "user"`): `projects.create` from a person's client.
  "project.add": { route: "person-only" },
  "label.list": read,
  "label.merge": write,
  "model.list": machine,
  cost: {
    route: "blocked",
    until: "VC-573",
    interim: "Usage on this runner only, labelled as this runner's.",
  },
  // `session list` reads the backend's listing; the other three follow their target.
  "session.list": target,
  "session.show": target,
  "session.peek": target,
  "session.answer": target,
  // Without `--env`, a start is born on this runner; starting one elsewhere comes later.
  "session.start": ledger,
  // The caller's own Session: a fact in its ledger, sent by the drain.
  "session.done": ledger,
  "session.blocked": ledger,
  "session.link": ledger,
  "session.harness": ledger,
  notify: {
    route: "blocked",
    until: "VC-578",
    interim: "A native notification on a Mac; refused on Linux.",
  },
  hook: ledger,
  doctor: machine,
  "prompt.baseline": machine,
  "ticket.await": watches,
  "automation.run": {
    route: "blocked",
    until: "VC-569",
    interim: "Refused until Automations run through Volli Cloud.",
  },
  "session.stop": target,
  "session.send": target,
  // The child is born on this runner and inherits its parent's drain cursor.
  "session.delegate": ledger,
  "session.await": watches,
  "mcp.list": machine,
  "mcp.preview": machine,
  "mcp.install": machine,
  "mcp.refresh": machine,
  "mcp.enable": machine,
  "mcp.disable": machine,
  "mcp.tools": machine,
  "mcp.remove": machine,
  watch: watches,
} as const satisfies { readonly [Key in AgentDoorHandlerKey]: CloudRoute };

export const CLOUD_AGENT_ROUTES: typeof ROUTES = Object.freeze(ROUTES);

/** The keys the backend answers for an agent: the board's reads and writes. */
export type CloudBoardKey = {
  [Key in AgentDoorHandlerKey]: (typeof ROUTES)[Key] extends { route: "cloud-board" } ? Key : never;
}[AgentDoorHandlerKey];
