/**
 * The hidden-project sweep: while a person-authorized import is writing a
 * project (`moveState: "importing"`), every public query, mutation and action
 * in the generated api treats it as not found, for everyone: its importer,
 * another Member, the importer's runner and an agent of one of their visible
 * Sessions.
 *
 * Each function is called by each caller in three fresh, identical worlds:
 *
 * - **absent**: every argument that names a project, ticket, Session,
 *   comment or job names one that does not exist.
 * - **hidden**: the same arguments name the moved project's. The answer must
 *   be the absent one: the same refusal, or the same answer once the ids are
 *   lined up (other ids and times normalised). An importing project is
 *   indistinguishable from no project at all. The few deliberate exceptions
 *   are {@link SAME_AS_ABSENT_EXCEPT}, each with why it says nothing of the
 *   project.
 * - **neighbour**: the arguments name the visible project, ticket and
 *   Session next to it, one of whose Sessions is the parent of a moved
 *   subagent. A function may answer, but nothing it answers may name the
 *   moved project or anything in it.
 *
 * Either way no call may write a row that names the moved project (or change
 * one it holds). The enumeration is `public-functions.ts`, the anonymous
 * sweep's; a new public function joins this sweep with no registration step.
 *
 * The importer's own door (`projectImports.*`) is exempt for the importer: it
 * is how they read and drive the move.
 */

import type { GenericDatabaseReader, GenericDataModel } from "convex/server";
import type { ValidatorJSON, Value } from "convex/values";
import { describe, expect, test } from "vite-plus/test";

import {
  AGENT_TOKEN_ISSUER,
  RUNNER_TOKEN_ISSUER,
  agentSubject,
  newId,
  type SessionId,
} from "@volli/shared/cloud";

import schema from "../functions/schema";
import { api } from "../functions/_generated/api";
import {
  HIDDEN_TEXT,
  MANIFEST_SHA,
  MOVED,
  U,
  importedWorld,
  type ImportWorld,
} from "./projectImport-fixtures";
import { PUBLIC, call, refusalCode, sampleArgs, type PublicFunction } from "./public-functions";

type Caller = "importer" | "member" | "runner" | "agent";
const CALLERS: readonly Caller[] = ["importer", "member", "runner", "agent"];
type Pass = "absent" | "hidden" | "neighbour";

/** The imported runner job (the fixture's, queued for the importer's runner). */
const MOVED_JOB = U(12);

/** Every id and text the moved project holds that a leak would carry. */
const HIDDEN_MARKERS: readonly string[] = [
  MOVED.projectId,
  MOVED.ticketId,
  MOVED.sessionId,
  MOVED.childSessionId,
  MOVED.commentId,
  MOVED_JOB,
  ...HIDDEN_TEXT,
];

/**
 * Where the hidden pass may answer differently from the absent one, and why
 * that says nothing about the moved project.
 */
const SAME_AS_ABSENT_EXCEPT: Record<string, string> = {
  // A project id is unique across every Workspace, so creating one with the
  // moved project's id is `id_taken`, as it would be for any project. The id
  // is the importer's own UUID; nothing of the project is answered.
  "projects:create": "project ids are globally unique",
};

function clientFor(world: ImportWorld, caller: Caller) {
  switch (caller) {
    case "importer":
      return world.alice.as;
    case "member":
      return world.bob.as;
    case "runner":
      return world.t.withIdentity({
        subject: `runner:${world.runnerId}`,
        issuer: RUNNER_TOKEN_ISSUER,
        gen: 1,
      });
    case "agent":
      return world.t.withIdentity({
        subject: agentSubject(world.visible.sessionId as SessionId),
        issuer: AGENT_TOKEN_ISSUER,
        own: world.alice.userId,
        rnr: world.runnerId,
        gen: 1,
        tkt: world.visible.ticketId,
      });
  }
}

