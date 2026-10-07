/**
 * The client's half of the handshake (HP § Handshake and capabilities): what
 * a client checks in the welcome before it trusts the connection with a call
 * or a resubscribe. A host's word is never enough; the client holds the hello
 * it sent and judges the answer against it.
 */
import { isHostActor, isHostScopeActor } from "./actor";
import { HOST_SCOPE_FEATURES } from "./features";
import { hostError, type HostError } from "./errors";
import {
  checkWorkspaceFence,
  isHostFeature,
  type HostConnectionHello,
  type HostConnectionWelcome,
  type HostHello,
  type HostScopeHello,
  type HostScopeWelcome,
  type HostWelcome,
  type HostWelcomeProof,
} from "./handshake";
import { isEpoch, isUuidV4 } from "./identity";

const MAX_FEATURES = 256;
const MAX_HOST_VERSION_LENGTH = 128;

/** What {@link validateWelcome} answers: the welcome to record, or why not. */
export type WelcomeValidation<Welcome = HostWelcome> =
  | { readonly ok: true; readonly welcome: Welcome }
  | { readonly ok: false; readonly error: HostError };

export interface ValidateWelcomeOptions<Welcome = HostWelcome, Hello = HostHello> {
  /**
   * Checks the welcome's host-key proof against the key the client pinned for
   * `welcome.host.id` at pairing, over the hello's nonce (HI § Keys). VC-575
   * fills it. Absent, the reserved `proof` is not judged: v1 hosts send `null`
   * until VC-575 signs it.
   */
  readonly verifyProof?: (welcome: Welcome, hello: Hello) => HostError | null;
}

/**
 * Judges a welcome against the hello this client sent, in HP's order: shape,
 * selected version, requested Workspace, actor Workspace, granted ⊆
 * requested, the host-key proof, and only then the authority fence. A client
 * calls it on every connect and reconnect, before any call or resubscribe;
 * `ok: false` means close the connection and use nothing from it.
 */
export function validateWelcome(
  welcome: unknown,
  hello: HostHello,
  options?: ValidateWelcomeOptions,
): WelcomeValidation;
export function validateWelcome(
  welcome: unknown,
  hello: HostScopeHello,
  options?: ValidateWelcomeOptions<HostScopeWelcome, HostScopeHello>,
): WelcomeValidation<HostScopeWelcome>;
export function validateWelcome(
  welcome: unknown,
  hello: HostConnectionHello,
  options?: ValidateWelcomeOptions<HostConnectionWelcome, HostConnectionHello>,
): WelcomeValidation<HostConnectionWelcome>;
export function validateWelcome(
  welcome: unknown,
  hello: HostConnectionHello,
  options:
    | ValidateWelcomeOptions
    | ValidateWelcomeOptions<HostScopeWelcome, HostScopeHello>
    | ValidateWelcomeOptions<HostConnectionWelcome, HostConnectionHello> = {},
): WelcomeValidation<HostConnectionWelcome> {
  if (!isHostConnectionWelcome(welcome)) {
    return refuse("welcome-invalid", "The host's welcome is malformed");
  }
  const { min, max } = hello.protocol;
  if (welcome.protocolVersion < min || welcome.protocolVersion > max) {
    return refuse(
      "protocol-version-unsupported",
      `The host selected protocol ${welcome.protocolVersion}, outside the ${min}–${max} this client asked for`,
    );
  }
  const hostScope = "scope" in hello;
  if (hostScope !== "scope" in welcome) {
    return refuse("welcome-invalid", "The host's welcome has another connection scope");
  }
  if (
    !("scope" in hello) &&
    !("scope" in welcome) &&
    (welcome.workspace.id !== hello.workspaceId || welcome.actor.workspaceId !== hello.workspaceId)
  ) {
    return refuse("workspace-unknown", "The host welcomed this client to another Workspace");
  }
  const requested = new Set(hello.features);
  if (
    welcome.features.some((feature) => !requested.has(feature)) ||
    new Set(welcome.features).size !== welcome.features.length
  ) {
    return refuse("welcome-invalid", "The host granted a feature this client did not ask for");
  }
  if ("scope" in hello && "scope" in welcome) {
    const proof =
      (options as ValidateWelcomeOptions<HostScopeWelcome, HostScopeHello>).verifyProof?.(
        welcome,
        hello,
      ) ?? null;
    return proof === null ? { ok: true, welcome } : { ok: false, error: proof };
  }
  // Both shapes were checked above; this keeps the existing Workspace hook typed narrowly.
  const workspaceHello = hello as HostHello;
  const workspaceWelcome = welcome as HostWelcome;
  const proof =
    (options as ValidateWelcomeOptions).verifyProof?.(workspaceWelcome, workspaceHello) ?? null;
  if (proof !== null) return { ok: false, error: proof };
  const fence = checkWorkspaceFence(workspaceHello.lastSeen, {
    epoch: workspaceWelcome.workspace.epoch,
    hostId: welcome.host.id,
  });
  return fence === null ? { ok: true, welcome } : { ok: false, error: fence };
}

/** Grammar only, never trust: {@link validateWelcome} judges it against the hello. */
export function isHostConnectionWelcome(value: unknown): value is HostConnectionWelcome {
  return isHostScopeWelcome(value) || isHostWelcome(value);
}

export function isHostScopeWelcome(value: unknown): value is HostScopeWelcome {
  return (
    isRecord(value) &&
    value.scope === "host" &&
    !("workspace" in value) &&
    !("workspaceId" in value) &&
    !("lastSeen" in value) &&
    isHostScopeActor(value.actor) &&
    isWelcomeFields(value) &&
    (value.features as string[]).every((feature) =>
      (HOST_SCOPE_FEATURES as readonly string[]).includes(feature),
    )
  );
}

export function isHostWelcome(value: unknown): value is HostWelcome {
  return (
    isRecord(value) &&
    !("scope" in value) &&
    isRecord(value.workspace) &&
    isUuidV4(value.workspace.id) &&
    isEpoch(value.workspace.epoch) &&
    isHostActor(value.actor) &&
    isWelcomeFields(value)
  );
}

function isWelcomeFields(value: Record<string, unknown>): boolean {
  if (!isRecord(value.host)) return false;
  return (
    typeof value.protocolVersion === "number" &&
    Number.isSafeInteger(value.protocolVersion) &&
    value.protocolVersion > 0 &&
    isUuidV4(value.host.id) &&
    typeof value.host.version === "string" &&
    value.host.version.length <= MAX_HOST_VERSION_LENGTH &&
    Array.isArray(value.features) &&
    value.features.length <= MAX_FEATURES &&
    value.features.every(isHostFeature) &&
    (value.proof === null || isHostWelcomeProof(value.proof))
  );
}

function isHostWelcomeProof(value: unknown): value is HostWelcomeProof {
  return isRecord(value) && typeof value.scheme === "string" && typeof value.value === "string";
}

function refuse(
  reason: Parameters<typeof hostError>[0],
  message: string,
): { readonly ok: false; readonly error: HostError } {
  return { ok: false, error: hostError(reason, message) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
