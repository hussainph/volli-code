/**
 * The remote hosts commands' validators (VC-700 PR 2; wire types in
 * `@volli/shared`'s `remote-hosts.ts`), for the desktop-only tier's
 * `hosts.*` and `hostAdd.*` procedures.
 *
 * Inputs are strict and bounded: an unknown key, an over-long field or a
 * malformed id is `BAD_REQUEST` before any handler runs. Outputs describe the
 * wire types exactly and publish with `z.toJSONSchema`, so no transforms and
 * no custom parsers. A question's own fields are open JSON (`z.json()`).
 */
import {
  REMOTE_HOST_DEVICE_TEXT_MAX,
  REMOTE_HOST_DEVICES_MAX,
  REMOTE_HOST_NAME_MAX,
  type AddHostEvent,
  type AddHostFailure,
  type AddHostLogLine,
  type AddHostStepId,
  type AddHostStepStatus,
  type AddHostView,
  type RemoteHost,
  type RemoteHostDevice,
  type RemoteHostDevices,
  type RemoteProjectLink,
  type RemoteHostsSnapshot,
  type RenameRemoteHostInput,
} from "@volli/shared";
import { z } from "zod";

/** A host's id: hostd's `hostId`, a UUID. */
const hostId = z.uuid();
/** An add flow's id, as desktop main minted it. */
export const MAX_FLOW_ID_LENGTH = 128;
/** `you@box:2222`, or a `~/.ssh/config` alias: a host name is at most 253 characters. */
export const MAX_TARGET_LENGTH = 255;
export const MAX_HOST_NAME_LENGTH = 120;
export const MAX_PROVIDER_ID_LENGTH = 128;
/** Far past any real sudo password; a bound, not a policy. */
export const MAX_SUDO_PASSWORD_LENGTH = 1024;

const flowId = z.string().min(1).max(MAX_FLOW_ID_LENGTH);
/** The id of the question an answer is for (`AddHostQuestion.id`). */
export const MAX_QUESTION_ID_LENGTH = 64;
const questionId = z.string().min(1).max(MAX_QUESTION_ID_LENGTH);

/** The add flow's steps, in order (`@volli/host-install`'s `STEP_ORDER`). */
export const ADD_HOST_STEPS = [
  "connect",
  "probe",
  "deliver",
  "install",
  "start",
  "enroll",
  "link",
] as const satisfies readonly AddHostStepId[];
const ADD_HOST_STEP_STATUSES = [
  "pending",
  "running",
  "done",
  "skipped",
  "failed",
] as const satisfies readonly AddHostStepStatus[];

type AssertNever<Type extends never> = Type;
/** Every step the wire names is one the validators accept. */
export type AddHostStepsCoverage = AssertNever<
  | Exclude<AddHostStepId, (typeof ADD_HOST_STEPS)[number]>
  | Exclude<AddHostStepStatus, (typeof ADD_HOST_STEP_STATUSES)[number]>
>;

const stepId = z.enum(ADD_HOST_STEPS);

/* ── Inputs ─────────────────────────────────────────────────────────────── */

export const hostInputSchema = z.strictObject({ hostId });
export const flowInputSchema = z.strictObject({ flowId });
export const updateHostInputSchema = z.strictObject({
  hostId,
  when: z.enum(["now", "when-idle"]),
});
export const signInInputSchema = z.strictObject({
  hostId,
  providerId: z.string().min(1).max(MAX_PROVIDER_ID_LENGTH),
});
export const addHostStartInputSchema = z.strictObject({
  target: z.string().min(1).max(MAX_TARGET_LENGTH),
  name: z.string().min(1).max(MAX_HOST_NAME_LENGTH).optional(),
});
/** `AddHostAnswer`: one kind per question the flow can stop on. */
const addHostAnswerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("accept-host-key") }),
  z.strictObject({ kind: z.literal("update") }),
  z.strictObject({ kind: z.literal("adopt") }),
  z.strictObject({ kind: z.literal("open") }),
  z.strictObject({ kind: z.literal("user-install") }),
  z.strictObject({ kind: z.literal("repair") }),
]);
export const hostAddAnswerInputSchema = z.strictObject({
  flowId,
  questionId,
  answer: addHostAnswerSchema,
});
export const sudoPasswordInputSchema = z.strictObject({
  flowId,
  questionId,
  password: z.string().min(1).max(MAX_SUDO_PASSWORD_LENGTH),
});
export const hostAddRetryInputSchema = z.strictObject({ flowId, from: stepId.optional() });
/**
 * `RenameRemoteHostInput`: the label, trimmed, then bounded. A control
 * character is the registry's to refuse (`bad-name`).
 */
export const renameHostInputSchema = z.strictObject({
  hostId,
  name: z.string().trim().min(1).max(REMOTE_HOST_NAME_MAX),
});

/* ── Outputs ────────────────────────────────────────────────────────────── */

