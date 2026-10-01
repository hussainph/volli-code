/**
 * Credentials for MCP servers, as configuration can name them (VC-470).
 *
 * THE ONE RULE. Configuration holds REFERENCES, never values. A server's
 * headers, its environment and its OAuth client secret are each spelled one of
 * two ways, and neither is the credential itself:
 *
 * - **`reference`** — a template naming environment variables, `Bearer
 *   ${GITHUB_TOKEN}`. Resolved against Volli's own environment when the server
 *   is connected, never before, and the resolved text goes to that server only.
 * - **`secret`** — a marker that a person typed the value into Settings. The
 *   value lives in main's credential file (user-only, outside the database and
 *   every backup), keyed by the server and the slot; configuration records only
 *   that one exists.
 *
 * There is deliberately no third, literal kind. A header value typed in plain
 * text would be stored in the project database and copied into every backup
 * bundle, and Volli cannot tell `X-Api-Version: 2` from `Authorization: sk-…`
 * any better than it can tell `?version=2` from `?token=…`. A value that is not
 * a credential still works as a `secret`; it simply lives where a credential
 * would.
 *
 * WHY NOT `!command`. Pi spells a third kind, a command whose output is the
 * value (`!op read …`, `!gh auth token`). Volli refuses it, and keeps the `!`
 * prefix reserved so a later decision can define it without a migration. A
 * remote server is otherwise a thing Volli never starts a process for — its
 * warning says so — and `!command` would turn an HTTP header into exactly that,
 * travelling with the configuration into backup bundles and, once VC-379
 * imports repository `mcp.json` files, arriving from a repository. The use it
 * serves, keeping the secret out of the configuration, is already served by a
 * stored secret, which runs nothing.
 *
 * WHO WRITES THESE. A person, in Settings. No agent verb has a field for any of
 * them: a reference names a variable in Volli's own environment, so an agent
 * able to write `${ANYTHING}` into a header could send any variable Volli holds
 * to an endpoint the agent chose. That rule is enforced by the verb schemas
 * (they carry no such field) and by `mcp/verbs.ts`, which never forwards one.
 *
 * Pure vocabulary and validation. Resolution, storage and transport belong to
 * Electron main.
 */

/** Most entries one server may carry in its headers or its environment. */
export const MCP_CREDENTIAL_ENTRY_MAX = 32;
/** Longest header or environment variable name accepted. */
export const MCP_CREDENTIAL_NAME_MAX_CHARS = 128;
/** Longest reference template accepted. */
export const MCP_CREDENTIAL_TEMPLATE_MAX_CHARS = 1_024;
/** Longest value a person may store as a secret. */
export const MCP_SECRET_VALUE_MAX_CHARS = 16 * 1_024;
/** Longest OAuth client id, scope list, or callback URL accepted. */
export const MCP_OAUTH_TEXT_MAX_CHARS = 2_048;

/** How one credential slot is spelled in configuration. Never the value. */
export type McpCredentialSource = { kind: "reference"; template: string } | { kind: "secret" };

/** One header (remote server) or one environment variable (local server). */
export interface McpCredentialEntry {
  name: string;
  source: McpCredentialSource;
}

/**
 * A pre-registered OAuth client, for authorization servers without dynamic
 * client registration, plus the scope override every OAuth server may use.
 *
 * Every field is optional. `clientId` alone selects a pre-registered client;
 * `clientSecret` needs one. `callbackPort` pins the loopback redirect to
 * `http://127.0.0.1:<port>/callback`, and `callbackUrl` names a whole loopback
 * redirect URI for a client registered with a different one. `scope` replaces
 * the scopes the server advertises.
 */
export interface McpOAuthClientConfig {
  clientId?: string;
  clientSecret?: McpCredentialSource;
  callbackPort?: number;
  callbackUrl?: string;
  scope?: string;
}

/** Which family of slots an entry belongs to; also the prefix of its slot key. */
export type McpCredentialFamily = "env" | "header";

/** The slot an OAuth client secret is stored under. */
export const MCP_OAUTH_CLIENT_SECRET_SLOT = "oauth:client-secret";

