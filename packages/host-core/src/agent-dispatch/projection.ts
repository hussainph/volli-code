/**
 * Every socket verb is a projection of the host's handler map, never a
 * handler of its own (VC-668, VC-923; HP § Command catalog, "Doors are
 * projections"): a catalog command's under its key, a board ticket write's
 * under the board's ({@link projectHandler}), and each of the socket's own
 * verbs under its own key ({@link servedVerb}). The four Session reads the
 * map delegates the other way keep the socket's handler.
 *
 * The projection maps the socket's envelope and nothing else: the request in
 * (display ids to record ids, the attributed actor, a `--dry-run` preview, a
 * malformed argument's refusal), and the handler's answer out (the wire
 * shape `volli` prints). The command itself, with every effect it has, is
 * `handlers[key]`, the same function the routers and any legacy IPC channel
 * call, invoked through the map's one path under this request's socket
 * policy (`context.handlerPolicy`), so the handler runs only once that
 * policy admits it. {@link projectHandler} and {@link servedVerb} are the
 * only ways to bind such a verb in `AGENT_VERB_TABLE`: the table's type
 * demands the brand they mint for every {@link SocketHandlerKey} and every
 * {@link SocketBoardProjections} verb, and the private registry below lets a
 * test prove at runtime that each such binding reaches exactly its own key.
 */
import { errorMessage, isHandlerRefused, isOperationUnavailable } from "@volli/shared";
import type {
  AgentRequest,
  AgentResponse,
  HandlerCall,
  SocketBoardProjections,
  SocketHandlerKey,
  TicketEventActor,
} from "@volli/shared";

import { HandlerNotServedError, invokeHandler } from "../handlers/handler-map";
import type {
  HostHandlerInput,
  HostHandlerOutput,
  HostHandlers,
  SocketServedKey,
} from "../handlers/host-handlers";
import type { ServedAgentHandlerKey } from "@volli/shared";
import { failure, type AgentCommandContext } from "./context";
import type { DoorActor } from "./resolution";
import type { AgentVerbBinding } from "./table";

/**
 * The socket's ticket writes whose command is a board handler under the
 * board's own key (VC-794): `@volli/shared`'s declaration, re-exported for the
 * table's type.
 */
export type { SocketBoardProjections } from "@volli/shared";

/**
 * Every key a socket verb may project: a key it serves under its own verb's
 * name (a both-door catalog command's, or one of its own verbs', VC-923), or
 * a board key a ticket write names. Nothing else can be branded, so a verb
 * cannot be bound to (and its policy cannot admit) any other handler.
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

/**
 * A table binding {@link projectHandler} or {@link servedVerb} minted for
 * `Key`; nothing else carries the brand.
 */
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
export function projectHandler<Key extends Exclude<SocketProjectedKey, ServedAgentHandlerKey>>(
  key: Key,
  binding: Pick<AgentVerbBinding, "envSession"> & {
    readonly decode: SocketDecode<Key>;
    /**
     * The verb's own answer for a handler's throw, where it has a vocabulary
     * of its own for one (the start's model refusals); `undefined` falls
     * through to the rule below.
     */
    readonly failed?: (error: unknown) => AgentResponse | undefined;
  },
): ProjectedVerbBinding<Key> {
  return minted(key, binding.envSession, binding.decode, (error) => {
    const own = binding.failed?.(error);
    if (own !== undefined) return own;
    const refusal = mapRefusal(error);
    if (refusal !== undefined) return refusal;
    return failure(
      isOperationUnavailable(error) ? "APP_UNREACHABLE" : "MUTATION_FAILED",
      errorMessage(error),
    );
  });
}

/**
 * Binds one of the socket's own verbs to `handlers[key]`, its entry on the
 * map (VC-923): the verb's handler, which the agent command service serves
 * into the map. The request goes in as the door resolved it, and the answer
 * comes back as the verb's own wire answer, untouched.
 *
 * Only the map's own answers are mapped: a refusal at the map is
 * `FORBIDDEN_ACTOR`, and an entry nothing served is `APP_UNREACHABLE`
 * (retryable). Anything the verb throws is the verb's own failure and goes
 * on to the socket's generic door exactly as it did when the table called
 * the verb directly.
 */
export function servedVerb<Key extends SocketServedKey>(
  key: Key,
  envSession: AgentVerbBinding["envSession"],
): ProjectedVerbBinding<Key> {
  return minted(
    key,
    envSession,
    (context, request) => ({
      input: {
        request: withoutCredentials(request),
        projects: context.projects,
        envSession: context.envSession,
        envSessionTerminal: context.envSessionTerminal,
        authenticatedSessionId: context.authenticatedSessionId,
        actor: context.actor,
      },
      call: { actor: context.actor ?? context.doorActor },
      reply: (output) => output,
    }),
    (error) => {
      const refusal = mapRefusal(error);
      if (refusal !== undefined) return refusal;
      if (error instanceof HandlerNotServedError) {
        return failure("APP_UNREACHABLE", errorMessage(error));
      }
      throw error;
    },
  );
}

/** A refusal at the map, as the socket's own refusal; undefined for anything else. */
function mapRefusal(error: unknown): AgentResponse | undefined {
  return isHandlerRefused(error)
    ? failure("FORBIDDEN_ACTOR", error.message, error.hint ?? undefined)
    : undefined;
}

/**
 * The request a served verb's entry is asked, with the door's credentials
 * left behind: the attachment token and the operator token prove who called
 * at the door, which judged them, and no verb reads them. The `VOLLI_SESSION`
 * claim stays, because verbs resolve a caller's project from it.
 */
function withoutCredentials(request: AgentRequest): AgentRequest {
  const env = { ...request.ctx.env };
  delete env.token;
  delete env.operatorToken;
  return { ...request, ctx: { ...request.ctx, env } };
}

/**
 * Who a door's actor is, as host history attributes a caller: the call a
 * verb with no attribution of its own (a read, or a verb that skips identity)
 * is made under. A Session cites its own Ticket only where the door resolved
 * the same Session's identity.
 */
export function doorCallActor(
  door: DoorActor,
  envSession: AgentCommandContext["envSession"],
): TicketEventActor {
  switch (door.kind) {
    case "operator":
      return { kind: "user" };
    case "session":
      return {
        kind: "session",
        sessionId: door.sessionId,
        ticketId: envSession?.id === door.sessionId ? envSession.ticketId : null,
      };
    default:
      return { kind: "unauthenticated" };
  }
}

function minted<Key extends SocketProjectedKey>(
  key: Key,
  envSession: AgentVerbBinding["envSession"],
  decode: SocketDecode<Key>,
  failed: (error: unknown) => AgentResponse,
): ProjectedVerbBinding<Key> {
  const binding: AgentVerbBinding = {
    envSession,
    async handle(context, request) {
      const decoded = decode(context, request);
      if (!("reply" in decoded)) return decoded;
      const args = [decoded.input, decoded.call] as unknown as Parameters<HostHandlers[Key]>;
      let output: HostHandlerOutput<Key>;
      try {
        output = (await invokeHandler(
          context.options.handlers,
          context.handlerPolicy,
          key,
          ...args,
        )) as HostHandlerOutput<Key>;
      } catch (error) {
        return failed(error);
      }
      return decoded.reply(output);
    },
  };
  projected.set(binding, key);
  return binding as ProjectedVerbBinding<Key>;
}