/** The ids an argument names a row by, per pass; `absent` ones exist nowhere. */
const ABSENT = {
  projectId: "00000000-0000-4000-8000-00000000a001",
  ticketId: "00000000-0000-4000-8000-00000000a005",
  sessionId: "00000000-0000-4000-8000-00000000a020",
  childSessionId: "00000000-0000-4000-8000-00000000a022",
  commentId: "00000000-0000-4000-8000-00000000a007",
  jobId: "00000000-0000-4000-8000-00000000a012",
  key: "ZQ-1",
};
const HIDDEN = {
  projectId: MOVED.projectId,
  ticketId: MOVED.ticketId,
  sessionId: MOVED.sessionId,
  childSessionId: MOVED.childSessionId,
  commentId: MOVED.commentId,
  jobId: MOVED_JOB,
  key: "AL-1",
};

/** Arguments by name: what each pass puts in an argument that names a row. */
function fillFor(world: ImportWorld, pass: Pass) {
  const ids =
    pass === "absent"
      ? ABSENT
      : pass === "hidden"
        ? HIDDEN
        : {
            projectId: world.visible.projectId,
            ticketId: world.visible.ticketId,
            sessionId: world.visible.sessionId,
            childSessionId: world.visible.sessionId,
            commentId: ABSENT.commentId,
            jobId: ABSENT.jobId,
            key: "TS-1",
          };
  const named: Record<string, Value> = {
    ...ids,
    parentSessionId: ids.sessionId,
    workspaceId: world.workspaceId,
    runnerId: world.runnerId,
    ticketIds: [ids.ticketId],
    sessionIds: [ids.sessionId],
    cursor: null,
    paginationOpts: { numItems: 20, cursor: null },
    page: { numItems: 20, cursor: null },
  };
  return (name: string, validator: ValidatorJSON): Value | undefined => {
    // Every command is a new one: a receipt must not answer for an earlier call.
    if (name === "commandId" && accepts(validator, "string")) return newId("command");
    if (!(name in named)) return undefined;
    const value = named[name]!;
    const kind =
      value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : typeof value === "object"
            ? "object"
            : "string";
    return accepts(validator, kind) ? value : undefined;
  };
}

function accepts(validator: ValidatorJSON, kind: string): boolean {
  return validator.type === "union"
    ? validator.value.some((member) => accepts(member, kind))
    : validator.type === kind;
}

/** Whether any argument (at any depth) is one the passes fill with a row's id. */
function namesARow(fn: PublicFunction): boolean {
  const filled = new Set([...Object.keys(ABSENT), "parentSessionId", "ticketIds", "sessionIds"]);
  const walk = (validator: ValidatorJSON): boolean =>
    validator.type === "object"
      ? Object.entries(validator.value).some(
          ([name, field]) => filled.has(name) || walk(field.fieldType),
        )
      : validator.type === "union"
        ? validator.value.some(walk)
        : false;
  return walk(fn.args);
}

/** Every stored row (scheduled functions included) that names the moved project, canonically. */
async function hiddenRows(world: ImportWorld): Promise<string[]> {
  return world.t.run(async (ctx) => {
    const db = ctx.db as unknown as GenericDatabaseReader<GenericDataModel>;
    const rows: string[] = [];
    for (const table of Object.keys(schema.tables)) {
      for (const doc of await db.query(table).collect()) {
        const { _creationTime: _ignored, ...rest } = doc;
        const text = JSON.stringify(rest);
        if (HIDDEN_MARKERS.some((marker) => text.includes(marker))) rows.push(`${table} ${text}`);
      }
    }
    for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
      const text = JSON.stringify(job.args);
      if (HIDDEN_MARKERS.some((marker) => text.includes(marker))) rows.push(`scheduled ${text}`);
    }
    return rows.toSorted();
  });
}

/**
 * An answer as comparable text: the pass's own ids lined up as placeholders,
 * every other id and every time normalised (each world mints its own).
 */
function normalise(text: string, pass: Pass): string {
  const ids = pass === "hidden" ? HIDDEN : ABSENT;
  let out = text;
  for (const [name, id] of Object.entries(ids)) out = out.split(id).join(`<${name}>`);
  return out
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\b1[0-9]{12}\b/g, "<time>");
}

type Observation = { outcome: string; answer: string | null; leaked: string[] };

