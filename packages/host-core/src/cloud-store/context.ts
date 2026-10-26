/** Cloud brief reads and runner-local location hints. Board prose is recorded only in the Session ledger. */
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import type { Session, Ticket } from "@volli/shared";
import { displayTicketId, shortSessionId } from "@volli/shared";
import type { SessionEngine } from "@volli/session-engine";
import {
  composeProjectBrief,
  composeSubagentBrief,
  composeTicketBrief,
} from "../agent-dispatch/briefs";
import { getAppState, setAppState } from "../db/app-state-repo";
import { prepared } from "../db/prepared";
import { withTransaction } from "../db/transaction-gate";
import type { CloudLocationFacts, CloudLocationRequest } from "./location";
import type { RunnerPathRegistry } from "./paths";

export interface CloudRunnerContext extends CloudLocationFacts {
  sessionId: string;
  ownerUserId: string;
  body: string | null;
}
interface SiteHint {
  projectId: string;
  ticketId: string | null;
  projectRepoId: string;
  ticketPrefix: string;
  ticketNumber: number;
  checkoutMode: "main_checkout" | "worktree";
  branch: string | null;
  baseBranch: string | null;
}
const identity = (input: { projectId: string; ticketId: string | null }) =>
  `${input.projectId}:${input.ticketId ?? ""}`;

function siteFromHint(hint: SiteHint): CloudLocationFacts {
  return {
    project: { id: hint.projectId, name: "this project" },
    ticketPrefix: hint.ticketPrefix,
    primaryRepo: {
      id: hint.projectRepoId,
      projectId: hint.projectId,
      baseBranch: hint.baseBranch,
    },
    ticket:
      hint.ticketId === null
        ? null
        : {
            id: hint.ticketId,
            projectId: hint.projectId,
            number: hint.ticketNumber,
            title: "this ticket",
            checkoutMode: hint.checkoutMode,
            branch: hint.branch,
            baseBranch: hint.baseBranch,
          },
  };
}

