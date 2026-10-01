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
  isMcpLoopbackUrl,
  MCP_CONNECTION_TIMEOUT_MS,
  MCP_PLAIN_HTTP_CREDENTIAL_REFUSAL,
  mcpEndpointMayCarryCredentials,
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
import { boundedFetch } from "./client";
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

/** The most an authorization server's metadata, registration or token answer may be. */
export const MCP_OAUTH_RESPONSE_MAX_BYTES = 1_024 * 1_024;

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
  // A bearer token over plain http to another host is readable by anyone on
  // the path: such a server is never given one, and never signed in to.
  if (!mcpEndpointMayCarryCredentials(transport.url)) return null;
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
  if (error instanceof Error && /PKCE S256/.test(error.message)) {
    return `${serverName}'s authorization server does not say it supports PKCE with S256, which MCP requires, so Volli did not sign in.`;
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
  /**
   * How long one request to an authorization server may take — discovery,
   * registration, a token exchange or refresh. Defaults to the MCP connection
   * limit: a refresh that hangs holds every call to that server behind it.
   */
  requestTimeoutMs?: number;
}

/** One sign-in in flight, and who is waiting on it. */
interface SignInRun {
  /** The endpoint it signs in to: a draft at another URL under the same id starts its own. */
  readonly url: string;
  readonly outcome: Promise<McpSignInOutcome>;
  readonly controller: AbortController;
  waiters: number;
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
  /**
   * Every request this broker makes to an authorization server: the global
   * fetch, bounded. Never the transport's fetch, which is the one that may
   * carry the person's headers to the MCP endpoint.
   */
  readonly #fetch: McpFetch;
  /** One refresh per server at a time, shared by every connection that was refused. */
  readonly #refreshing = new Map<string, Promise<void>>();
  /** One sign-in per server at a time: Settings and an agent's question join it. */
  readonly #signingIn = new Map<string, SignInRun>();

