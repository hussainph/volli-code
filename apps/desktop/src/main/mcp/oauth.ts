/**
 * OAuth for remote MCP servers, on pi-mcp's client (VC-470).
 *
 * Two halves, and the split is the design.
 *
 * **Connections never sign in.** Every connection to an OAuth-capable server —
 * discovery, a refresh, a Session's tool call — carries
 * {@link McpOAuthBroker.connectionAuth}. It sends the stored access token,
 * refreshes it once when the server refuses it, and otherwise records that the
 * server needs a sign-in and fails with {@link McpSignInRequiredError}. It
 * never registers a client, never opens a browser, never writes a PKCE
 * verifier. A background Session's refused call therefore cannot start a
 * sign-in nobody asked for, nor clobber the one a person is halfway through.
 * Because the token is read from the store on every request, a Session that is
 * already running uses a token a person just obtained — or one another
 * connection just refreshed — on its very next request, with no reattachment
 * and no change to its frozen tool list.
 *
 * **Signing in is a person's act.** {@link McpOAuthBroker.signIn} runs only
 * because a person pressed *Sign in* in Settings, or answered *Allow* to a
 * `confirm.mcp-sign-in` question an agent's call raised. It listens on a
 * loopback port (`OAuthCallbackServer`), registers Volli with the
 * authorization server when it has to (dynamic client registration) or uses
 * the pre-registered client the person configured, opens the authorization
 * page in the browser with PKCE, exchanges the code, and checks the result by
 * connecting once. A server that asked for more scope (403
 * `insufficient_scope`) is signed in again for the union of what was granted
 * and what it asked for — step-up.
 *
 * What an agent learns from any of this is an outcome: signed in, declined,
 * still missing. Tokens stay in {@link McpCredentialStore}.
 */
