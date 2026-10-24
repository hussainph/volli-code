/**
 * A socket verb that is also a catalog command is a projection of the host's
 * handler map, never a handler of its own (VC-668; HP § Command catalog,
 * "Doors are projections").
 *
 * The projection maps the socket's envelope and nothing else: the request in
 * (display ids to record ids, the attributed actor, a `--dry-run` preview, a
 * malformed argument's refusal), and the handler's answer out (the wire
 * shape `volli` prints). The command itself, with every effect it has, is
 * `handlers[key]`, the same function the routers and any legacy IPC channel
 * call, invoked through the map's one path under this request's socket
 * policy (`context.handlerPolicy`), so the handler runs only once that
 * policy admits it. {@link projectHandler} is the only way to bind such a verb in
 * `AGENT_VERB_TABLE`: the table's type demands the brand it mints for every
 * {@link SocketHandlerKey} and every {@link SocketBoardProjections} verb, and
 * the private registry below lets a test prove at runtime that each such
 * binding reaches exactly its own key.
 */
import { errorMessage, isHandlerRefused, isOperationUnavailable } from "@volli/shared";
import type { AgentRequest, AgentResponse, HandlerCall, SocketHandlerKey } from "@volli/shared";

import { invokeHandler } from "../handlers/handler-map";
import type { HostHandlerInput, HostHandlerOutput, HostHandlers } from "../handlers/host-handlers";
import { failure, type AgentCommandContext } from "./context";
import type { AgentVerbBinding } from "./table";

/**
 * The socket's ticket writes whose command is a board handler under the
 * board's own key (VC-794): the CLI keeps its verbs and their wire shape, and
 * the write, its receipt, its wakes and its feed rows are the handler's, as
 * they are for the person's own edit. One compound update, not three calls:
 * `board.updateTicket` takes the priority, labels and body mutation too, so
 * `volli ticket update` stays one transaction.
 */
export interface SocketBoardProjections {
  readonly "ticket.create": "board.createTicket";
  readonly "ticket.update": "board.updateTicket";
  readonly "ticket.comment": "board.createComment";
}

/**
 * Every key a socket verb may project: a both-door key under its own name,
 * or a board key a ticket write names. Nothing else can be branded, so a
 * verb cannot be bound to (and its policy cannot admit) any other handler.
 */
export type SocketProjectedKey =
  | SocketHandlerKey
  | SocketBoardProjections[keyof SocketBoardProjections];

/** A request the projection could map: the handler's input and call, and how to answer. */
export interface SocketDecoded<Key extends SocketProjectedKey> {
  readonly input: HostHandlerInput<Key>;
  readonly call: HandlerCall;
  /** The handler's answer, as the socket's wire shape. */
  readonly reply: (output: HostHandlerOutput<Key>) => AgentResponse;
}

/**
 * The request side of a projection: the handler's input, or the door's own
 * answer when it needs no command (a refusal, a no-op, a dry-run preview).
 */
export type SocketDecode<Key extends SocketProjectedKey> = (
  context: AgentCommandContext,
  request: AgentRequest,
) => SocketDecoded<Key> | AgentResponse;

declare const PROJECTION: unique symbol;

/** A table binding {@link projectHandler} minted for `Key`; nothing else carries the brand. */
export interface ProjectedVerbBinding<Key extends SocketProjectedKey> extends AgentVerbBinding {
  readonly [PROJECTION]: Key;
}

const projected = new WeakMap<AgentVerbBinding, SocketProjectedKey>();

/** The key a binding projects, or undefined for a socket verb with a handler of its own. */
export function projectedHandlerKey(binding: AgentVerbBinding): SocketProjectedKey | undefined {
  return projected.get(binding);
}

/**
 * Binds a socket verb to `handlers[key]`, under the request's policy: the
 * verb named `key` itself, or the {@link SocketBoardProjections} verb that
 * names it.
 * A refusal at the map is `FORBIDDEN_ACTOR`, and the handler never ran. A
 * handler's throw is the verb's failure: `APP_UNREACHABLE` when this host
 * cannot answer it now (retryable), `MUTATION_FAILED` otherwise, with the
 * handler's own message.
 */
export function projectHandler<Key extends SocketProjectedKey>(
  key: Key,
  binding: Pick<AgentVerbBinding, "envSession"> & { readonly decode: SocketDecode<Key> },
): ProjectedVerbBinding<Key> {
  const minted: AgentVerbBinding = {
    envSession: binding.envSession,
    async handle(context, request) {
      const decoded = binding.decode(context, request);
      if (!("reply" in decoded)) return decoded;
      const args = [decoded.input, decoded.call] as unknown as Parameters<HostHandlers[Key]>;
      try {
        const output = await invokeHandler(
          context.options.handlers,
          context.handlerPolicy,
          key,
          ...args,
        );
        return decoded.reply(output as HostHandlerOutput<Key>);
      } catch (error) {
        if (isHandlerRefused(error)) {
          return failure("FORBIDDEN_ACTOR", error.message, error.hint ?? undefined);
        }
        return failure(
          isOperationUnavailable(error) ? "APP_UNREACHABLE" : "MUTATION_FAILED",
          errorMessage(error),
        );
      }
    },
  };
  projected.set(minted, key);
  return minted as ProjectedVerbBinding<Key>;
}
