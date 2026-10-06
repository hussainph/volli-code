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
 * call. {@link projectHandler} is the only way to bind such a verb in
 * `AGENT_VERB_TABLE`: the table's type demands the brand it mints for every
 * {@link SocketHandlerKey}, and the private registry below lets a test prove
 * at runtime that each such binding reaches exactly its own key.
 */
import { errorMessage, isOperationUnavailable } from "@volli/shared";
import type { AgentRequest, AgentResponse, HandlerCall, SocketHandlerKey } from "@volli/shared";

import type { HostHandlerInput, HostHandlerOutput } from "../handlers/host-handlers";
import { failure, type AgentCommandContext } from "./context";
import type { AgentVerbBinding } from "./table";

/** A request the projection could map: the handler's input and call, and how to answer. */
export interface SocketDecoded<Key extends SocketHandlerKey> {
  readonly input: HostHandlerInput<Key>;
  readonly call: HandlerCall;
  /** The handler's answer, as the socket's wire shape. */
  readonly reply: (output: HostHandlerOutput<Key>) => AgentResponse;
}

/**
 * The request side of a projection: the handler's input, or the door's own
 * answer when it needs no command (a refusal, a no-op, a dry-run preview).
 */
export type SocketDecode<Key extends SocketHandlerKey> = (
  context: AgentCommandContext,
  request: AgentRequest,
) => SocketDecoded<Key> | AgentResponse;

declare const PROJECTION: unique symbol;

/** A table binding {@link projectHandler} minted for `Key`; nothing else carries the brand. */
export interface ProjectedVerbBinding<Key extends SocketHandlerKey> extends AgentVerbBinding {
  readonly [PROJECTION]: Key;
}

const projected = new WeakMap<AgentVerbBinding, SocketHandlerKey>();

/** The key a binding projects, or undefined for a socket verb with a handler of its own. */
export function projectedHandlerKey(binding: AgentVerbBinding): SocketHandlerKey | undefined {
  return projected.get(binding);
}

/**
 * Binds `key`'s socket verb to `handlers[key]`. A handler's throw is the
 * verb's failure: `APP_UNREACHABLE` when this host cannot answer it now
 * (retryable), `MUTATION_FAILED` otherwise, with the handler's own message.
 */
export function projectHandler<Key extends SocketHandlerKey>(
  key: Key,
  binding: Pick<AgentVerbBinding, "envSession"> & { readonly decode: SocketDecode<Key> },
): ProjectedVerbBinding<Key> {
  const minted: AgentVerbBinding = {
    envSession: binding.envSession,
    async handle(context, request) {
      const decoded = binding.decode(context, request);
      if (!("reply" in decoded)) return decoded;
      const handler = context.options.handlers[key] as (
        input: HostHandlerInput<Key>,
        call: HandlerCall,
      ) => HostHandlerOutput<Key> | Promise<HostHandlerOutput<Key>>;
      try {
        return decoded.reply(await handler(decoded.input, decoded.call));
      } catch (error) {
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