async function observe(
  world: ImportWorld,
  fn: PublicFunction,
  caller: Caller,
  pass: Pass,
): Promise<Observation> {
  const before = await hiddenRows(world);
  let outcome: string;
  let answer: string | null = null;
  let leaked: string[] = [];
  try {
    const value = await call(clientFor(world, caller), fn, sampleArgs(fn, fillFor(world, pass)));
    const text = JSON.stringify(value) ?? "undefined";
    answer = normalise(text, pass);
    // The hidden pass's own arguments may come back (an echo of what was
    // asked); the absent comparison judges those. Content never may.
    const markers = pass === "hidden" ? HIDDEN_TEXT : HIDDEN_MARKERS;
    leaked = markers.filter((marker) => text.includes(marker));
    outcome = "answered";
  } catch (error) {
    const code = refusalCode(error);
    outcome =
      code === null ? `threw: ${error instanceof Error ? error.message : String(error)}` : code;
  }
  const after = await hiddenRows(world);
  if (after.join("\n") !== before.join("\n")) leaked.push("wrote into the moved project");
  return { outcome, answer, leaked };
}

async function run(fn: PublicFunction, pass: Pass, options: { committed?: boolean } = {}) {
  const world = await importedWorld({ parentSessionId: (visible) => visible });
  if (options.committed === true) {
    await world.alice.as.mutation(api.projectImports.commit, {
      moveId: world.moveId,
      manifestSha256: MANIFEST_SHA,
    });
  }
  const observations = new Map<Caller, Observation>();
  for (const caller of CALLERS) {
    // The importer's own door is how they read and drive the move.
    if (caller === "importer" && fn.path.startsWith("projectImports:")) continue;
    observations.set(caller, await observe(world, fn, caller, pass));
  }
  return observations;
}

describe("an importing project is hidden from every public function", () => {
  test("every exception is still a public function", () => {
    const paths = new Set(PUBLIC.map(({ path }) => path));
    for (const path of Object.keys(SAME_AS_ABSENT_EXCEPT)) expect(paths.has(path), path).toBe(true);
  });

  // The control: once committed, the same calls do tell the project from an
  // absent one, so the sweep's arguments reach the moved rows.
  test.each([
    ["projects:get", "importer"],
    ["board:getTicket", "member"],
    ["board:resolveTicketKey", "agent"],
    ["sessions:snapshot", "member"],
    ["runners:places", "importer"],
    ["runnerJobs:renew", "runner"],
    ["agentTokens:mint", "runner"],
  ] as const)("control: %s tells a committed project apart (%s)", async (path, caller) => {
    const fn = PUBLIC.find((candidate) => candidate.path === path)!;
    const absent = (await run(fn, "absent", { committed: true })).get(caller)!;
    const committed = (await run(fn, "hidden", { committed: true })).get(caller)!;
    expect(`${committed.outcome} ${committed.answer}`).not.toBe(
      `${absent.outcome} ${absent.answer}`,
    );
  });

  test.each(PUBLIC)("$path ($kind)", async (fn) => {
    const absent = await run(fn, "absent");
    const hidden = await run(fn, "hidden");
    const neighbour = await run(fn, "neighbour");
    const problems: string[] = [];
    for (const [caller, seen] of hidden) {
      const baseline = absent.get(caller)!;
      for (const leak of [...seen.leaked, ...baseline.leaked])
        problems.push(`${caller}/hidden: ${leak}`);
      for (const leak of neighbour.get(caller)!.leaked)
        problems.push(`${caller}/neighbour: ${leak}`);
      // Without an argument naming a row, the two passes make the same call.
      if (!namesARow(fn) || fn.path in SAME_AS_ABSENT_EXCEPT) continue;
      if (seen.outcome !== baseline.outcome || seen.answer !== baseline.answer) {
        problems.push(
          `${caller}/hidden: ${seen.outcome} ${seen.answer ?? ""} where absent is ${baseline.outcome} ${baseline.answer ?? ""}`,
        );
      }
    }
    expect(problems).toEqual([]);
  });
});
