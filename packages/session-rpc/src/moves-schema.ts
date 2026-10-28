/** Desktop-only move vocabulary: closed enums ship with the same app as their caller. */
import { z } from "zod";
import type {
  CloudMoveSnapshot,
  CloudMovePreflight,
  CloudMovePreflightInput,
  CloudMoveStartInput,
  CloudMoveCommand,
} from "@volli/shared";

const text = z.string().max(4096);
const id = z.string().min(1).max(200);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const counts = z.object({
  tickets: count,
  sessions: count,
  events: count,
  attachments: count,
  attachmentBytes: count,
  transcriptBytes: count,
  piLogBytes: count,
});
const action = z.enum([
  "pause",
  "resume",
  "cancel",
  "retry",
  "skip",
  "finish",
  "open-cloud",
  "go-back",
  "remove-local",
]);
const step = z.enum([
  "backup",
  "freeze",
  "export",
  "upload",
  "copy",
  "history",
  "verify",
  "handover",
  "check",
]);
const exclusion = z.object({ label: text, reason: text, count: count.optional() });

export const movePreflightInputSchema = z.strictObject({
  projectIds: z.array(id).max(1000).optional(),
  workspaceId: id.nullable(),
  includeRemoved: z.boolean(),
}) satisfies z.ZodType<CloudMovePreflightInput>;
export const moveStartInputSchema = z.strictObject({
  preflightId: id,
  projectIds: z.array(id).min(1).max(1000),
  workspaceId: id,
  stopAtFirstProblem: z.boolean(),
}) satisfies z.ZodType<CloudMoveStartInput>;
export const moveCommandSchema = z.strictObject({
  moveId: id,
  action,
  confirmation: text.optional(),
}) satisfies z.ZodType<CloudMoveCommand>;
export const moveIdInputSchema = z.strictObject({ moveId: id });
export const moveReportSchema = z.string().max(4 * 1024 * 1024);

export const movePreflightSchema = z.object({
  id,
  backupDirectory: text,
  disk: z.object({ requiredBytes: count, freeBytes: count }),
  stopAtFirstProblem: z.boolean(),
  exclusions: z.array(exclusion),
  projects: z.array(
    z.object({
      id,
      name: text,
      removed: z.boolean(),
      counts,
      estimateSeconds: count.nullable(),
      blockers: z.array(
        z.object({ message: text, sessionId: id.optional(), ticketId: id.optional() }),
      ),
      exclusions: z.array(exclusion),
      warnings: z.array(text),
    }),
  ),
}) satisfies z.ZodType<CloudMovePreflight>;

export const moveSnapshotSchema = z.object({
  revision: count,
  account: z.object({ userId: id, displayName: text }).nullable(),
  workspaces: z.array(z.object({ id, name: text, canMove: z.boolean() })),
  unavailable: text.nullable(),
  moves: z.array(
    z.object({
      moveId: id,
      queueId: id,
      projectId: id,
      projectName: text,
      workspaceName: text,
      state: z.enum([
        "queued",
        "moving",
        "waiting",
        "problem",
        "check",
        "finished",
        "rolled-back",
        "returned",
      ]),
      step,
      completedSteps: z.array(step),
      message: text,
      progress: z
        .object({ completed: count, total: count, unit: z.enum(["bytes", "rows", "sessions"]) })
        .nullable(),
      estimateSeconds: count.nullable(),
      actions: z.array(action),
      localReadOnly: z.boolean(),
      confirmedAt: count.nullable(),
      backupPath: text.nullable(),
      returnExportPath: text.nullable(),
      checks: z.array(
        z.object({
          label: text,
          passed: z.boolean(),
          sourceCount: count.optional(),
          cloudCount: count.optional(),
        }),
      ),
      counts: counts.nullable(),
      pausedAutomations: z.array(text),
      localCredentials: z.array(text),
    }),
  ),
}) satisfies z.ZodType<CloudMoveSnapshot>;
