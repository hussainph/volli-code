/**
 * The socket's Session reads on the router (VC-663, D4): `session.list`,
 * `show`, `peek` and `answer`, Workspace-scoped. The door maps a name and an
 * envelope, nothing more: the handler is the map's `ctx.handlers[key]`, which
 * runs the socket verb's own handler with its roster forced to the named
 * project (`AgentCommandService.executeInWorkspace` in host-core; a
 * socket-delegated key, VC-668), and every input names that project, so the
 * catalog authorizes it before anything is read.
 *
 * The answers are the socket's JSON, validated recursively as JSON before
 * they leave (`z.json()`): the shape is the socket verb's, which its own
 * tests pin.
 */
import { TRPCError } from "@trpc/server";
import { SESSION_LIST_STATES, type AgentResponse } from "@volli/shared";
import { z } from "zod";

import {
  HostProcedureError,
  PROJECT_RESOURCE,
  WORKSPACE_UNKNOWN_MESSAGE,
  type WorkspaceResource,
} from "./catalog";

/** What a Session read's handler is asked: the Workspace it is forced to, and the verb's args. */
export interface SessionReadInput {
  readonly workspaceId: string;
  readonly args: Record<string, unknown>;
}

const MAX_SELECTOR_LENGTH = 128;
const MAX_PEEK_LINES = 1000;

const projectId = z.string().min(1).max(512);
const selector = z.string().trim().min(1).max(MAX_SELECTOR_LENGTH);

export const sessionListInput = z.object({
  projectId,
  /** A ticket display id (`VC-12`). */
  ticket: selector.optional(),
  all: z.boolean().optional(),
  state: z.array(z.enum(SESSION_LIST_STATES)).min(1).max(SESSION_LIST_STATES.length).optional(),
  /** RFC 3339 instant or a look-back (`24h`, `7d`). */
  since: selector.optional(),
});
/** One Session by the short handle `session.list` prints. */
export const sessionHandleInput = z.object({ projectId, session: selector });
export const sessionPeekInput = sessionHandleInput.extend({
  lines: z.number().int().min(1).max(MAX_PEEK_LINES).optional(),
});

const row = z.record(z.string(), z.json());
export const sessionListOutput = z.object({
  sessions: z.array(row),
  hidden: z.number().int().nonnegative(),
});
export const sessionReadOutput = row;

/** Every input names its Workspace: the project, the one resource the catalog authorizes. */
export function readWorkspace(input: { projectId: string }): WorkspaceResource {
  return { kind: PROJECT_RESOURCE, id: input.projectId };
}

/** A not-found of any kind answers as a foreign one does, so neither reveals the other. */
const NOT_FOUND_CODES = new Set(["SESSION_NOT_FOUND", "TICKET_NOT_FOUND", "PROJECT_NOT_FOUND"]);
const CALLER_CODES = new Set([
  "INVALID_REQUEST",
  "AMBIGUOUS_CONTEXT",
  "AMBIGUOUS_TICKET",
  "CONTEXT_MISMATCH",
]);

/** Runs one read through its handler, maps its envelope onto the wire, and validates the answer. */
export async function readSession<Output extends z.ZodType>(
  read: (input: SessionReadInput) => AgentResponse | Promise<AgentResponse>,
  workspaceId: string,
  args: Record<string, unknown>,
  output: Output,
): Promise<z.output<Output>> {
  const response = await read({ workspaceId, args: withoutUndefined(args) });
  if (response.ok) return output.parse(response.data);
  const { code, message } = response.error;
  if (NOT_FOUND_CODES.has(code)) {
    throw new HostProcedureError("workspace-unknown", WORKSPACE_UNKNOWN_MESSAGE);
  }
  throw new TRPCError({
    code: CALLER_CODES.has(code) ? "BAD_REQUEST" : "INTERNAL_SERVER_ERROR",
    message,
  });
}

/** The socket reads an absent flag and an `undefined` one alike; JSON never carries the latter. */
function withoutUndefined(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}
