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
  MAX_ACTIVE_ADD_HOSTS,
  REMOTE_HOST_HEALTH_LIMITS,
  REMOTE_HOST_DEVICE_TEXT_MAX,
  REMOTE_HOST_DEVICES_MAX,
  REMOTE_HOST_NAME_MAX,
  REMOTE_HOST_PROJECT_TEXT_MAX,
  REMOTE_HOST_PROJECTS_MAX,
  REMOTE_PROJECT_FAILURE_TEXT_MAX,
  type ActiveAddHost,
  type AddHostEvent,
  type AddHostFacts,
  type AddHostFailure,
  type AddHostLogLine,
  type AddHostStepId,
  type AddHostStepStatus,
  type AddHostView,
  type CreateRemoteProjectInput,
  type CreateRemoteProjectResult,
  type RemoteHost,
  type RemoteHostDevice,
  type RemoteHostDevices,
  type RemoteHostProject,
  type RemoteHostProjects,
  type RemoteProjectFailure,
  type RemoteProjectLink,
  type RemoteWorkspaceInput,
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
/** A project link's granted features (VC-712): a welcome's own bounds, 256 of at most 128 characters. */
export const MAX_GRANTED_FEATURES = REMOTE_HOST_HEALTH_LIMITS.features;
export const MAX_GRANTED_FEATURE_LENGTH = REMOTE_HOST_HEALTH_LIMITS.feature;
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
/** `AddHostAnswer`: closed vocabulary, scoped by the named question. */
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
function linkStateWith(error: typeof linkError) {
  return z.discriminatedUnion("status", [
    z.object({ status: z.literal("connecting"), attempt }),
    z.object({ status: z.literal("ready") }),
    z.object({
      status: z.literal("unreachable"),
      attempt,
      error,
      closeCode,
      retryAt: z.number(),
    }),
    z.object({ status: z.literal("refused"), error, closeCode }),
    z.object({ status: z.literal("fenced"), error }),
    z.object({ status: z.literal("closed") }),
  ]);
}
const linkState = linkStateWith(linkError);
// Only the new host-health field is bounded: existing project-link errors stay compatible.
const healthLinkState = linkStateWith(
  z.object({
    code: z.string().max(REMOTE_HOST_HEALTH_LIMITS.errorCode),
    reason: z.string().max(REMOTE_HOST_HEALTH_LIMITS.errorReason),
    message: z.string().max(REMOTE_HOST_HEALTH_LIMITS.diagnostic),
  }),
);
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
  hostScope: z
    .object({
      status: z.enum(["connecting", "ready", "older", "unavailable"]),
      granted: z
        .array(z.string().max(MAX_GRANTED_FEATURE_LENGTH))
        .max(MAX_GRANTED_FEATURES)
        .readonly(),
    })
    .optional(),
  // Reuses the existing CLOSED link-state union; no new output enum.
  reachability: z
    .object({
      state: healthLinkState,
      everReady: z.boolean(),
      droppedAt: z.number().nullable(),
    })
    .optional(),
  lastWelcome: z
    .object({
      at: z.number(),
      hostId: z.string().max(REMOTE_HOST_HEALTH_LIMITS.hostId),
      version: z.string().max(REMOTE_HOST_HEALTH_LIMITS.version),
      protocol: z.number().int().positive(),
      features: z
        .array(z.string().max(MAX_GRANTED_FEATURE_LENGTH))
        .max(MAX_GRANTED_FEATURES)
        .readonly(),
    })
    .nullable()
    .optional(),
  signInExpiry: z
    .array(
      z.object({
        providerId: z.string().max(REMOTE_HOST_HEALTH_LIMITS.providerId),
        name: z.string().max(REMOTE_HOST_HEALTH_LIMITS.providerName),
        expiresAt: z.number().nullable(),
        expired: z.boolean(),
      }),
    )
    .max(REMOTE_HOST_HEALTH_LIMITS.signInExpiry)
    .readonly()
    .nullable()
    .optional(),
  lastSshFailure: z
    .object({
      code: z.string().max(REMOTE_HOST_HEALTH_LIMITS.sshCode),
      line: z.string().max(REMOTE_HOST_HEALTH_LIMITS.diagnostic),
    })
    .nullable()
    .optional(),
});
const remoteProjectLink = z.object({
  hostId: z.string(),
  link: linkState,
  // What the link's welcome granted, bounded as a welcome's features are.
  granted: z
    .array(z.string().max(MAX_GRANTED_FEATURE_LENGTH))
    .max(MAX_GRANTED_FEATURES)
    .readonly()
    .optional(),
});
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
});
/** `AddHostFacts`: what `hostAdd.facts` answers. A plain object, so it may gain fields. */
export const addHostFactsSchema = z.object({
  user: z.string().nullable(),
  os: z.enum(["linux", "macos"]).nullable(),
  system: z.string().nullable(),
  arch: z.string().nullable(),
  memoryBytes: z.number().nonnegative().nullable(),
  version: z.string().nullable(),
  keepsRunning: z.boolean().nullable(),
  alreadyPaired: z.boolean(),
});
/**
 * `ActiveAddHost` (VC-720): what `hostAdd.active` answers per flow — exactly
 * the four fields, nothing of the view, and the status closed to the three a
 * flow under way can hold (`done` and `cancelled` leave the list). A name
 * defaults to its target, so both take the target's bound; the ids are main's
 * own, bounded like every flow id here.
 */
