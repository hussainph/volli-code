/** Desktop-only move vocabulary: closed enums ship with the same app as their caller. */
import { z } from "zod";
import {
  CLOUD_MOVE_ACTIONS,
  CLOUD_MOVE_PREFLIGHT_PHASES,
  CLOUD_MOVE_STEPS,
  CLOUD_MOVE_VIEW_STATES,
  TICKET_STATUSES,
} from "@volli/shared";
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
const action = z.enum(CLOUD_MOVE_ACTIONS);
const step = z.enum(CLOUD_MOVE_STEPS);
const exclusion = z.object({ label: text, reason: text, count: count.optional() });
const rearmTarget = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("column"), automationId: id, status: z.enum(TICKET_STATUSES) }),
  z.strictObject({ kind: z.literal("schedule"), automationId: id }),
]);
const automationRearm = z.object({
  columns: z
    .array(z.object({ automationId: id, name: text, status: z.enum(TICKET_STATUSES) }))
    .max(1000),
  schedules: z.array(z.object({ automationId: id, name: text })).max(1000),
  inertGlobals: z.array(z.object({ id, name: text })).max(1000),
  canRearmOnThisMac: z.boolean(),
  unavailable: text.nullable(),
  retryable: z.boolean(),
});

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
  rearm: rearmTarget.optional(),
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
      counts: counts.nullable(),
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
  preflight: z
    .object({
      phase: z.enum(CLOUD_MOVE_PREFLIGHT_PHASES),
      projectIndex: count,
      projectCount: count,
      projectName: text.nullable(),
      done: count.nullable(),
      total: count.nullable(),
      unit: z.enum(["records", "files"]).nullable(),
      startedAt: count,
    })
    .nullable(),
  moves: z.array(
    z.object({
      moveId: id,
      queueId: id,
      projectId: id,
      projectName: text,
      workspaceName: text,
      state: z.enum(CLOUD_MOVE_VIEW_STATES),
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
      rollback: z.object({ changes: z.array(text), requiresConfirmation: z.boolean() }).nullable(),
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
      automationRearm: automationRearm.optional(),
      localCredentials: z.array(text),
    }),
  ),
}) satisfies z.ZodType<CloudMoveSnapshot>;
