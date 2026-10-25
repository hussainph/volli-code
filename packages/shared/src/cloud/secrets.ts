/**
 * Team secrets (Volli Cloud): env vars and secrets set once at a Workspace, a
 * project or for one person, and injected into the processes a runner starts
 * for a Session, never into a transcript.
 *
 * - **Kinds.** An `env` var is plain and shown to whoever may read its scope.
 *   A `secret` is sealed in the backend and write-only after it is saved: no
 *   client read returns it; only the runner that holds a Session's claim
 *   receives it, in memory, and its value joins that runner's redaction set
 *   before any process can print it.
 * - **Exposure.** `setup` reaches only recipe scripts (`.agents/setup`,
 *   `.agents/resume`); `session` also reaches the agent's tool processes
 *   (execute, background shells, stdio MCP servers). See {@link exposureReaches}.
 * - **Precedence** (one name, several levels): personal-for-this-project >
 *   personal > project > workspace, and the runner's own environment last.
 *   The highest level that sets a name wins outright, and THEN its exposure
 *   applies: a personal override that is setup-only hides a project value from
 *   the Session rather than letting the value the person replaced show
 *   through. Resolved by the one config resolver (`config-resolution.ts`).
 * - **Who** (0.3): any active Member reads the names and metadata of the
 *   Workspace's and its projects' secrets; owners and admins write
 *   Workspace-level ones; any active Member writes project-level ones (every
 *   change audited); personal ones are the person's alone.
 *
 * Model API keys are not here: they are sealed to the model gateway and never
 * reach a runner. Subscriptions are never stored in the cloud at all.
 *
 * Pure: no Node/DOM imports.
 */

import { resolveConfigEntries, type ConfigPlan } from "../config-resolution";
import { isSecretName } from "../secret-name";
import type { JobId, ProjectId, SessionId, UserId, WorkspaceId } from "./ids";
import { isActiveMember, type MembershipFacts, type Viewer } from "./visibility";

/**
 * Names a team secret may not take, on top of {@link isSecretName}. A team
 * value reaches OTHER people's processes (a Member's project secret runs in an
 * admin's Sessions), so names that redirect traffic, trust or git's own
 * programs are refused here too: proxies (`*_PROXY`), certificate bundles, git's
 * repository/editor/diff hooks and a few interpreter and toolchain hooks.
 * Local secrets a person sets for themselves keep the narrower rule.
 */
const TEAM_CONTROL_NAMES = new Set([
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_EXTERNAL_DIFF",
  "PYTHONWARNINGS",
  "PYTHONBREAKPOINT",
  "BROWSER",
  "SUDO_ASKPASS",
  "PERL5DB",
  "CC",
  "CXX",
  "RUSTC_WRAPPER",
  "RUSTC",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "GOPATH",
  "GOROOT",
  "GOFLAGS",
  "GEM_HOME",
  "GEM_PATH",
  "BUNDLE_GEMFILE",
]);

/** Whether `name` may name a team secret: {@link isSecretName}, minus {@link TEAM_CONTROL_NAMES}. */
export function isTeamSecretName(name: unknown): name is string {
  return isSecretName(name) && !TEAM_CONTROL_NAMES.has(name) && !name.endsWith("_PROXY");
}

/** Where a secret is set. The same three levels as configuration. */
export const SECRET_SCOPES = ["personal", "project", "workspace"] as const;
export type SecretScopeLevel = (typeof SECRET_SCOPES)[number];

export const SECRET_KINDS = ["env", "secret"] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export const SECRET_EXPOSURES = ["setup", "session"] as const;
export type SecretExposure = (typeof SECRET_EXPOSURES)[number];

/** A new secret reaches the agent's tools unless the person narrows it. */
export const DEFAULT_SECRET_EXPOSURE: SecretExposure = "session";

/** What a runner is starting when it asks for a set: a recipe script, or a Session's tools. */
export const SECRET_PURPOSES = ["setup", "session"] as const;
export type SecretPurpose = (typeof SECRET_PURPOSES)[number];

/** Whether a secret of `exposure` reaches a process started for `purpose`. */
export function exposureReaches(exposure: SecretExposure, purpose: SecretPurpose): boolean {
  return purpose === "setup" || exposure === "session";
}

/** The one place a secret is set. */
export type SecretTarget =
  | { scope: "workspace"; workspaceId: WorkspaceId }
  | { scope: "project"; projectId: ProjectId }
  /** `projectId` set: personal, for this project only. */
  | { scope: "personal"; userId: UserId; projectId: ProjectId | null };

/**
 * The stored scope key: one string, one index prefix. Personal scope is keyed
 * by the person, not a membership, so it follows them into every Workspace
 * and survives project moves.
 */
