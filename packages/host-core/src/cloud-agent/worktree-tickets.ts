/** Cloud board identity joined to this runner's registered copies, never SQLite board rows. */
import { displayTicketId, type AgentResponse, type TicketStatus } from "@volli/shared";
import { isUuid } from "@volli/shared/cloud";
import { failure, type EnvSessionIdentity } from "../agent-dispatch/context";
import { cloudMachinePaths } from "../cloud-store/machine-paths";
import type { RunnerPathRegistry } from "../cloud-store/paths";
import { TICKET_FOLDER_REQUIRED } from "../machine-paths";
import { isInside } from "../worktree/paths";
import type { CollisionTicket } from "../worktree/collisions";
import { NotYetSyncedError, type AgentBackend } from "./agent-backend";
import { CLOUD_VERB_BUDGET_MS, cloudFunctionRefusal, type CloudVerbCall } from "./board-verbs";
import { CloudFunctionError, CloudOfflineError } from "./functions-client";

interface ProjectIdentity {
  id: string;
  name: string;
  ticketPrefix: string;
}
interface TicketIdentity {
  id: string;
  projectId: string;
  number: number;
  status: TicketStatus;
  archivedAt: number | null;
}
type Result<T> = ({ ok: true } & T) | { ok: false; response: AgentResponse };
class WorktreeRefusal extends Error {
  constructor(readonly response: AgentResponse) {
    super("refused");
  }
}

export function createCloudWorktreeTickets(options: {
  backend: AgentBackend;
  registry(): RunnerPathRegistry | null;
  ticketDisplayIdOf(ticketId: string): string | null;
  now?(): number;
}) {
  const now = options.now ?? Date.now;
  const displayIds = new Map<string, string>();
  const machinePaths = cloudMachinePaths({
    registry: options.registry,
    ticketDisplayIdOf: (id) => displayIds.get(id) ?? options.ticketDisplayIdOf(id),
  });

  async function read<T extends object>(
    call: CloudVerbCall,
    body: (
      query: <R>(path: string, args: Record<string, unknown>) => Promise<R>,
      deadline: number,
    ) => Promise<T>,
  ): Promise<Result<T>> {
    if (call.sessionId === null) {
      return {
        ok: false,
        response: failure(
          "SIGN_IN_REQUIRED",
          "A verified Volli Session is required to read Cloud ticket identities.",
        ),
      };
    }
    const sessionId = call.sessionId;
    const deadline = now() + CLOUD_VERB_BUDGET_MS;
    try {
      const query = <R>(path: string, args: Record<string, unknown>) =>
        options.backend.query(sessionId, path, args, { deadline }) as Promise<R>;
      return { ok: true, ...(await body(query, deadline)) };
    } catch (error) {
      if (error instanceof WorktreeRefusal) return { ok: false, response: error.response };
      if (error instanceof CloudOfflineError) {
        return {
          ok: false,
          response: failure(
            "OFFLINE",
            "Cloud ticket identities could not be read. No worktree scan or mutation was performed.",
          ),
        };
      }
      if (error instanceof NotYetSyncedError) {
        return { ok: false, response: failure("NOT_YET_SYNCED", error.message) };
      }
      if (error instanceof CloudFunctionError) {
        return { ok: false, response: cloudFunctionRefusal(error) };
      }
      throw error;
    }
  }

  return {
    machinePaths,
    async resolve(call: CloudVerbCall & { envSession: EnvSessionIdentity | null }): Promise<
      Result<{
        ticket: { id: string };
        project: { name: string };
      }>
    > {
      // The Session's UUID outranks env/cwd hints. Explicit selectors still win,
      // including archived tickets whose retained copies remain readable.
      let selector = call.request.args["id"];
      if (selector === undefined)
        selector = call.envSession?.ticketId ?? call.request.ctx.env.ticket;
      if (selector === undefined) {
        const copies =
          options
            .registry()
            ?.workingCopies.list()
            .filter(
              (copy) => copy.kind === "worktree" && isInside(copy.absPath, call.request.ctx.cwd),
            ) ?? [];
        if (copies.length > 1)
          return {
            ok: false,
            response: failure("AMBIGUOUS_CONTEXT", "Cwd sits in multiple registered worktrees."),
          };
        selector = copies[0]?.ticketId;
      }
      if (selector === undefined)
        return {
          ok: false,
          response: failure(
            "CONTEXT_REQUIRED",
            "Provide a ticket id or run inside a ticket's worktree.",
          ),
        };
      if (typeof selector !== "string" || selector.trim() === "") {
        return {
          ok: false,
          response: failure("INVALID_REQUEST", "A ticket display id or UUID is required."),
        };
      }
      const key = selector.trim();
      return read(call, async (query) => {
        const ticketId = isUuid(key)
          ? key
          : (await query<{ ticketId: string }>("board:resolveTicketKey", { key })).ticketId;
        const { ticket } = await query<{ ticket: TicketIdentity }>("board:getTicket", { ticketId });
        const project = await query<ProjectIdentity>("projects:get", {
          projectId: ticket.projectId,
        });
        displayIds.set(ticket.id, displayTicketId(project.ticketPrefix, ticket.number));
        const path = machinePaths.ticket(ticket.id);
        if (path === null || path.projectId !== ticket.projectId) {
          throw new WorktreeRefusal(failure("INVALID_REQUEST", TICKET_FOLDER_REQUIRED));
        }
        return { ticket: { id: ticket.id }, project: { name: project.name } };
      });
    },
    async roster(call: CloudVerbCall): Promise<
      Result<{
        projects: readonly ProjectIdentity[];
        tickets: readonly CollisionTicket[];
        deadline: number;
      }>
    > {
      return read(call, async (query, deadline) => {
        const { projects } = await query<{ projects: ProjectIdentity[] }>(
          "projects:listForActor",
          {},
        );
        const selector = call.request.args["project"];
        const scope =
          typeof selector !== "string"
            ? projects
            : projects.filter(
                (p) =>
                  p.name.toLowerCase() === selector.toLowerCase() ||
                  p.ticketPrefix.toLowerCase() === selector.toLowerCase() ||
                  machinePaths.projectPath(p.id) === selector,
              );
        if (typeof selector === "string" && scope.length !== 1) {
          throw new WorktreeRefusal(
            failure(
              scope.length === 0 ? "PROJECT_NOT_FOUND" : "AMBIGUOUS_PROJECT",
              `No unique project matches ${selector}.`,
            ),
          );
        }
        // A missing runner/registry is not an authoritative empty scan.
        if (options.registry() === null)
          throw new WorktreeRefusal(failure("INVALID_REQUEST", TICKET_FOLDER_REQUIRED));
        const tickets: CollisionTicket[] = [];
        for (const project of scope) {
          const roster = await query<{ tickets: TicketIdentity[] }>("board:roster", {
            projectId: project.id,
          });
          for (const ticket of roster.tickets) {
            displayIds.set(ticket.id, displayTicketId(project.ticketPrefix, ticket.number));
            const path = machinePaths.ticket(ticket.id);
            if (path === null || path.projectId !== project.id) continue;
            tickets.push({
              id: ticket.id,
              projectId: ticket.projectId,
              ticketNumber: ticket.number,
              status: ticket.status,
              worktreePath: path.worktreePath,
              branch: path.branch,
              baseBranch: path.baseBranch,
            });
          }
        }
        return { projects: scope, tickets, deadline };
      });
    },
  };
}
export type CloudWorktreeTickets = ReturnType<typeof createCloudWorktreeTickets>;