/**
 * Where one secret is filed, within one server's credentials.
 *
 * Header names compare case-insensitively on the wire, so a header slot is
 * filed under its lowercase name: `Authorization` and `authorization` are one
 * slot, which is also why a server may not carry both.
 */
export function mcpCredentialSlot(family: McpCredentialFamily, name: string): string {
  return family === "header" ? `header:${name.toLowerCase()}` : `env:${name}`;
}

/** How a slot reads in a sentence a person or a model sees: `header Authorization`. */
export function mcpCredentialSlotLabel(slot: string): string {
  if (slot === MCP_OAUTH_CLIENT_SECRET_SLOT) return "OAuth client secret";
  const separator = slot.indexOf(":");
  return `${slot.slice(0, separator)} ${slot.slice(separator + 1)}`;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const CONTROL = /\p{Cc}/u;

/**
 * Headers a person may not set, because the transport owns them.
 *
 * Every one of these is either written by the Streamable HTTP transport itself
 * (session, protocol version, resumption, content negotiation) or by `fetch`
 * (framing), and a configured value would silently break the connection or
 * the framing rather than authenticate anything.
 */
const RESERVED_HEADERS = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "host",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "transfer-encoding",
]);

export type McpTemplateCheck =
  | { ok: true; names: readonly string[] }
  | { ok: false; reason: string };

/**
 * Check one reference template and name the variables it reads.
 *
 * A template is literal text around one or more `${NAME}` references. Every
 * `${` must open a well-formed reference, so a typo cannot quietly become
 * literal text sent as a credential, and a template with no reference at all is
 * refused: it would be a plain value stored where only references belong.
 */
export function checkMcpCredentialTemplate(template: unknown): McpTemplateCheck {
  if (typeof template !== "string" || template.length === 0) {
    return { ok: false, reason: "a reference must name an environment variable, as ${NAME}" };
  }
  if (template.length > MCP_CREDENTIAL_TEMPLATE_MAX_CHARS) {
    return { ok: false, reason: "a reference is too long" };
  }
  if (template.startsWith("!")) {
    return {
      ok: false,
      reason:
        "Volli does not run commands to produce credentials; use ${NAME} or store the value as a secret",
    };
  }
  if (CONTROL.test(template))
    return { ok: false, reason: "a reference contains a control character" };
  const names = [...template.matchAll(REFERENCE)].map((match) => match[1]!);
  const opened = template.split("${").length - 1;
  if (opened !== names.length) {
    return { ok: false, reason: "every ${ in a reference must be a ${NAME} reference" };
  }
  if (names.length === 0) {
    return {
      ok: false,
      reason:
        "a reference must name an environment variable, as ${NAME}; store a plain value as a secret instead",
    };
  }
  return { ok: true, names: [...new Set(names)] };
}

export type McpTemplateResolution =
  | { ok: true; value: string }
  | { ok: false; missing: readonly string[] };

/**
 * Substitute a checked template's references.
 *
 * `lookup` answers for one variable. A variable it does not know — or knows as
 * the empty string, which is how an unset variable usually reads after a shell
 * exported it blank — is reported by NAME, never guessed at: sending a header
 * of `Bearer ` is a request the server rejects for a reason nobody can see.
 */
export function resolveMcpCredentialTemplate(
  template: string,
  lookup: (name: string) => string | undefined,
): McpTemplateResolution {
  const missing = new Set<string>();
  const value = template.replace(REFERENCE, (_match, name: string) => {
    const found = lookup(name);
    if (found === undefined || found.length === 0) {
      missing.add(name);
      return "";
    }
    return found;
  });
  return missing.size === 0 ? { ok: true, value } : { ok: false, missing: [...missing] };
}

/**
 * Why a resolved value cannot be sent, or `null` when it can.
 *
 * Checked after resolution because the value is not known before it. A header
 * value carrying a line break would let one variable smuggle a second header
 * into the request, and NUL cannot cross a process environment. The reason
 * never quotes the value.
 */
export function mcpCredentialValueProblem(
  family: McpCredentialFamily,
  value: string,
): string | null {
  if (value.length > MCP_SECRET_VALUE_MAX_CHARS) return "the value is too long";
  if (value.includes("\u0000")) return "the value contains a NUL character";
  if (family === "header" && /[\r\n]/.test(value))
    return "a header value cannot contain a line break";
  return null;
}