export const activeAddHostSchema = z.strictObject({
  flowId: z.string().min(1).max(MAX_FLOW_ID_LENGTH),
  target: z.string().min(1).max(MAX_TARGET_LENGTH),
  name: z.string().min(1).max(MAX_TARGET_LENGTH),
  status: z.enum(["running", "question", "failed"]),
});
/** `hostAdd.active`: the bounded list of them, newest first. */
export const activeAddHostsSchema = z
  .array(activeAddHostSchema)
  .max(MAX_ACTIVE_ADD_HOSTS)
  .readonly();
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

/* ── A host's projects (VC-710) ─────────────────────────────────────────── */

/** The longest git URL the window may send; the engine judges what it clones. */
export const MAX_GIT_URL_LENGTH = 2048;

/**
 * `CreateRemoteProjectInput`: a folder on the host, or a git URL (and,
 * optionally, the folder to clone it into), and an optional name. Which of
 * them the host can use is the engine's to judge, in one line.
 */
export const createProjectInputSchema = z
  .strictObject({
    hostId,
    path: z.string().max(REMOTE_HOST_PROJECT_TEXT_MAX).optional(),
    gitUrl: z.string().max(MAX_GIT_URL_LENGTH).optional(),
    name: z.string().max(REMOTE_HOST_NAME_MAX).optional(),
    sudoPassword: z.string().min(1).max(MAX_SUDO_PASSWORD_LENGTH).optional(),
  })
  .refine((input) => input.path !== undefined || input.gitUrl !== undefined, {
    message: "A project needs a folder or a git URL.",
  });
/** `RemoteWorkspaceInput`: one of the host's projects, by its Workspace id. */
export const workspaceInputSchema = z.strictObject({ hostId, workspaceId: z.uuid() });

const projectText = z.string().max(REMOTE_HOST_PROJECT_TEXT_MAX);
const remoteHostProject = z.strictObject({
  id: projectText,
  name: projectText,
  prefix: projectText,
  path: projectText,
  tickets: z.number().int().nonnegative(),
});
/** `RemoteHostProjects`: what `hosts.projects` answers, read from the host when asked. */
/** A host's id as an output names it (a UUID): bounded, never trusted to be one. */
export const MAX_OUTPUT_HOST_ID_LENGTH = 128;
/** A failure's line, or a command to run on the host: bounded, as every output here. */
const failureText = z.string().max(REMOTE_PROJECT_FAILURE_TEXT_MAX);
export const remoteHostProjectsSchema = z.strictObject({
  hostId: z.string().max(MAX_OUTPUT_HOST_ID_LENGTH),
  projects: z.array(remoteHostProject).max(REMOTE_HOST_PROJECTS_MAX).readonly(),
  adds: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("ready") }),
    z.strictObject({ kind: z.literal("needs-operator"), command: failureText }),
    z.strictObject({ kind: z.literal("user-install") }),
  ]),
});
const remoteProjectFailure = z.strictObject({
  code: z.enum([
    "host-unreachable",
    "not-operator",
    "user-install",
    "hostd-unreachable",
    "refused",
    "bad-url",
    "destination-exists",
    "needs-password",
    "wrong-password",
    "needs-sudo",
    "needs-credential",
    "clone-failed",
    "unavailable",
  ]),
  message: failureText,
  command: failureText.nullable(),
});
/** `CreateRemoteProjectResult`: the project, or the one line (and command) that says why not. */
export const createProjectResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), created: z.boolean(), project: remoteHostProject }),
  z.strictObject({ ok: z.literal(false), failure: remoteProjectFailure }),
]);