import type { AuthProvider, McpFetch, UnauthorizedContext } from "@earendil-works/pi-mcp";
import {
  adaptOAuthProvider,
  authorizeMcp,
  discoverAuthorizationServerMetadata,
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  OAuthCallbackServer,
  OAuthError,
  OAuthInsecureEndpointError,
  OAuthIssuerMismatchError,
  OAuthRegistrationError,
  parseWwwAuthenticate,
  refreshAuthorization,
  selectResource,
  type McpOAuthState,
  type McpOAuthStateStore,
  type OAuthCallbackServerOptions,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from "@earendil-works/pi-mcp/oauth";
import {
  mcpServerUsesOAuth,
  type McpOAuthClientConfig,
  type McpServerDraft,
  type McpSignInState,
} from "@volli/shared";

import type {
  McpCredentialStore,
  McpSignInRequirement,
  McpStoredOAuthState,
} from "./credential-store";
import {
  connectionProblemIn,
  McpConnectionProblem,
  McpSignInRequiredError,
  resolveMcpOAuthClientSecret,
  type McpCredentialSources,
} from "./credentials";

/** The client name Volli registers under, and the one a consent screen shows. */
export const MCP_OAUTH_CLIENT_NAME = "Volli Code";

/** How long a sign-in waits for the browser to come back. */
export const MCP_SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** A remote server, as the OAuth half needs to see it. */
export interface McpOAuthServer {
  id: string;
  name: string;
  url: string;
  oauth?: McpOAuthClientConfig;
}

/** The OAuth view of a configured server, or `null` when it cannot sign in. */
export function mcpOAuthServer(server: McpServerDraft): McpOAuthServer | null {
  const transport = server.transport;
  if (transport.type !== "streamable-http" || !mcpServerUsesOAuth(transport.headers)) return null;
  return {
    id: server.id,
    name: server.name,
    url: transport.url,
    ...(transport.oauth === undefined ? {} : { oauth: transport.oauth }),
  };
}

/** How a sign-in ended, in words a person and an agent can both be given. */
export type McpSignInOutcome =
  | { ok: true; message: string }
  | { ok: false; cancelled: boolean; message: string };

/**
 * One server's OAuth state as pi-mcp's provider persists it.
 *
 * The durable fields go to the credential file; the PKCE verifier and the
 * `state` parameter stay in `ephemeral`, which belongs to exactly one sign-in.
 */
function oauthStateStore(
  store: McpCredentialStore,
  serverId: string,
  ephemeral: { serverUrl?: string; codeVerifier?: string; oauthState?: string },
): McpOAuthStateStore {
  return {
    load(): McpOAuthState | undefined {
      const durable = store.read(serverId)?.oauth;
      const serverUrl = ephemeral.serverUrl ?? durable?.serverUrl;
      if (serverUrl === undefined) return undefined;
      const base = durable?.serverUrl === serverUrl ? durable : { serverUrl };
      return {
        ...(base as McpOAuthState),
        ...(ephemeral.codeVerifier === undefined ? {} : { codeVerifier: ephemeral.codeVerifier }),
        ...(ephemeral.oauthState === undefined ? {} : { oauthState: ephemeral.oauthState }),
      };
    },
    save(state: McpOAuthState): void {
      const { codeVerifier, oauthState, ...durable } = state;
      ephemeral.serverUrl = state.serverUrl;
      if (codeVerifier === undefined) delete ephemeral.codeVerifier;
      else ephemeral.codeVerifier = codeVerifier;
      if (oauthState === undefined) delete ephemeral.oauthState;
      else ephemeral.oauthState = oauthState;
      store.update(serverId, (current) => ({
        ...current,
        oauth: durable as McpStoredOAuthState,
      }));
    },
  };
}

function scopeSet(...scopes: readonly (string | undefined)[]): string | undefined {
  const all = new Set(scopes.flatMap((scope) => (scope ?? "").split(/\s+/).filter(Boolean)));
  return all.size === 0 ? undefined : [...all].join(" ");
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Where the loopback redirect listens, from the person's OAuth settings. */
export function mcpOAuthCallbackOptions(
  config: McpOAuthClientConfig | undefined,
  timeoutMs: number = MCP_SIGN_IN_TIMEOUT_MS,
): OAuthCallbackServerOptions {
  if (config?.callbackUrl !== undefined) {
    const url = new URL(config.callbackUrl);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    return {
      host: hostname === "localhost" ? "127.0.0.1" : hostname,
      redirectHost: hostname,
      port: url.port === "" ? (config.callbackPort ?? 0) : Number(url.port),
      path: url.pathname,
      timeoutMs,
    };
  }
  return { host: "127.0.0.1", port: config?.callbackPort ?? 0, path: "/callback", timeoutMs };
}

/**
 * Why a sign-in did not complete, written by Volli.
 *
 * An authorization server's `error_description` is third-party prose and is
 * not repeated; the OAuth error CODE is a fixed vocabulary and is.
 */
function signInFailure(serverName: string, error: unknown): string {
  const problem = connectionProblemIn(error);
  if (problem instanceof McpSignInRequiredError) {
    return `${serverName} still refused the connection after the sign-in. Try signing in again, or check that the account has access.`;
  }
  if (problem !== null) return problem.message;
  if (
    error instanceof OAuthRegistrationError ||
    (error instanceof Error && /dynamic client registration/i.test(error.message))
  ) {
    return `${serverName}'s authorization server would not register Volli as a client. If it needs a pre-registered client, add its client id under OAuth in Settings \u2192 Configure \u2192 MCP Servers.`;
  }
  if (error instanceof OAuthIssuerMismatchError) {
    return `${serverName}'s authorization server identified itself inconsistently, so Volli stopped the sign-in.`;
  }
  if (error instanceof OAuthInsecureEndpointError) {
    return `${serverName}'s authorization server uses an endpoint that is not HTTPS, so Volli will not send it credentials.`;
  }
  if (error instanceof OAuthError) {
    const code = /^[a-z_]{1,64}$/.test(error.code) ? error.code : "error";
    return `${serverName}'s authorization server refused the sign-in (${code}).`;
  }
  return `Could not sign in to ${serverName}. If it needs an API key rather than a sign-in, a person can add it as a header in Settings \u2192 Configure \u2192 MCP Servers.`;
}

/** A failure on the way to a pending browser callback, said plainly. */
class SignInWaitError extends McpConnectionProblem {}

export interface McpOAuthBrokerOptions {
  store: McpCredentialStore;
  /** Opens a URL in the person's browser. Electron's `shell.openExternal` in the app. */
  openExternal: (url: string) => Promise<void>;
  now?: () => number;
  /** How long a sign-in waits for the browser. */
  signInTimeoutMs?: number;
}

/**
 * The connection to every OAuth decision: what a connection sends, what it
 * records when refused, and how a person signs in and out.
 */
export class McpOAuthBroker {
  readonly #store: McpCredentialStore;
  readonly #openExternal: (url: string) => Promise<void>;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  /** One refresh per server at a time, shared by every connection that was refused. */
  readonly #refreshing = new Map<string, Promise<void>>();
  /** One sign-in per server at a time: Settings and an agent's question join it. */
  readonly #signingIn = new Map<string, Promise<McpSignInOutcome>>();

  constructor(options: McpOAuthBrokerOptions) {
    this.#store = options.store;
    this.#openExternal = options.openExternal;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.signInTimeoutMs ?? MCP_SIGN_IN_TIMEOUT_MS;
  }

  /** Where one server stands, without disclosing anything stored. */
  signInState(server: McpServerDraft): McpSignInState {
    const oauth = mcpOAuthServer(server);
    if (oauth === null) return "not-applicable";
    if (this.#requirement(oauth) !== undefined) return "needs-sign-in";
    return this.#tokens(oauth) === undefined ? "signed-out" : "signed-in";
  }

  /** Whether a sign-in for this server is waiting on the browser right now. */
  signingIn(serverId: string): boolean {
    return this.#signingIn.has(serverId);
  }

  /** The auth provider every ordinary connection to an OAuth server carries. */
  connectionAuth(server: McpOAuthServer, sources: McpCredentialSources): AuthProvider {
    return {
      token: async () => this.#tokens(server)?.access_token,
      onUnauthorized: (context) => this.#onUnauthorized(server, context, sources),
    };
  }

  /**
   * A connection got through: a refusal that a token refresh or a new sign-in
   * has since answered is no longer outstanding. A step-up refusal is not
   * cleared this way — the handshake succeeding says nothing about the scope
   * one tool asked for — only a sign-in clears it.
   */
  markConnected(server: McpServerDraft): void {
    const oauth = mcpOAuthServer(server);
    if (oauth === null) return;
    const requirement = this.#requirement(oauth);
    if (requirement === undefined || requirement.insufficientScope) return;
    if (this.#tokens(oauth) === undefined) return;
    this.#store.update(server.id, (current) => ({ ...current, signInRequired: undefined }));
  }

  /** Record that a server refused a connection for want of authorization. */
  markRefused(
    server: McpOAuthServer,
    requirement: Omit<McpSignInRequirement, "at" | "serverUrl">,
  ): void {
    this.#store.update(server.id, (current) => ({
      ...current,
      signInRequired: { ...requirement, serverUrl: String(new URL(server.url)), at: this.#now() },
    }));
  }

  #requirement(server: McpOAuthServer): McpSignInRequirement | undefined {
    const requirement = this.#store.read(server.id)?.signInRequired;
    return requirement?.serverUrl === String(new URL(server.url)) ? requirement : undefined;
  }

  /** Delete a server's tokens and registration. Stored secrets are a different act. */
  signOut(serverId: string): void {
    this.#store.update(serverId, (current) =>
      current === undefined
        ? undefined
        : { ...current, oauth: undefined, signInRequired: undefined },
    );
  }

  /**
   * Sign a person in to one server, in their browser.
   *
   * `probe` connects once with the auth provider it is given and closes. It is
   * how the sign-in meets the server's own challenge (so discovery starts from
   * the `resource_metadata` the server named) and how the result is checked
   * afterwards; it is injected because the client that can connect is built
   * on top of this broker.
   */
  signIn(
    server: McpServerDraft,
    options: {
      sources: McpCredentialSources;
      signal: AbortSignal;
      probe: (auth: AuthProvider, signal: AbortSignal) => Promise<void>;
    },
  ): Promise<McpSignInOutcome> {
    const existing = this.#signingIn.get(server.id);
    if (existing !== undefined) return existing;
    const running = this.#signIn(server, options).finally(() => {
      this.#signingIn.delete(server.id);
    });
    this.#signingIn.set(server.id, running);
    return running;
  }

  async #signIn(
    server: McpServerDraft,
    options: {
      sources: McpCredentialSources;
      signal: AbortSignal;
      probe: (auth: AuthProvider, signal: AbortSignal) => Promise<void>;
    },
  ): Promise<McpSignInOutcome> {
    const target = mcpOAuthServer(server);
    if (target === null) {
      return {
        ok: false,
        cancelled: false,
        message: `${server.name} is not a server Volli signs in to: only a remote server without its own Authorization header uses OAuth.`,
      };
    }
    let callback: OAuthCallbackServer | null = null;
    try {
      options.signal.throwIfAborted();
      const clientSecret = resolveMcpOAuthClientSecret(
        server,
        target.oauth?.clientSecret,
        options.sources,
      );
      callback = await this.#listen(server.id, target);
      let authorizationUrl: URL | undefined;
      const provider = new McpOAuthProvider({
        serverUrl: target.url,
        redirectUrl: callback.redirectUrl,
        clientMetadata: {
          client_name: MCP_OAUTH_CLIENT_NAME,
          ...(target.oauth?.scope === undefined ? {} : { scope: target.oauth.scope }),
        },
        ...(target.oauth?.clientId === undefined ? {} : { clientId: target.oauth.clientId }),
        ...(clientSecret === undefined ? {} : { clientSecret }),
        store: oauthStateStore(this.#store, server.id, {}),
        onRedirect: (url) => {
          authorizationUrl = url;
        },
      });

      const requirement = this.#requirement(target);
      let outcome: "AUTHORIZED" | "REDIRECT";
      if (requirement?.insufficientScope === true) {
        // Step-up: straight to the browser for the scope the server asked for
        // on top of what was granted. A refresh would only renew the old scope.
        const stored = this.#store.read(server.id)?.oauth;
        const advertised = (
          stored?.discovery?.["resourceMetadata"] as { scopes_supported?: string[] } | undefined
        )?.scopes_supported?.join(" ");
        outcome = await authorizeMcp(provider, {
          serverUrl: target.url,
          scope: scopeSet(
            target.oauth?.scope ?? advertised,
            stored?.tokens?.["scope"] as string | undefined,
            requirement.scope,
          ),
          ...(requirement.resourceMetadataUrl === undefined
            ? {}
            : { resourceMetadataUrl: new URL(requirement.resourceMetadataUrl) }),
          skipRefresh: true,
        });
      } else {
        try {
          await options.probe(adaptOAuthProvider(provider), options.signal);
          outcome = "AUTHORIZED";
        } catch (error) {
          if (!authorizationRequired(error)) throw error;
          outcome = "REDIRECT";
        }
      }

      if (outcome === "REDIRECT") {
        const url = authorizationUrl;
        if (url === undefined) throw new Error("no authorization URL");
        if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
          return {
            ok: false,
            cancelled: false,
            message: `${server.name}'s authorization page is not an https address, so Volli did not open it.`,
          };
        }
        const waiting = callback.waitForCallback(await provider.state());
        // The wait settles on close as well; a rejection nobody awaits yet
        // must not become an unhandled one while the browser opens.
        waiting.catch(() => undefined);
        await this.#openExternal(url.href);
        const { code } = await untilAborted(waiting, options.signal, () => {
          void callback?.close().catch(() => undefined);
        }).catch((error: unknown) => {
          if (options.signal.aborted) throw error;
          throw new SignInWaitError(
            error instanceof Error && /timed out/i.test(error.message)
              ? `Nobody finished signing in to ${server.name} within ${Math.round(this.#timeoutMs / 60_000)} minutes.`
              : `The sign-in to ${server.name} was not completed in the browser.`,
          );
        });
        await authorizeMcp(provider, { serverUrl: target.url, authorizationCode: code });
      }

      // The tokens are in; the refusal they answer is not outstanding any more.
      this.#store.update(server.id, (current) => ({ ...current, signInRequired: undefined }));
      await options.probe(this.connectionAuth(target, options.sources), options.signal);
      return {
        ok: true,
        message:
          this.#tokens(target) === undefined
            ? `${server.name} accepted the connection without a sign-in.`
            : `Signed in to ${server.name}.`,
      };
    } catch (error) {
      if (options.signal.aborted) {
        return {
          ok: false,
          cancelled: true,
          message: `The sign-in to ${server.name} was cancelled.`,
        };
      }
      return {
        ok: false,
        cancelled: false,
        message:
          error instanceof SignInWaitError ? error.message : signInFailure(server.name, error),
      };
    } finally {
      await callback?.close().catch(() => undefined);
    }
  }

  /**
   * Start the loopback redirect server.
   *
   * With no port configured, a client Volli registered before is listened for
   * on the port its registration named, when that port is free: RFC 8252 says
   * an authorization server must accept any loopback port, and most do, but a
   * strict one compares the whole registered redirect URI. A taken port falls
   * back to any free one.
   */
  async #listen(serverId: string, target: McpOAuthServer): Promise<OAuthCallbackServer> {
    const options = mcpOAuthCallbackOptions(target.oauth, this.#timeoutMs);
    const registered = (
      this.#store.read(serverId)?.oauth?.clientInformation as
        | { redirect_uris?: unknown }
        | undefined
    )?.redirect_uris;
    if (
      options.port === 0 &&
      target.oauth?.callbackUrl === undefined &&
      Array.isArray(registered)
    ) {
      const previous = registered.find((uri): uri is string => typeof uri === "string");
      const port =
        previous === undefined || !URL.canParse(previous) ? NaN : Number(new URL(previous).port);
      if (Number.isInteger(port) && port > 0) {
        try {
          return await OAuthCallbackServer.listen({ ...options, port });
        } catch {
          // Taken: any free port, as RFC 8252 allows.
        }
      }
    }
    return OAuthCallbackServer.listen(options);
  }

  #tokens(server: McpOAuthServer): McpStoredOAuthState["tokens"] {
    const oauth = this.#store.read(server.id)?.oauth;
    return oauth?.serverUrl === String(new URL(server.url)) ? oauth.tokens : undefined;
  }

  async #onUnauthorized(
    server: McpOAuthServer,
    context: UnauthorizedContext,
    sources: McpCredentialSources,
  ): Promise<void> {
    const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
    const requirement = {
      ...(challenge.scope === undefined ? {} : { scope: challenge.scope }),
      ...(challenge.resourceMetadataUrl === undefined
        ? {}
        : { resourceMetadataUrl: challenge.resourceMetadataUrl.href }),
    };
    if (context.response.status === 403 || challenge.error === "insufficient_scope") {
      this.markRefused(server, { insufficientScope: true, ...requirement });
      throw new McpSignInRequiredError(server.name, true);
    }
    const current = this.#tokens(server);
    // Another request refreshed, or a person signed in, since this request
    // left: retry with what is stored now rather than spending the refresh token.
    if (current !== undefined && current.access_token !== context.token) return;
    if (typeof current?.["refresh_token"] === "string") {
      try {
        await this.#refresh(server, sources, context.fetch);
        return;
      } catch (error) {
        // A network failure is not a refusal: the next call may simply work.
        if (error instanceof TypeError) throw error;
      }
    }
    this.markRefused(server, { insufficientScope: false, ...requirement });
    throw new McpSignInRequiredError(server.name, false);
  }

  #refresh(server: McpOAuthServer, sources: McpCredentialSources, fetch: McpFetch): Promise<void> {
    const existing = this.#refreshing.get(server.id);
    if (existing !== undefined) return existing;
    const running = this.#refreshOnce(server, sources, fetch).finally(() => {
      this.#refreshing.delete(server.id);
    });
    this.#refreshing.set(server.id, running);
    return running;
  }

  async #refreshOnce(
    server: McpOAuthServer,
    sources: McpCredentialSources,
    fetch: McpFetch,
  ): Promise<void> {
    const stored = this.#store.read(server.id)?.oauth;
    const refreshToken = stored?.tokens?.["refresh_token"];
    const discovery = stored?.discovery;
    const clientSecret = resolveMcpOAuthClientSecret(server, server.oauth?.clientSecret, sources);
    const clientInformation: OAuthClientInformationMixed | undefined =
      server.oauth?.clientId === undefined
        ? (stored?.clientInformation as OAuthClientInformationMixed | undefined)
        : {
            client_id: server.oauth.clientId,
            ...(clientSecret === undefined ? {} : { client_secret: clientSecret }),
          };
    if (
      typeof refreshToken !== "string" ||
      discovery === undefined ||
      clientInformation === undefined
    ) {
      throw new Error("not refreshable");
    }
    const authorizationServerUrl = discovery.authorizationServerUrl;
    const metadata =
      (discovery["authorizationServerMetadata"] as Parameters<
        typeof refreshAuthorization
      >[1]["metadata"]) ??
      (await discoverAuthorizationServerMetadata(authorizationServerUrl, { fetch }));
    const resource = selectResource(
      server.url,
      discovery["resourceMetadata"] as Parameters<typeof selectResource>[1],
    );
    let tokens: OAuthTokens;
    try {
      tokens = await refreshAuthorization(authorizationServerUrl, {
        ...(metadata === undefined ? {} : { metadata }),
        clientInformation,
        ...(resource === undefined ? {} : { resource }),
        refreshToken,
        fetch,
      });
    } catch (error) {
      if (error instanceof OAuthError && error.code === "invalid_grant") {
        // The refresh token is dead; keep the registration, drop the grant.
        this.#store.update(server.id, (current) =>
          current?.oauth === undefined
            ? current
            : {
                ...current,
                oauth: { ...current.oauth, tokens: undefined, tokensExpireAt: undefined },
              },
        );
      }
      throw error;
    }
    const expiresAt =
      tokens.expires_in === undefined ? undefined : this.#now() + tokens.expires_in * 1_000;
    this.#store.update(server.id, (current) =>
      current?.oauth === undefined
        ? current
        : {
            ...current,
            oauth: {
              ...current.oauth,
              tokens: tokens as McpStoredOAuthState["tokens"],
              tokensExpireAt: expiresAt,
            },
          },
    );
  }
}

/** Whether an error means "a person has to authorize in the browser". */
function authorizationRequired(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof McpOAuthAuthorizationRequiredError) return true;
    current = current.cause;
  }
  return false;
}

/** Settle with `promise`, or reject with the signal's reason when it aborts first. */
function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbort: () => void,
): Promise<T> {
  if (signal.aborted) {
    onAbort();
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      onAbort();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