function sanitizeSource(
  raw: unknown,
): { ok: true; source: McpCredentialSource } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "a credential must be a reference or a stored secret" };
  }
  const source = raw as Record<string, unknown>;
  if (source["kind"] === "secret") return { ok: true, source: { kind: "secret" } };
  if (source["kind"] !== "reference") {
    return { ok: false, reason: "a credential must be a reference or a stored secret" };
  }
  const checked = checkMcpCredentialTemplate(source["template"]);
  return checked.ok
    ? { ok: true, source: { kind: "reference", template: source["template"] as string } }
    : checked;
}

export type McpCredentialEntriesSanitization =
  | { ok: true; entries: readonly McpCredentialEntry[] }
  | { ok: false; reason: string };

/**
 * Validate a server's headers or environment as configuration states them.
 *
 * Absent reads as none. Names are checked against what the wire accepts — an
 * HTTP token for a header, a POSIX name for a variable — and duplicates are
 * refused rather than resolved by order, because "the second one wins" is a
 * rule a person reading the list would not guess.
 */
export function sanitizeMcpCredentialEntries(
  family: McpCredentialFamily,
  raw: unknown,
): McpCredentialEntriesSanitization {
  if (raw === undefined || raw === null) return { ok: true, entries: [] };
  const what = family === "header" ? "headers" : "environment";
  if (!Array.isArray(raw)) return { ok: false, reason: `${what} must be a list` };
  if (raw.length > MCP_CREDENTIAL_ENTRY_MAX) {
    return { ok: false, reason: `${what} may hold at most ${MCP_CREDENTIAL_ENTRY_MAX} entries` };
  }
  const seen = new Set<string>();
  const entries: McpCredentialEntry[] = [];
  for (const candidate of raw as unknown[]) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      return { ok: false, reason: `${what} entries must be objects` };
    }
    const row = candidate as Record<string, unknown>;
    const name = row["name"];
    const pattern = family === "header" ? HEADER_NAME : ENV_NAME;
    if (
      typeof name !== "string" ||
      name.length > MCP_CREDENTIAL_NAME_MAX_CHARS ||
      !pattern.test(name)
    ) {
      return {
        ok: false,
        reason:
          family === "header"
            ? "a header name must be a valid HTTP header name"
            : "an environment variable name must be letters, digits and underscores, not starting with a digit",
      };
    }
    if (family === "header" && RESERVED_HEADERS.has(name.toLowerCase())) {
      return {
        ok: false,
        reason: `the ${name} header is set by the transport and cannot be configured`,
      };
    }
    const slot = mcpCredentialSlot(family, name);
    if (seen.has(slot)) return { ok: false, reason: `${name} is listed twice` };
    seen.add(slot);
    const source = sanitizeSource(row["source"]);
    if (!source.ok) return { ok: false, reason: `${name}: ${source.reason}` };
    entries.push({ name, source: source.source });
  }
  return { ok: true, entries };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type McpOAuthClientSanitization =
  | { ok: true; oauth: McpOAuthClientConfig | undefined }
  | { ok: false; reason: string };

function optionalText(
  raw: unknown,
  label: string,
): { ok: true; value: string | undefined } | { ok: false; reason: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: undefined };
  if (typeof raw !== "string" || raw.length > MCP_OAUTH_TEXT_MAX_CHARS || CONTROL.test(raw)) {
    return { ok: false, reason: `the OAuth ${label} is invalid` };
  }
  const trimmed = raw.trim();
  return { ok: true, value: trimmed.length === 0 ? undefined : trimmed };
}

/**
 * Validate a remote server's OAuth client settings.
 *
 * The callback must be loopback `http`: RFC 8252's native-app redirect, the
 * only kind Volli can receive, and a redirect anywhere else would hand the
 * authorization code to whoever answers at that address. An empty object reads
 * as no settings at all, so it is dropped rather than stored.
 */