export function secretScopeKey(target: SecretTarget): string {
  switch (target.scope) {
    case "workspace":
      return `w:${target.workspaceId}`;
    case "project":
      return `p:${target.projectId}`;
    case "personal":
      return target.projectId === null
        ? `u:${target.userId}`
        : `u:${target.userId}/p:${target.projectId}`;
  }
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SCOPE_KEY = new RegExp(`^(?:w:(${UUID})|p:(${UUID})|u:(${UUID})(?:/p:(${UUID}))?)$`);

/** The target a stored `(scope, scopeKey)` names, or `null` when the two disagree or the key is malformed. */
export function secretTargetOf(scope: SecretScopeLevel, scopeKey: string): SecretTarget | null {
  const match = SCOPE_KEY.exec(scopeKey);
  if (match === null) return null;
  const [, workspaceId, projectId, userId, personalProjectId] = match;
  if (scope === "workspace" && workspaceId !== undefined) {
    return { scope, workspaceId: workspaceId as WorkspaceId };
  }
  if (scope === "project" && projectId !== undefined) {
    return { scope, projectId: projectId as ProjectId };
  }
  if (scope === "personal" && userId !== undefined) {
    return {
      scope,
      userId: userId as UserId,
      projectId: (personalProjectId ?? null) as ProjectId | null,
    };
  }
  return null;
}

/** The four levels a resolved set reads, highest first. */
export const SECRET_LAYERS = ["personal_project", "personal", "project", "workspace"] as const;
export type SecretLayer = (typeof SECRET_LAYERS)[number];

const SECRET_LAYER_PLAN: ConfigPlan<"union", SecretLayer> = {
  merge: "union",
  order: SECRET_LAYERS,
};

export function secretLayer(target: SecretTarget): SecretLayer {
  if (target.scope !== "personal") return target.scope;
  return target.projectId === null ? "personal" : "personal_project";
}

/** What the resolver reads of a stored secret. */
export interface SecretCandidate {
  readonly name: string;
  readonly layer: SecretLayer;
  readonly exposure: SecretExposure;
}

/** The winning candidate for each name: the highest layer that sets it. Sorted by name. */
export function secretWinners<T extends SecretCandidate>(candidates: readonly T[]): T[] {
  const layers: Partial<Record<SecretLayer, T[]>> = {};
  for (const candidate of candidates) (layers[candidate.layer] ??= []).push(candidate);
  return (
    resolveConfigEntries(SECRET_LAYER_PLAN, layers, (candidate) => candidate.name)
      .map((entry) => entry.value)
      // Names are unique here, so no two compare equal.
      .toSorted((a, b) => (a.name < b.name ? -1 : 1))
  );
}

/**
 * The set a process started for `purpose` receives: each name's winner (see
 * {@link secretWinners}), kept only when its exposure reaches `purpose`.
 */
export function resolveSecretSet<T extends SecretCandidate>(
  candidates: readonly T[],
  purpose: SecretPurpose,
): T[] {
  return secretWinners(candidates).filter((winner) => exposureReaches(winner.exposure, purpose));
}

// ── who may read and write ─────────────────────────────────────────────────

/**
 * Whether the viewer may read the names and metadata of `target`'s secrets.
 * `membership` is the viewer's membership of the Workspace the target belongs
 * to (a project's CURRENT Workspace), or `null` for a personal target with no
 * project.
 */
export function canReadSecrets(
  viewer: Viewer,
  target: SecretTarget,
  workspaceId: WorkspaceId | null,
  membership: MembershipFacts | null,
): boolean {
  if (target.scope === "personal") {
    if (target.userId !== viewer.userId) return false;
    if (target.projectId === null) return true;
  }
  return workspaceId !== null && isActiveMember(viewer, workspaceId, membership);
}

/** Whether the viewer may set, change or remove `target`'s secrets. See {@link canReadSecrets}. */
export function canWriteSecrets(
  viewer: Viewer,
  target: SecretTarget,
  workspaceId: WorkspaceId | null,
  membership: MembershipFacts | null,
): boolean {
  if (!canReadSecrets(viewer, target, workspaceId, membership)) return false;
  if (target.scope !== "workspace") return true;
  // Named, not "anything but member": a role added later grants nothing here by accident.
  const role = membership!.role;
  return role === "owner" || role === "admin";
}

// ── values ─────────────────────────────────────────────────────────────────

/** A value's ceiling, in UTF-8 bytes. Certificates and service-account JSON fit. */
export const MAX_SECRET_VALUE_BYTES = 32 * 1024;

/** At most this many secrets at one scope. */
export const MAX_SECRETS_PER_SCOPE = 100;

/**
 * At most this many UTF-8 bytes of names and values at one scope. Four
 * levels resolve into one set, so a set stays under four times this, well
 * inside a process's argument-plus-environment limit (1 MiB on macOS).
 */
export const MAX_SCOPE_BYTES = 64 * 1024;

/** A resolved set's ceiling: {@link MAX_SCOPE_BYTES} from each of the four levels. */
export const MAX_SECRET_SET_BYTES = 4 * MAX_SCOPE_BYTES;

/** What a secret costs against {@link MAX_SCOPE_BYTES}: its name, `=` and value. */
export function secretBytes(name: string, value: string): number {
  return new TextEncoder().encode(`${name}=${value}`).byteLength;
}

/** Why `value` cannot be stored, or `null`. Never echoes the value. */
export function secretValueProblem(value: string): string | null {
  if (value.length === 0) return "A value cannot be empty.";
  if (value.includes("\0")) return "A value cannot contain a NUL character.";
  if (new TextEncoder().encode(value).byteLength > MAX_SECRET_VALUE_BYTES) {
    return `A value is at most ${MAX_SECRET_VALUE_BYTES / 1024} KiB.`;
  }
  return null;
}

/** Below this many characters a secret shows no tail: four of them would say too much. */
const LAST4_MIN_LENGTH = 16;

/**
 * The tail a list may show for a sealed secret, so a person can tell which
 * key is set: its last four characters, for secrets long enough that four
 * give little away. `null` for env vars (their value is shown) and short secrets.
 */
export function secretLast4(kind: SecretKind, value: string): string | null {
  if (kind !== "secret") return null;
  const chars = Array.from(value);
  return chars.length < LAST4_MIN_LENGTH ? null : chars.slice(-4).join("");
}

// ── delivery to a runner ───────────────────────────────────────────────────

/** What a runner holds that entitles it to a set: a claimed Session, or a leased job. */
export type SecretClaim = { kind: "session"; sessionId: SessionId } | { kind: "job"; jobId: JobId };

/** Why a set came back empty although secrets exist: the runner's owner turned injection off. */
export const SECRET_WITHHELD_REASONS = ["runner_opt_out"] as const;
export type SecretWithheldReason = (typeof SECRET_WITHHELD_REASONS)[number];

export interface RunnerSecretEntry {
  readonly name: string;
  readonly kind: SecretKind;
  readonly value: string;
}

/**
 * The resolved set the backend hands a runner for one claim, over TLS. The
 * runner holds it in memory only, adds every value to its redaction set
 * before use, and injects it into the processes it starts for `purpose`.
 */
export interface RunnerSecretSet {
  readonly version: 1;
  readonly claim: SecretClaim;
  readonly purpose: SecretPurpose;
  readonly withheld: SecretWithheldReason | null;
  /** Sorted by name, one entry per name. */
  readonly entries: readonly RunnerSecretEntry[];
}

export const RUNNER_SECRET_SET_VERSION = 1;

export class RunnerSecretSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerSecretSetError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function oneOf<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function parseClaim(value: unknown): SecretClaim {
  if (isRecord(value)) {
    if (value["kind"] === "session" && typeof value["sessionId"] === "string") {
      return { kind: "session", sessionId: value["sessionId"] as SessionId };
    }
    if (value["kind"] === "job" && typeof value["jobId"] === "string") {
      return { kind: "job", jobId: value["jobId"] as JobId };
    }
  }
  throw new RunnerSecretSetError("A secret set names no claim.");
}

/**
 * The runner's boundary check on a delivered set: a newer version, a name that
 * could steer process startup, a malformed value or a repeated name is
 * refused whole, never partly injected. Errors never echo a value.
 */
export function parseRunnerSecretSet(value: unknown): RunnerSecretSet {
  if (!isRecord(value)) throw new RunnerSecretSetError("A secret set is an object.");
  if (value["version"] !== RUNNER_SECRET_SET_VERSION) {
    throw new RunnerSecretSetError("This secret set's version is not one this runner reads.");
  }
  const claim = parseClaim(value["claim"]);
  if (!oneOf(SECRET_PURPOSES, value["purpose"])) {
    throw new RunnerSecretSetError("A secret set names no purpose.");
  }
  const withheld = value["withheld"];
  if (withheld !== null && !oneOf(SECRET_WITHHELD_REASONS, withheld)) {
    throw new RunnerSecretSetError("A secret set's withheld reason is unknown.");
  }
  const raw = value["entries"];
  if (!Array.isArray(raw)) throw new RunnerSecretSetError("A secret set's entries are a list.");
  const seen = new Set<string>();
  const entries = raw.map((entry: unknown): RunnerSecretEntry => {
    if (
      !isRecord(entry) ||
      !isTeamSecretName(entry["name"]) ||
      !oneOf(SECRET_KINDS, entry["kind"]) ||
      typeof entry["value"] !== "string" ||
      secretValueProblem(entry["value"]) !== null
    ) {
      throw new RunnerSecretSetError("A secret set holds a malformed entry.");
    }
    if (seen.has(entry["name"])) {
      throw new RunnerSecretSetError(`A secret set names ${entry["name"]} twice.`);
    }
    seen.add(entry["name"]);
    return { name: entry["name"], kind: entry["kind"], value: entry["value"] };
  });
  if (
    entries.reduce((sum, entry) => sum + secretBytes(entry.name, entry.value), 0) >
    MAX_SECRET_SET_BYTES
  ) {
    throw new RunnerSecretSetError("A secret set is larger than any set the backend resolves.");
  }
  if (withheld !== null && entries.length > 0) {
    throw new RunnerSecretSetError("A withheld secret set holds entries.");
  }
  return {
    version: RUNNER_SECRET_SET_VERSION,
    claim,
    purpose: value["purpose"],
    withheld,
    entries,
  };
}