export function createCloudContext(options: {
  db: Database.Database;
  ownerUserId: string;
  engine: SessionEngine;
  registry(): RunnerPathRegistry;
  runnerId?(): string | null;
  identityRoot?: string;
  query(input: CloudLocationRequest): Promise<CloudRunnerContext>;
}) {
  const { db, ownerUserId } = options;
  // Full board reads live in memory only until their durable first-attach brief.
  const preparedContexts = new Map<string, CloudRunnerContext>();
  const contexts = new Map<string, Promise<CloudRunnerContext>>();
  const displayIds = new Map<string, string>();
  const identityRoot = resolve(options.identityRoot ?? join(dirname(db.name), "cloud-identities"));
  const siteKey = (sessionId: string) => `volli:runner-site:${ownerUserId}:${sessionId}` as const;

  function check(facts: CloudRunnerContext, input: CloudLocationRequest): CloudRunnerContext {
    if (
      facts.ownerUserId !== ownerUserId ||
      facts.project.id !== input.projectId ||
      (facts.ticket?.id ?? null) !== input.ticketId ||
      facts.primaryRepo.projectId !== input.projectId
    )
      throw new Error("Volli Cloud returned another owner's Session context.");
    return facts;
  }
  async function read(input: CloudLocationRequest): Promise<CloudRunnerContext> {
    let reading = contexts.get(input.sessionId);
    if (reading === undefined) {
      reading = options.query(input).then((facts) => {
        check(facts, input);
        if (facts.ticket !== null)
          displayIds.set(facts.ticket.id, displayTicketId(facts.ticketPrefix, facts.ticket.number));
        return facts;
      });
      contexts.set(input.sessionId, reading);
      reading.catch(() => contexts.delete(input.sessionId));
    }
    return reading;
  }
  function recordSite(session: Session, facts: CloudRunnerContext): void {
    const hint: SiteHint = {
      projectId: session.projectId,
      ticketId: session.ticketId,
      projectRepoId: facts.primaryRepo.id,
      ticketPrefix: facts.ticketPrefix,
      ticketNumber: facts.ticket?.number ?? 0,
      checkoutMode: facts.ticket?.checkoutMode ?? "main_checkout",
      branch: facts.ticket?.branch ?? null,
      baseBranch: facts.ticket?.baseBranch ?? facts.primaryRepo.baseBranch,
    };
    setAppState(db, siteKey(session.id), JSON.stringify(hint), Date.now());
  }
  function hintFor(input: CloudLocationRequest): SiteHint | null {
    const text = getAppState(db, siteKey(input.sessionId));
    if (text === undefined) return null;
    const hint = JSON.parse(text) as SiteHint;
    if (
      hint.projectId !== input.projectId ||
      hint.ticketId !== input.ticketId ||
      typeof hint.projectRepoId !== "string" ||
      !["main_checkout", "worktree"].includes(hint.checkoutMode)
    )
      throw new Error("This Session's runner-local location is corrupt.");
    return hint;
  }

  return {
    async beforeCreate(input: {
      projectId: string;
      ticketId: string | null;
      requestedSessionId?: string | null;
      parentSessionId?: string;
    }) {
      if (
        input.requestedSessionId &&
        (await options.engine.getBaseSession({ sessionId: input.requestedSessionId })) !== null
      )
        return;
      // Birth is a local durable act. New cloud prose is read only at first
      // attach, so an offline start still leaves its intent and owner cursor.
      const parent =
        input.parentSessionId === undefined ? undefined : contexts.get(input.parentSessionId);
      const inheritedSite =
        input.parentSessionId === undefined
          ? null
          : hintFor({
              sessionId: input.parentSessionId,
              projectId: input.projectId,
              ticketId: input.ticketId,
            });
      const facts =
        parent !== undefined
          ? await parent
          : inheritedSite === null
            ? null
            : {
                ...siteFromHint(inheritedSite),
                sessionId: input.parentSessionId!,
                ownerUserId,
                body: null,
              };
      if (facts !== null) {
        check(facts, {
          sessionId: facts.sessionId,
          projectId: input.projectId,
          ticketId: input.ticketId,
        });
        preparedContexts.set(identity(input), facts);
      }
      const runnerId =
        options.runnerId === undefined ? options.registry().runnerId : options.runnerId();
      // The registry's read-only lookup names the folder. A frozen local
      // project needs no read here: the INSERT below runs only when no row
      // exists and the UPDATE touches only a shadow row, so its path and
      // prefix were never written.
      const checkout =
        runnerId === null ? null : options.registry().checkouts.ofProject(input.projectId);
      // An unlocated identity gets an inert, unique machine path, never a
      // guessed checkout. Location preparation still requires the real registry.
      const placeholder = join(
        identityRoot,
        createHash("sha256").update(`${ownerUserId}\0${input.projectId}`).digest("hex"),
      );
      const checkoutPath = checkout?.absPath ?? placeholder;
      withTransaction(db, () => {
        const project = prepared(db, "SELECT id FROM projects WHERE id = ?").get(input.projectId);
        if (project === undefined) {
          prepared(
            db,
            `INSERT INTO projects (id,name,path,ticket_prefix,color_index,sort_order,created_at,updated_at)
            VALUES (?, 'Volli Cloud project', ?, ?, 0, 0, ?, ?)`,
          ).run(
            input.projectId,
            checkoutPath,
            facts?.ticketPrefix ?? "CLOUD",
            Date.now(),
            Date.now(),
          );
          prepared(
            db,
            "INSERT INTO cloud_shadow_rows(kind,id,owner_user_id) VALUES ('project',?,?)",
          ).run(input.projectId, ownerUserId);
        } else {
          prepared(
            db,
            `UPDATE projects SET path = ? WHERE id = ? AND EXISTS
            (SELECT 1 FROM cloud_shadow_rows WHERE kind='project' AND id=projects.id)`,
          ).run(checkoutPath, input.projectId);
        }
        if (
          input.ticketId !== null &&
          prepared(db, "SELECT id FROM tickets WHERE id = ?").get(input.ticketId) === undefined
        ) {
          // Negative, machine-only numbers cannot collide with a diverged frozen
          // board's display numbers. Cloud display identity stays in site hints.
          const number = prepared(
            db,
            `SELECT COALESCE(MIN(ticket_number),0)-1 AS number
            FROM tickets WHERE project_id = ? AND ticket_number < 0`,
          ).get(input.projectId) as { number: number };
          prepared(
            db,
            `INSERT INTO tickets
            (id,project_id,ticket_number,title,body,status,priority,uses_worktree,preferred_harness_id,position,created_at,updated_at)
            VALUES (?,?,?,'Volli Cloud ticket','','backlog','medium',?,'claude-code',0,?,?)`,
          ).run(
            input.ticketId,
            input.projectId,
            number.number,
            facts?.ticket?.checkoutMode === "main_checkout" ? 0 : 1,
            Date.now(),
            Date.now(),
          );
          prepared(
            db,
            "INSERT INTO cloud_shadow_rows(kind,id,owner_user_id) VALUES ('ticket',?,?)",
          ).run(input.ticketId, ownerUserId);
        }
      });
    },
    ticketDisplayIdOf(ticketId: string): string | null {
      const cached = displayIds.get(ticketId);
      if (cached !== undefined) return cached;
      const prefix = `volli:runner-site:${ownerUserId}:`;
      const row = prepared(
        db,
        `SELECT value FROM app_state WHERE key >= ? AND key < ?
        AND json_extract(value, '$.ticketId') = ? LIMIT 1`,
      ).get(prefix, `${prefix}\uffff`, ticketId) as { value: string } | undefined;
      if (row === undefined) return null;
      const hint = JSON.parse(row.value) as SiteHint;
      return displayTicketId(hint.ticketPrefix, hint.ticketNumber);
    },
    created(session: Session) {
      const facts = preparedContexts.get(identity(session));
      // Replays and imported Sessions may already have their FK identities and
      // location hint. Their first-attach resolver still refuses without a brief.
      if (facts === undefined) return;
      if (facts.sessionId !== session.id) contexts.delete(facts.sessionId);
      contexts.set(session.id, Promise.resolve(facts));
      preparedContexts.delete(identity(session));
      recordSite(session, facts);
    },
    /** Briefs may read board prose only until runtime-brief is recorded. */
    async brief(session: Session): Promise<string> {
      const facts = await read({
        sessionId: session.id,
        projectId: session.projectId,
        ticketId: session.ticketId,
      });
      recordSite(session, facts);
      const registry = options.registry();
      const path = registry.checkouts.pathOf(facts.project.id, facts.primaryRepo.id);
      if (path === null)
        throw new Error(`Choose the folder for ${facts.project.name} on this Mac.`);
      const project = { id: facts.project.id, path, ticketPrefix: facts.ticketPrefix };
      const copy =
        facts.ticket === null
          ? null
          : registry.workingCopies.get(facts.ticket.id, facts.primaryRepo.id);
      const ticket =
        facts.ticket === null
          ? null
          : ({
              id: facts.ticket.id,
              ticketNumber: facts.ticket.number,
              title: facts.ticket.title,
              body: facts.body ?? "",
              usesWorktree: facts.ticket.checkoutMode === "worktree",
              worktreePath: registry.workingCopies.pathOf(facts.ticket.id, facts.primaryRepo.id),
              branch: copy?.branch ?? facts.ticket.branch,
              baseBranch: copy?.baseBranch ?? facts.ticket.baseBranch,
            } satisfies Pick<
              Ticket,
              | "id"
              | "ticketNumber"
              | "title"
              | "body"
              | "usesWorktree"
              | "worktreePath"
              | "branch"
              | "baseBranch"
            >);
      // The ledger is the durable copy. Drop board prose from the launch cache
      // after composing; location reads thereafter need only the machine hint.
      contexts.delete(session.id);
      if (session.role === "subagent" && session.parentSessionId !== null) {
        const parent = await options.engine.getBaseSession({ sessionId: session.parentSessionId });
        return composeSubagentBrief({
          project,
          ticket,
          parent: { handle: shortSessionId(session.parentSessionId), title: parent?.title ?? null },
        });
      }
      return ticket === null
        ? composeProjectBrief({ project })
        : composeTicketBrief({ project, ticket, attachments: [] });
    },
    /** Reattachment uses machine hints + registry, not another copy of the board. */
    async site(input: CloudLocationRequest): Promise<CloudLocationFacts> {
      const cached = contexts.get(input.sessionId);
      if (cached !== undefined) return cached;
      const hint = hintFor(input);
      if (hint === null) return read(input);
      return siteFromHint(hint);
    },
    /** Housekeeping always reads current Keep/status/branch facts, never stale birth hints. */
    currentSite: (input: CloudLocationRequest) =>
      options.query(input).then((facts) => check(facts, input)),
  };
}