  constructor(options: McpOAuthBrokerOptions) {
    this.#store = options.store;
    this.#openExternal = options.openExternal;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.signInTimeoutMs ?? MCP_SIGN_IN_TIMEOUT_MS;
    const requestTimeoutMs = options.requestTimeoutMs ?? MCP_CONNECTION_TIMEOUT_MS;
    // Bounded in time and in size: these hosts are whatever a server's
    // metadata names, and pi-mcp reads their answers whole.
    this.#fetch = boundedFetch((input, init) => {
      const deadline = AbortSignal.timeout(requestTimeoutMs);
      return fetch(input, {
        ...init,
        signal: init?.signal == null ? deadline : AbortSignal.any([init.signal, deadline]),
      });
    }, MCP_OAUTH_RESPONSE_MAX_BYTES);
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
    // Got through — with a token, or because the server no longer asks for
    // one. Either way the refusal is not outstanding.
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
    // A sign-in still waiting on the browser would only put back what this
    // deletes.
    this.cancelSignIn(serverId);
    const oauth = this.#store.read(serverId)?.oauth;
    this.#store.update(serverId, (current) =>
      current === undefined
        ? undefined
        : { ...current, oauth: undefined, signInRequired: undefined, callbackPort: undefined },
    );
    if (oauth !== undefined) void this.#revoke(oauth);
  }

  /**
   * Ask the authorization server to forget the grant, when it says how (RFC
   * 7009). Best effort and after the fact: the tokens are already gone from
   * this machine, which is what signing out promises; a server that does not
   * answer leaves them to expire.
   */
  async #revoke(oauth: McpStoredOAuthState): Promise<void> {
    const metadata = oauth.discovery?.["authorizationServerMetadata"] as
      | { revocation_endpoint?: unknown }
      | undefined;
    const endpoint = metadata?.revocation_endpoint;
    const clientId = (oauth.clientInformation as { client_id?: unknown } | undefined)?.client_id;
    if (typeof endpoint !== "string" || typeof clientId !== "string") return;
    if (!URL.canParse(endpoint) || !mcpEndpointMayCarryCredentials(endpoint)) return;
    for (const [hint, token] of [
      ["refresh_token", oauth.tokens?.["refresh_token"]],
      ["access_token", oauth.tokens?.access_token],
    ] as const) {
      if (typeof token !== "string") continue;
      await this.#fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token, token_type_hint: hint, client_id: clientId }),
      })
        .then((response) => response.body?.cancel())
        .catch(() => undefined);
    }
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
    // One sign-in per server, whoever asked for it. Each caller waits on it
    // with its own signal: a caller that stops waiting (an agent's turn
    // interrupted, say) leaves it running for the others, and only when every
    // waiter has gone — or a person presses Cancel (`cancelSignIn`) — does the
    // sign-in itself stop.
    const url = server.transport.type === "streamable-http" ? server.transport.url : "";
    let run = this.#signingIn.get(server.id);
    if (run !== undefined && (run.url !== url || run.controller.signal.aborted)) {
      // A different endpoint under the same id, or a run already stopping:
      // this caller gets a sign-in of its own rather than someone else's.
      run.controller.abort(new Error("Superseded by a sign-in to another endpoint."));
      this.#signingIn.delete(server.id);
      run = undefined;
    }
    if (run === undefined) {
      const controller = new AbortController();
      const created: SignInRun = {
        url,
        controller,
        waiters: 0,
        outcome: this.#signIn(server, { ...options, signal: controller.signal }).finally(() => {
          if (this.#signingIn.get(server.id) === created) this.#signingIn.delete(server.id);
        }),
      };
      run = created;
      this.#signingIn.set(server.id, run);
    }
    const joined = run;
    joined.waiters += 1;
    const cancelled: McpSignInOutcome = {
      ok: false,
      cancelled: true,
      message: `The sign-in to ${server.name} was cancelled.`,
    };
    const stop = (reason: string): void => {
      joined.controller.abort(new Error(reason));
      if (this.#signingIn.get(server.id) === joined) this.#signingIn.delete(server.id);
    };
    return new Promise<McpSignInOutcome>((resolve) => {
      let settled = false;
      const leave = (outcome: McpSignInOutcome): void => {
        if (settled) return;
        settled = true;
        options.signal.removeEventListener("abort", abandon);
        joined.waiters -= 1;
        resolve(outcome);
      };
      function abandon(): void {
        leave(cancelled);
        if (joined.waiters === 0) stop("Nobody is waiting on the sign-in.");
      }
      if (options.signal.aborted) {
        abandon();
        return;
      }
      options.signal.addEventListener("abort", abandon, { once: true });
      void joined.outcome.then(leave, () =>
        leave({ ok: false, cancelled: false, message: `Could not sign in to ${server.name}.` }),
      );
    });
  }

  /** Stop a sign-in waiting on the browser, for everyone waiting on it — a person's Cancel. */
  cancelSignIn(serverId: string): void {
    const run = this.#signingIn.get(serverId);
    if (run === undefined) return;
    run.controller.abort(new Error("The sign-in was cancelled."));
    this.#signingIn.delete(serverId);
  }

  async #signIn(
    server: McpServerDraft,
    options: {
      sources: McpCredentialSources;
      signal: AbortSignal;
      probe: (auth: AuthProvider, signal: AbortSignal) => Promise<void>;
    },
  ): Promise<McpSignInOutcome> {
    if (
      server.transport.type === "streamable-http" &&
      !mcpEndpointMayCarryCredentials(server.transport.url)
    ) {
      return {
        ok: false,
        cancelled: false,
        message: `${server.name} is a plain http endpoint, so Volli will not sign in to it: ${MCP_PLAIN_HTTP_CREDENTIAL_REFUSAL}.`,
      };
    }
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
      const clientIdBefore = (
        this.#store.read(server.id)?.oauth?.clientInformation as { client_id?: unknown } | undefined
      )?.client_id;
      const listening = await this.#listen(server.id, target);
      callback = listening.server;
      const listenedOnAnyPort = listening.chosenByVolli;
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
          fetch: this.#fetch,
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
          await options.probe(this.#probeAuth(provider, target.oauth?.scope), options.signal);
          outcome = "AUTHORIZED";
        } catch (error) {
          if (!authorizationRequired(error)) throw error;
          outcome = "REDIRECT";
        }
      }

      if (outcome === "REDIRECT") {
        const url = authorizationUrl;
        if (url === undefined) throw new Error("no authorization URL");
        // https, or plain http only when the MCP server is itself on this
        // machine: a remote server has no business sending the person to a
        // page on their own loopback interface.
        const loopbackPage =
          url.protocol === "http:" &&
          isLoopback(url.hostname) &&
          isMcpLoopbackUrl(new URL(target.url));
        if (url.protocol !== "https:" && !loopbackPage) {
          return {
            ok: false,
            cancelled: false,
            message: `${server.name}'s authorization page is not an https address, so Volli did not open it.`,
          };
        }
        // MCP 2025-11-25 requires a client to confirm the authorization server
        // supports PKCE with S256 before it authorizes, and to refuse if it
        // does not say so. pi-mcp refuses only when the list is present and
        // lacks S256; an absent list is refused here.
        const metadata = this.#store.read(server.id)?.oauth?.discovery?.[
          "authorizationServerMetadata"
        ] as { code_challenge_methods_supported?: unknown } | undefined;
        const methods = metadata?.code_challenge_methods_supported;
        if (!Array.isArray(methods) || !methods.includes("S256")) {
          return {
            ok: false,
            cancelled: false,
            message: `${server.name}'s authorization server does not say it supports PKCE with S256, which MCP requires, so Volli did not sign in.`,
          };
        }
        // Discovery and registration watch no signal of their own: a Cancel
        // that landed during them must still stop the browser opening.
        options.signal.throwIfAborted();
        const waiting = callback.waitForCallback(await provider.state());
        // The wait settles on close as well; a rejection nobody awaits yet
        // must not become an unhandled one while the browser opens.
        waiting.catch(() => undefined);
        options.signal.throwIfAborted();
        await this.#openExternal(url.href);
        const { code, iss } = await untilAborted(waiting, options.signal, () => {
          void callback?.close().catch(() => undefined);
        }).catch((error: unknown) => {
          if (options.signal.aborted) throw error;
          throw new SignInWaitError(
            error instanceof Error && /timed out/i.test(error.message)
              ? `Nobody finished signing in to ${server.name} within ${Math.round(this.#timeoutMs / 60_000)} minutes.`
              : `The sign-in to ${server.name} was not completed in the browser.`,
          );
        });
        // RFC 9207: the redirect names the authorization server that issued
        // the code. When it does, or when the server said it always will, it
        // must be the one this sign-in discovered — otherwise a code from
        // another authorization server (a mix-up attack) would be exchanged
        // with this one's client.
        const discovered = this.#store.read(server.id)?.oauth?.discovery?.[
          "authorizationServerMetadata"
        ] as
          | { issuer?: unknown; authorization_response_iss_parameter_supported?: unknown }
          | undefined;
        if (
          iss !== undefined ||
          discovered?.authorization_response_iss_parameter_supported === true
        ) {
          const trim = (value: unknown): string =>
            typeof value === "string" ? value.replace(/\/$/, "") : "";
          if (iss === undefined || trim(iss) !== trim(discovered?.issuer)) {
            return {
              ok: false,
              cancelled: false,
              message: `${server.name}'s sign-in came back from an authorization server other than the one it started with, so Volli did not finish it.`,
            };
          }
        }
        await authorizeMcp(provider, {
          serverUrl: target.url,
          authorizationCode: code,
          fetch: this.#fetch,
        });
      }

      // The tokens are in; the refusal they answer is not outstanding any more.
      // A client Volli registered in this sign-in was registered with this
      // callback's port: remember it as Volli's own choice, so the next
      // sign-in can listen there for an authorization server that compares
      // redirect URIs exactly.
      const registeredNow =
        target.oauth?.clientId === undefined &&
        clientIdBefore !==
          (
            this.#store.read(server.id)?.oauth?.clientInformation as
              | { client_id?: unknown }
              | undefined
          )?.client_id;
      const port = Number(new URL(callback.redirectUrl).port);
      this.#store.update(server.id, (current) => ({
        ...current,
        signInRequired: undefined,
        ...(registeredNow && listenedOnAnyPort ? { callbackPort: port } : {}),
      }));
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
   * on the port Volli itself chose when it registered that client — recorded
   * by Volli, never read from the authorization server's registration answer,
   * which a hostile server could fill with any port on this machine. RFC 8252
   * says an authorization server must accept any loopback port, and most do,
   * but a strict one compares the whole redirect URI. A taken port falls back
   * to any free one.
   */
  async #listen(
    serverId: string,
    target: McpOAuthServer,
  ): Promise<{ server: OAuthCallbackServer; chosenByVolli: boolean }> {
    const options = mcpOAuthCallbackOptions(target.oauth, this.#timeoutMs);
    if (options.port !== 0 || target.oauth?.callbackUrl !== undefined) {
      return { server: await OAuthCallbackServer.listen(options), chosenByVolli: false };
    }
    const recorded = this.#store.read(serverId)?.callbackPort;
    if (recorded !== undefined) {
      try {
        return {
          server: await OAuthCallbackServer.listen({ ...options, port: recorded }),
          chosenByVolli: true,
        };
      } catch {
        // Taken: any free port, as RFC 8252 allows.
      }
    }
    return { server: await OAuthCallbackServer.listen(options), chosenByVolli: true };
  }

  /**
   * The auth provider a sign-in's probe connects with: pi-mcp's
   * `adaptOAuthProvider`, with two differences. It asks for the scope the
   * person configured (plus whatever the challenge names) rather than letting
   * the server's advertised scopes win, and every request it makes goes
   * through this broker's bounded fetch, never the transport's.
   */
  #probeAuth(provider: McpOAuthProvider, configuredScope: string | undefined): AuthProvider {
    let inFlight: Promise<void> | undefined;
    return {
      token: async () => (await provider.tokens())?.access_token,
      onUnauthorized: async (context) => {
        const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
        const insufficientScope = challenge.error === "insufficient_scope";
        if (!insufficientScope && inFlight === undefined && context.token !== undefined) {
          const current = (await provider.tokens())?.access_token;
          if (current !== undefined && current !== context.token) return;
        }
        const scope =
          configuredScope === undefined
            ? challenge.scope
            : scopeSet(configuredScope, challenge.scope);
        inFlight ??= authorizeMcp(provider, {
          serverUrl: context.serverUrl,
          fetch: this.#fetch,
          skipRefresh: insufficientScope,
          ...(scope === undefined ? {} : { scope }),
          ...(challenge.resourceMetadataUrl === undefined
            ? {}
            : { resourceMetadataUrl: challenge.resourceMetadataUrl }),
        })
          .then((result) => {
            if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
          })
          .finally(() => {
            inFlight = undefined;
          });
        await inFlight;
      },
    };
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
        await this.#refresh(server, sources);
        return;
      } catch (error) {
        // A network failure or a request that ran out its time is not a
        // refusal: the next call may simply work.
        if (transient(error)) throw error;
      }
    }
    this.markRefused(server, { insufficientScope: false, ...requirement });
    throw new McpSignInRequiredError(server.name, false);
  }

  #refresh(server: McpOAuthServer, sources: McpCredentialSources): Promise<void> {
    const existing = this.#refreshing.get(server.id);
    if (existing !== undefined) return existing;
    const running = this.#refreshOnce(server, sources).finally(() => {
      this.#refreshing.delete(server.id);
    });
    this.#refreshing.set(server.id, running);
    return running;
  }

  async #refreshOnce(server: McpOAuthServer, sources: McpCredentialSources): Promise<void> {
    const fetch = this.#fetch;
    const read = this.#store.read(server.id)?.oauth;
    // Only a grant for this very endpoint is refreshed with this endpoint's
    // client: state recorded for another URL under the same id is not ours.
    const stored = read?.serverUrl === String(new URL(server.url)) ? read : undefined;
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
        // The refresh token is dead; keep the registration, drop the grant —
        // unless a sign-in has replaced the grant meanwhile.
        this.#store.update(server.id, (current) =>
          current?.oauth === undefined || current.oauth.tokens?.["refresh_token"] !== refreshToken
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
    // Written only over the grant it refreshed: a sign-in or step-up that
    // finished while this request was out has newer tokens, and keeps them.
    this.#store.update(server.id, (current) =>
      current?.oauth === undefined || current.oauth.tokens?.["refresh_token"] !== refreshToken
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

/** A failure that says nothing about the grant: the network, or a request out of time. */
function transient(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    // pi-mcp's own reading too: an authorization server's 5xx is not a verdict on the grant.
    (error instanceof OAuthError && error.code === "server_error") ||
    (error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError"))
  );
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