export function sanitizeMcpOAuthClient(raw: unknown): McpOAuthClientSanitization {
  if (raw === undefined || raw === null) return { ok: true, oauth: undefined };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "OAuth settings must be an object" };
  }
  const row = raw as Record<string, unknown>;
  const clientId = optionalText(row["clientId"], "client id");
  if (!clientId.ok) return clientId;
  const scope = optionalText(row["scope"], "scope");
  if (!scope.ok) return scope;
  const callbackUrl = optionalText(row["callbackUrl"], "callback URL");
  if (!callbackUrl.ok) return callbackUrl;
  const oauth: McpOAuthClientConfig = {};
  if (clientId.value !== undefined) oauth.clientId = clientId.value;
  if (row["clientSecret"] !== undefined && row["clientSecret"] !== null) {
    if (clientId.value === undefined) {
      return { ok: false, reason: "an OAuth client secret needs a client id" };
    }
    const secret = sanitizeSource(row["clientSecret"]);
    if (!secret.ok) return { ok: false, reason: `OAuth client secret: ${secret.reason}` };
    oauth.clientSecret = secret.source;
  }
  const port = row["callbackPort"];
  if (port !== undefined && port !== null) {
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
      return { ok: false, reason: "the OAuth callback port must be a port number" };
    }
    oauth.callbackPort = port;
  }
  if (callbackUrl.value !== undefined) {
    let url: URL;
    try {
      url = new URL(callbackUrl.value);
    } catch {
      return { ok: false, reason: "the OAuth callback URL is invalid" };
    }
    if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
      return {
        ok: false,
        reason: "the OAuth callback URL must be http on localhost, 127.0.0.1 or [::1]",
      };
    }
    if (url.search.length > 0 || url.hash.length > 0 || url.username.length > 0) {
      return {
        ok: false,
        reason: "the OAuth callback URL must be a plain loopback address and path",
      };
    }
    oauth.callbackUrl = callbackUrl.value;
  }
  if (scope.value !== undefined) oauth.scope = scope.value;
  return { ok: true, oauth: Object.keys(oauth).length === 0 ? undefined : oauth };
}

/**
 * Whether a remote server's connections may be signed in with OAuth.
 *
 * Pi's rule, kept: OAuth applies to a server that does not already carry an
 * `Authorization` header. A person who configured one has chosen that
 * credential, and an OAuth token would replace it on every request.
 */
export function mcpServerUsesOAuth(headers: readonly McpCredentialEntry[] | undefined): boolean {
  return !(headers ?? []).some((entry) => entry.name.toLowerCase() === "authorization");
}

/** Every slot a set of entries keeps as a stored secret. */
export function mcpSecretSlots(
  family: McpCredentialFamily,
  entries: readonly McpCredentialEntry[] | undefined,
): readonly string[] {
  return (entries ?? [])
    .filter((entry) => entry.source.kind === "secret")
    .map((entry) => mcpCredentialSlot(family, entry.name));
}

/**
 * Where a server stands on signing in, as Settings and `server_list` show it.
 *
 * - `not-applicable` — a local server, or a remote one carrying its own
 *   `Authorization` header: there is nothing to sign in to.
 * - `signed-out` — sign-in is possible and nothing is stored; the server has
 *   not (yet) refused a connection.
 * - `needs-sign-in` — the server refused a connection for want of
 *   authorization, or asked for more scope than was granted. A person must
 *   sign in.
 * - `signed-in` — tokens are stored and nothing has refused them since.
 */
export type McpSignInState = "not-applicable" | "signed-out" | "needs-sign-in" | "signed-in";

/** What can be said about one server's credentials without disclosing any. */
export interface McpServerAccess {
  signIn: McpSignInState;
  /** Slots a secret is configured for and none is stored, as their labels. */
  missingSecrets: readonly string[];
}

/**
 * What a blocked connection waits on, as a failure result carries it: a
 * person's sign-in, or a credential only a person can supply. `missing`
 * names slots (`header Authorization`, `${TOKEN} (for env API_KEY)`), never
 * values.
 */
export type McpConnectionBlock =
  | { kind: "sign-in"; insufficientScope: boolean }
  | { kind: "credential"; missing: readonly string[] };