/** Each output schema reads as its wire type: nothing it accepts is outside it. */
export type RemoteHostsOutputSchemasMatch = AssertNever<
  | (z.output<typeof remoteHostsSnapshotSchema> extends RemoteHostsSnapshot
      ? never
      : "remoteHostsSnapshotSchema")
  | (z.output<typeof addHostEventSchema> extends AddHostEvent ? never : "addHostEventSchema")
  | (z.output<typeof addHostFactsSchema> extends AddHostFacts ? never : "addHostFactsSchema")
  | (z.output<typeof activeAddHostsSchema> extends readonly ActiveAddHost[]
      ? never
      : "activeAddHostsSchema")
  | (z.output<typeof remoteHostDevicesSchema> extends RemoteHostDevices
      ? never
      : "remoteHostDevicesSchema")
  | (z.output<typeof remoteHostProjectsSchema> extends RemoteHostProjects
      ? never
      : "remoteHostProjectsSchema")
  | (z.output<typeof createProjectResultSchema> extends CreateRemoteProjectResult
      ? never
      : "createProjectResultSchema")
>;

/** Each input schema yields its wire type. */
export type RemoteHostsInputSchemasMatch = AssertNever<
  | (z.output<typeof renameHostInputSchema> extends RenameRemoteHostInput
      ? never
      : "renameHostInputSchema")
  | (z.output<typeof createProjectInputSchema> extends CreateRemoteProjectInput
      ? never
      : "createProjectInputSchema")
  | (z.output<typeof workspaceInputSchema> extends RemoteWorkspaceInput
      ? never
      : "workspaceInputSchema")
>;

type MissingKeys<Wire, Schema> = Exclude<keyof Wire, keyof Schema>;

/** And nothing the wire carries is outside them: a field the wire gains fails here until described. */
export type RemoteHostsSchemaKeysCoverage = AssertNever<
  | MissingKeys<RemoteHostsSnapshot, z.output<typeof remoteHostsSnapshotSchema>>
  | MissingKeys<RemoteHost, z.output<typeof remoteHost>>
  | MissingKeys<RemoteProjectLink, z.output<typeof remoteProjectLink>>
  | MissingKeys<AddHostView, z.output<typeof addHostView>>
  | MissingKeys<AddHostFacts, z.output<typeof addHostFactsSchema>>
  | MissingKeys<ActiveAddHost, z.output<typeof activeAddHostSchema>>
  | MissingKeys<AddHostFailure, z.output<typeof addHostFailure>>
  | MissingKeys<AddHostLogLine, z.output<typeof addHostLogLine>>
  | MissingKeys<RemoteHostDevices, z.output<typeof remoteHostDevicesSchema>>
  | MissingKeys<RemoteHostDevice, z.output<typeof remoteHostDevice>>
  | MissingKeys<RenameRemoteHostInput, z.output<typeof renameHostInputSchema>>
  | MissingKeys<RemoteHostProjects, z.output<typeof remoteHostProjectsSchema>>
  | MissingKeys<RemoteHostProject, z.output<typeof remoteHostProject>>
  | MissingKeys<RemoteProjectFailure, z.output<typeof remoteProjectFailure>>
  | MissingKeys<CreateRemoteProjectInput, z.output<typeof createProjectInputSchema>>
  | MissingKeys<RemoteWorkspaceInput, z.output<typeof workspaceInputSchema>>
>;