const linkError = z.object({ code: z.string(), reason: z.string(), message: z.string() });
const attempt = z.number().int().nonnegative();
const closeCode = z.number().int().nullable();
const linkState = z.discriminatedUnion("status", [
  z.object({ status: z.literal("connecting"), attempt }),
  z.object({ status: z.literal("ready") }),
  z.object({
    status: z.literal("unreachable"),
    attempt,
    error: linkError,
    closeCode,
    retryAt: z.number(),
  }),
  z.object({ status: z.literal("refused"), error: linkError, closeCode }),
  z.object({ status: z.literal("fenced"), error: linkError }),
  z.object({ status: z.literal("closed") }),
]);
const remoteHost = z.object({
  id: z.string(),
  name: z.string(),
  target: z.string(),
  transport: z.literal("ssh-tunnel"),
  os: z.enum(["linux", "macos"]).nullable(),
  mode: z.enum(["system", "user"]),
  agentsShareAccount: z.boolean(),
  version: z.string().nullable(),
  availableUpdate: z.string().nullable(),
  hostIsNewer: z.boolean(),
  deviceId: z.string(),
  addedAt: z.string(),
  liveSessions: z.number().int().nonnegative().nullable(),
  system: z.string().nullable(),
  arch: z.string().nullable(),
  hostKeys: z.array(z.string()).readonly(),
});
const remoteProjectLink = z.object({ hostId: z.string(), link: linkState });
/** `RemoteHostsSnapshot`. Its arrays are read-only, as the registry hands them over. */
export const remoteHostsSnapshotSchema = z.object({
  v: z.literal(1),
  hosts: z.array(remoteHost).readonly(),
  /** Project id → its host and that project's own Workspace link (VC-670). */
  projects: z.record(z.string(), remoteProjectLink),
  /** Why this Mac's hosts cannot change now, or `null`. */
  readOnly: z.string().nullable(),
});

/** A device's text field: bounded as the registry bounds what a host answers. */
const deviceText = z.string().max(REMOTE_HOST_DEVICE_TEXT_MAX);
const remoteHostDevice = z.strictObject({
  deviceId: deviceText,
  name: deviceText,
  fingerprint: deviceText,
  enrolledAt: deviceText,
  via: deviceText,
  revokedAt: deviceText.nullable(),
  thisMac: z.boolean(),
});
/** `RemoteHostDevices`: what `hosts.devices` answers, read from the host when asked. */
export const remoteHostDevicesSchema = z.strictObject({
  hostId: z.string(),
  devices: z.array(remoteHostDevice).max(REMOTE_HOST_DEVICES_MAX).readonly(),
});

/** A question's `kind` and `step`, and its own fields as open JSON. */
const addHostQuestion = z
  .object({ id: z.string(), kind: z.string(), step: stepId })
  .catchall(z.json());
const addHostFailure = z.object({
  code: z.string(),
  step: stepId,
  line: z.string(),
  recovery: z.discriminatedUnion("action", [
    z.object({ action: z.literal("retry"), label: z.string(), from: stepId }),
    z.object({ action: z.literal("back"), label: z.string() }),
  ]),
  detail: z.string().nullable(),
});
const addHostView = z.object({
  flowId: z.string(),
  target: z.string(),
  name: z.string(),
  status: z.enum(["running", "question", "failed", "done", "cancelled"]),
  steps: z.array(z.object({ id: stepId, status: z.enum(ADD_HOST_STEP_STATUSES) })),
  question: addHostQuestion.nullable(),
  failure: addHostFailure.nullable(),
  hostId: z.string().nullable(),
  startup: z.string().nullable(),
  facts: z.object({
    user: z.string().nullable(),
    os: z.enum(["linux", "macos"]).nullable(),
    system: z.string().nullable(),
    arch: z.string().nullable(),
    memoryBytes: z.number().nonnegative().nullable(),
    version: z.string().nullable(),
    keepsRunning: z.boolean().nullable(),
    alreadyPaired: z.boolean(),
  }),
});
const addHostLogLine = z.object({
  at: z.string(),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
  fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
/** `AddHostEvent`: what `hostAdd.subscribe` emits. */
export const addHostEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("replay"),
    view: addHostView,
    log: z.array(addHostLogLine).readonly(),
    omitted: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal("view"), view: addHostView }),
  z.object({ kind: z.literal("log"), flowId: z.string(), line: addHostLogLine }),
]);

/** Each output schema reads as its wire type: nothing it accepts is outside it. */
export type RemoteHostsOutputSchemasMatch = AssertNever<
  | (z.output<typeof remoteHostsSnapshotSchema> extends RemoteHostsSnapshot
      ? never
      : "remoteHostsSnapshotSchema")
  | (z.output<typeof addHostEventSchema> extends AddHostEvent ? never : "addHostEventSchema")
  | (z.output<typeof remoteHostDevicesSchema> extends RemoteHostDevices
      ? never
      : "remoteHostDevicesSchema")
>;

/** Each input schema yields its wire type. */
export type RemoteHostsInputSchemasMatch = AssertNever<
  z.output<typeof renameHostInputSchema> extends RenameRemoteHostInput
    ? never
    : "renameHostInputSchema"
>;

type MissingKeys<Wire, Schema> = Exclude<keyof Wire, keyof Schema>;

/** And nothing the wire carries is outside them: a field the wire gains fails here until described. */
export type RemoteHostsSchemaKeysCoverage = AssertNever<
  | MissingKeys<RemoteHostsSnapshot, z.output<typeof remoteHostsSnapshotSchema>>
  | MissingKeys<RemoteHost, z.output<typeof remoteHost>>
  | MissingKeys<RemoteProjectLink, z.output<typeof remoteProjectLink>>
  | MissingKeys<AddHostView, z.output<typeof addHostView>>
  | MissingKeys<AddHostFailure, z.output<typeof addHostFailure>>
  | MissingKeys<AddHostLogLine, z.output<typeof addHostLogLine>>
  | MissingKeys<RemoteHostDevices, z.output<typeof remoteHostDevicesSchema>>
  | MissingKeys<RemoteHostDevice, z.output<typeof remoteHostDevice>>
  | MissingKeys<RenameRemoteHostInput, z.output<typeof renameHostInputSchema>>
>;
