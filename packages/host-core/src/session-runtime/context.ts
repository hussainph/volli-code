/** Attach-time context shared by desktop and headless hosts. Durable inputs are reused, never re-briefed. */
import type Database from "better-sqlite3";
import { sessionRootThreadId, type SessionEngine } from "@volli/session-engine";
import {
  shortSessionId,
  type CodeModeSurface,
  type PromptResource,
  type SessionEvent,
  type SessionInput,
  type SessionToolId,
  type SessionExecutionVenue,
} from "@volli/shared";
import type { PiRuntimeContext } from "./pi-adapter";
import type { SessionToolSurfacePorts } from "./sessions";
import type { DesktopMcpDispatch } from "../mcp/dispatch-policy";
import { getProjectById } from "../db/projects-repo";
import { getTicket } from "../db/tickets-repo";
import { listMaterializableLinks } from "../db/blobs-repo";
import { composeProjectBrief, composeSubagentBrief, composeTicketBrief } from "../agent-commands";
import { recordedToolSurface, recordedMcpTools } from "./assembly";

/**
 * The recorded brief's text. `getOrRecordSessionInput` is keyed by the input's
 * kind, so a `runtime-brief` request can only ever answer with a
 * `runtime-brief` record — any other kind here is ledger corruption, and the
 * throw fails this attach loudly instead of briefing the Session on nothing.
 */
function briefText(input: SessionInput): string {
  if (input.kind !== "runtime-brief") {
    throw new Error(`Recorded runtime brief has kind ${input.kind}`);
  }
  return input.text;
}

/**
 * The attach-time prompt resources this Session durably recorded, or none.
 * One record per Session at most — `getOrRecordSessionInput` is kind-keyed —
 * so the first hit is the whole answer.
 */
function recordedPromptResources(events: readonly SessionEvent[]): readonly PromptResource[] {
  for (const event of events) {
    if (
      event.payload.kind === "session.input.recorded" &&
      event.payload.input.kind === "prompt-resources"
    ) {
      return event.payload.input.resources;
    }
  }
  return [];
}

/** The MCP-management wire spelling frozen beside the canonical verb keys. */
function recordedMcpManagementNames(events: readonly SessionEvent[]): "server" | undefined {
  for (const event of events) {
    if (
      event.payload.kind === "session.input.recorded" &&
      event.payload.input.kind === "tool-surface"
    ) {
      return event.payload.input.mcpManagementNames;
    }
  }
  return undefined;
}

/** Code Mode's routes and limits, frozen beside the names they route (VC-471). */
function recordedCodeMode(events: readonly SessionEvent[]): CodeModeSurface | undefined {
  for (const event of events) {
    if (
      event.payload.kind === "session.input.recorded" &&
      event.payload.input.kind === "tool-surface"
    ) {
      return event.payload.input.codeMode;
    }
  }
  return undefined;
}

function toolSurfaceTools(input: SessionInput): readonly SessionToolId[] {
  if (input.kind !== "tool-surface") {
    throw new Error(`Recorded Agent Tool Surface has kind ${input.kind}`);
  }
  return input.tools;
}

