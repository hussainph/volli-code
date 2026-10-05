/**
 * The typed credential families one host's sealed inventory holds (VC-642;
 * `docs/plans/sealed-credential-store.md` §3).
 *
 * A record is one family, a selector naming its owner or scope, and a value.
 * The selector is a fixed set of string fields per family, so a caller
 * cannot invent a namespace, and a Session cannot name a host-only record.
 * Values are a string, or for `mcp` and `pi-provider` the whole JSON record
 * their protocol owns (MCP's OAuth state, Pi's tagged `Credential` with its
 * provider-defined fields), kept as given.
 *
 * Only `session-env` ever reaches a shell environment; every other family is
 * read by the host service that owns it. VC-623's operator verifier and a
 * user's own Pi `auth.json` are deliberately not families here (owner
 * decision 4): the verifier's integrity comes from a root-owned file a
 * service-writable store cannot give, and `auth.json` is the user's.
 *
 * Today no family is sealed in this inventory: persistent Session secrets
 * stay in their legacy file (`store.ts`) until their import, and web, MCP and
 * Pi move in with their own tickets and compatibility gates (VC-643 to
 * VC-646). The families are fixed here so each cutover is additive.
 */
import { isSecretName } from "./store";

export type CredentialFamily =
  /** A person's Project or Always Session secret: an environment variable. */
  | "session-env"
  /** A web search provider's API key. */
  | "web-search"
  /** One MCP server's stored values and OAuth record, bound to its endpoint. */
  | "mcp"
  /** One model provider's Pi credential: an API key or an OAuth grant. */
  | "pi-provider"
  /** This host's own private key material (M2 pairing). */
  | "host-private"
  /** A paired device's verifier, bound to the host, workspace and device. */
  | "device-verifier"
  /** A worker's verifier, bound to the host, workspace and worker. */
  | "worker-verifier";

/** Every family, in a stable order. */
export const CREDENTIAL_FAMILIES: readonly CredentialFamily[] = [
  "session-env",
  "web-search",
  "mcp",
  "pi-provider",
  "host-private",
  "device-verifier",
  "worker-verifier",
];

/** A JSON object value: MCP's and Pi's records, kept whole. */
export type CredentialObject = { readonly [field: string]: unknown };

interface FamilyShape {
  /** Selector fields every record names. */
  readonly required: readonly string[];
  /** Selector fields a record may name. */
  readonly optional: readonly string[];
  readonly value: "string" | "object";
  /** Family rules beyond the shape. */
  readonly check?: (selector: Readonly<Record<string, string>>) => boolean;
}

const SHAPES: Readonly<Record<CredentialFamily, FamilyShape>> = {
  "session-env": {
    required: ["scope", "name"],
    optional: ["projectId"],
    value: "string",
    // Session scope is memory only; Project names its project, Always none.
    check: (selector) =>
      isSecretName(selector["name"]) &&
      (selector["scope"] === "project"
        ? selector["projectId"] !== undefined
        : selector["scope"] === "always" && selector["projectId"] === undefined),
  },
  "web-search": { required: ["provider"], optional: [], value: "string" },
  mcp: { required: ["serverId", "endpoint"], optional: [], value: "object" },
  "pi-provider": { required: ["provider"], optional: [], value: "object" },
  "host-private": { required: ["purpose"], optional: [], value: "string" },
  "device-verifier": {
    required: ["hostId", "workspaceId", "deviceId"],
    optional: [],
    value: "string",
  },
  "worker-verifier": {
    required: ["hostId", "workspaceId", "workerId"],
    optional: [],
    value: "string",
  },
};

/** The selector fields for one family. */
export type CredentialSelector = Readonly<Record<string, string>>;

/** A family's value: a string, or a whole JSON object for `mcp` and `pi-provider`. */
export type CredentialValue = string | CredentialObject;

export function isCredentialFamily(value: unknown): value is CredentialFamily {
  return typeof value === "string" && Object.hasOwn(SHAPES, value);
}

function field(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0")
  );
}

/** Whether `selector` is exactly a valid selector for `family`. */
export function validSelector(family: CredentialFamily, selector: unknown): boolean {
  if (selector === null || typeof selector !== "object" || Array.isArray(selector)) return false;
  const shape = SHAPES[family];
  const fields = Object.entries(selector as Record<string, unknown>);
  return (
    shape.required.every((name) => Object.hasOwn(selector, name)) &&
    fields.every(
      ([name, value]) =>
        (shape.required.includes(name) || shape.optional.includes(name)) && field(value),
    ) &&
    (shape.check?.(selector as CredentialSelector) ?? true)
  );
}

/** Whether `value` is a valid value for `family`. */
export function validValue(family: CredentialFamily, value: unknown): value is CredentialValue {
  if (SHAPES[family].value === "string") {
    return typeof value === "string" && value.length > 0 && !value.includes("\0");
  }
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A selector's identity: its fields in a fixed order. */
export function selectorKey(family: CredentialFamily, selector: CredentialSelector): string {
  const shape = SHAPES[family];
  return JSON.stringify([
    family,
    ...[...shape.required, ...shape.optional].map((name) => selector[name] ?? null),
  ]);
}