export function createRuntimeContextResolver(options: {
  db: Database.Database;
  sessionEngine: SessionEngine;
  venue: SessionExecutionVenue;
  mcpDispatch: DesktopMcpDispatch;
  waitForBirth(sessionId: string): Promise<void>;
  toolSurface(): SessionToolSurfacePorts | null;
}): (sessionId: string) => Promise<PiRuntimeContext | null> {
  const { db, sessionEngine, mcpDispatch } = options;
  return async (sessionId) => {
    await options.waitForBirth(sessionId);
    const projection = await sessionEngine.getSession({ sessionId });
    const attaching = projection?.session;
    if (!attaching || projection.modelSelection === null) return null;
    const project = getProjectById(db, attaching.projectId);
    if (!project) return null;
    const provenance = {
      source: { kind: "system", id: "pi-runtime", detail: null },
      venue: options.venue,
    } as const;
    const events = await sessionEngine.listEvents({ sessionId });
    let toolSurface = recordedToolSurface(events);
    // Frozen parallel-read marks, narrowed to today's developer
    // allowlist (VC-454): a tool taken off it stops overlapping.
    let mcpTools = mcpDispatch.forAttach(recordedMcpTools(events));
    let mcpManagementNames = recordedMcpManagementNames(events);
    const codeModeSurface = recordedCodeMode(events);
    if (toolSurface === null) {
      mcpManagementNames = "server";
      // Legacy backfill: the first attach under VC-164 freezes whatever
      // this Session can honestly bind now. Every later attach reads
      // the record and Settings can no longer recompose membership.
      //
      // A legacy Session has no durable birth-grant record, so it gets
      // no new grant here. Applying today's role default would be a hot
      // privilege edit to an existing Session; the fail-closed empty
      // list leaves only the Role bundle it could honestly have held.
      mcpTools = mcpDispatch.forNewSession(options.toolSurface()!.resolveMcp?.(project.id) ?? []);
      toolSurface = toolSurfaceTools(
        await sessionEngine.getOrRecordSessionInput({
          sessionId,
          input: {
            kind: "tool-surface",
            // Nor is it born into Code Mode: that is a birth record
            // with routes, and a backfill has none to freeze.
            tools: options
              .toolSurface()!
              .resolve(attaching.role, [])
              .filter((tool) => tool !== "codemode"),
            mcpManagementNames: "server",
            ...(mcpTools.length === 0 ? {} : { mcpTools }),
          },
          provenance,
        }),
      );
      // The legacy attach freezes the current MCP selection once, just like
      // the role bundle, and subsequent attaches reuse that durable record.
    }
    const shared = {
      projectId: project.id,
      rootThreadId: sessionRootThreadId(sessionId),
      model: projection.modelSelection,
      toolSurface,
      ...(mcpManagementNames === undefined ? {} : { mcpManagementNames }),
      ...(mcpTools.length === 0 ? {} : { mcpTools }),
      ...(codeModeSurface === undefined ? {} : { codeMode: codeModeSurface }),
      // The skills this Session was started with, as recorded ahead of
      // its first attachment (`SessionSkillPorts`). Read from the
      // durable record on EVERY attach — never from disk — so a
      // restart-recovery re-attach composes the same system prompt the
      // first attach did, whatever `.agents/skills/` says today.
      promptResources: recordedPromptResources(events),
    };
    // The Role is the Session's own statement (VC-9), never read off
    // the Ticket: a subagent may carry its parent's Ticket, and a
    // Ticket Session whose Ticket was deleted is still not a project
    // one. Each Role briefs on what its Role means.
    //
    // A subagent's Ticket, when it has one, is read the way any
    // other Session's is; an orphaned one briefs on the checkout. The
    // parent is the Session's own ledger fact, never a host table's.
    const ticket = attaching.ticketId === null ? null : (getTicket(db, attaching.ticketId) ?? null);
    if (attaching.role === "subagent") {
      const parentSessionId = attaching.parentSessionId;
      if (parentSessionId === null) return null;
      const subagentTicket = ticket && ticket.projectId === project.id ? ticket : null;
      const parent = await sessionEngine.getSession({ sessionId: parentSessionId });
      const brief = await sessionEngine.getOrRecordSessionInput({
        sessionId,
        input: {
          kind: "runtime-brief",
          text: composeSubagentBrief({
            project,
            parent: {
              handle: shortSessionId(parentSessionId),
              title: parent?.session.title ?? null,
            },
            ticket: subagentTicket,
          }),
        },
        provenance,
      });
      return {
        ...shared,
        role: "subagent",
        ticketId: subagentTicket?.id ?? null,
        parentSessionId,
        brief: briefText(brief),
      };
    }
    if (attaching.role === "project" || attaching.ticketId === null) {
      // A ticketless Session briefs on the project root it already
      // runs in. A Ticket Session orphaned by a Ticket delete lands
      // here too, attaching as the only thing it can still be.
      const brief = await sessionEngine.getOrRecordSessionInput({
        sessionId,
        input: { kind: "runtime-brief", text: composeProjectBrief({ project }) },
        provenance,
      });
      return {
        ...shared,
        role: "project",
        ticketId: null,
        brief: briefText(brief),
      };
    }
    if (ticket === null || ticket.projectId !== project.id) return null;
    const brief = await sessionEngine.getOrRecordSessionInput({
      sessionId,
      input: {
        kind: "runtime-brief",
        text: composeTicketBrief({
          project,
          ticket,
          attachments: listMaterializableLinks(db, null, ticket.id),
        }),
      },
      provenance,
    });
    return {
      ...shared,
      role: "ticket",
      ticketId: ticket.id,
      brief: briefText(brief),
    };
  };
}
