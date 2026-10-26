/**
 * The account's GitHub half (VC-897): the person's GitHub connection and the
 * Volli GitHub App's installations, read from the backend
 * (`convex/functions/github.ts`) with the account's access token, and the
 * snapshot Settings → Account follows. It is `AccountPort.github`, served
 * only with the `cloud` flag on.
 *
 * **Flows.** Connecting GitHub and installing the App are browser round
 * trips that return to the backend, not here. Main mints the flow's id,
 * asks the backend for the URL (`github:beginConnect` / `beginInstall`),
 * opens the browser, then polls its own flow (`github:flow`) every two
 * seconds until it is `done`, `failed` or `requested`, ten minutes pass, or
 * the person cancels. One flow at a time: a new start or a cancel ends the
 * one in flight, and its outcome is dropped when it lands. A poll that fails
 * in transit, or that the backend refuses without a typed code, is tried
 * again on the next tick until the deadline.
 *
 * **Reads.** Each new subscription reads the connection afresh (and, when it
 * is active, the installations); a finished flow reads them again. A read
 * that fails says so in the snapshot; the window's retry is a new
 * subscription. An installation row this build cannot read is skipped, not
 * the whole list. Nothing here hands a token to the window.
 *
 * **The person.** The service follows the account (from its first
 * subscription, so nothing is read before the window asks): when the account
 * leaves signed-in, starts a deletion, or becomes someone else, the flow in
 * flight ends, every read in flight drops its result, and the section is
 * unavailable until the window subscribes again.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  ACCOUNT_GITHUB_INSTALLATIONS_MAX,
  ACCOUNT_TEXT_MAX,
  OperationUnavailableError,
  UNAVAILABLE_ACCOUNT_GITHUB,
  type AccountGithubConnection,
  type AccountGithubFlow,
  type AccountGithubInstallation,
  type AccountGithubSnapshot,
  type AccountGithubState,
  type AccountSnapshot,
} from "@volli/shared";
import { GITHUB_ERROR_CODES, type GithubErrorCode } from "@volli/shared/cloud";

import { BackendRefusedError, type ConvexCall } from "./backend";
import { ACCOUNT_CLOUD_OFF, type AccountLogger } from "./service";

/** How often a flow in flight is read. */
const POLL_INTERVAL_MS = 2_000;
/** How long a flow is followed: the backend's own flow lifetime. */
const FLOW_TIMEOUT_MS = 10 * 60 * 1000;

const WEB_PAGE = /^https?:\/\//u;

// ── the backend's GitHub functions ────────────────────────────────────────

/** `github:flow`, as far as this client follows it. */
export interface GithubFlowRow {
  readonly status: "pending" | "requested" | "done" | "failed";
  /** A failed flow's code; one this build does not know reads as `null`. */
  readonly error: GithubErrorCode | null;
}

export interface GithubInstallationsAnswer {
  /**
   * `active`, or the code the backend's GitHub read ended with. Only an
   * `active` answer lists anything: otherwise `installations` is empty
   * because nothing could be read, not because there is nothing.
   */
  readonly connection: "active" | GithubErrorCode;
  readonly installations: AccountGithubInstallation[];
}

export interface GithubBackend {
  /** Whether this deployment has a GitHub App. */
  configured(accessToken: string): Promise<boolean>;
  /** The connection; a revoked one is `null`, like none. */
  connection(accessToken: string): Promise<AccountGithubConnection | null>;
  /** The URL that starts the flow `flowId` in the browser. */
  begin(accessToken: string, purpose: AccountGithubFlow, flowId: string): Promise<string>;
  flow(accessToken: string, flowId: string): Promise<GithubFlowRow | null>;
  installations(accessToken: string): Promise<GithubInstallationsAnswer>;
  disconnect(accessToken: string): Promise<void>;
}

class UnreadableAnswerError extends Error {
  constructor() {
    super("Volli Cloud answered with GitHub details this build cannot read.");
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function clip(text: string): string;
function clip(text: string | null): string | null;
function clip(text: string | null): string | null {
  return text === null ? null : text.slice(0, ACCOUNT_TEXT_MAX);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new UnreadableAnswerError();
  return value;
}

function nullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new UnreadableAnswerError();
  return value;
}

const isGithubErrorCode = (value: unknown): value is GithubErrorCode =>
  typeof value === "string" && (GITHUB_ERROR_CODES as readonly string[]).includes(value);

function connectionFrom(value: unknown): AccountGithubConnection | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new UnreadableAnswerError();
  const status = value["status"];
  if (status === "revoked") return null;
  if (status !== "active" && status !== "needs_reconnect") throw new UnreadableAnswerError();
  return {
    status,
    login: clip(stringField(value, "login")),
    name: clip(nullableString(value, "name")),
  };
}

function installationFrom(value: unknown): AccountGithubInstallation {
  if (!isRecord(value)) throw new UnreadableAnswerError();
  const accountType = value["accountType"];
  const repositorySelection = value["repositorySelection"];
  const configureUrl = stringField(value, "configureUrl");
  if (
    (accountType !== "user" && accountType !== "org") ||
    (repositorySelection !== "all" && repositorySelection !== "selected") ||
    typeof value["suspended"] !== "boolean" ||
    !WEB_PAGE.test(configureUrl) ||
    configureUrl.length > ACCOUNT_TEXT_MAX
  ) {
    throw new UnreadableAnswerError();
  }
  return {
    installationId: clip(stringField(value, "installationId")),
    accountLogin: clip(stringField(value, "accountLogin")),
    accountType,
    repositorySelection,
    suspended: value["suspended"],
    configureUrl,
  };
}

function urlFrom(value: unknown): string {
  if (!isRecord(value)) throw new UnreadableAnswerError();
  const url = stringField(value, "url");
  if (!WEB_PAGE.test(url)) throw new UnreadableAnswerError();
  return url;
}

const SILENT: AccountLogger = { info: () => {}, warn: () => {} };

/** The GitHub functions over Convex's HTTP functions API, with the account's bearer token. */
export function convexGithubBackend(call: ConvexCall, log: AccountLogger = SILENT): GithubBackend {
  return {
    configured: async (token) => {
      const answer = await call("query", "github:config", token);
      if (!isRecord(answer) || typeof answer["configured"] !== "boolean") {
        throw new UnreadableAnswerError();
      }
      return answer["configured"];
    },
    connection: async (token) => connectionFrom(await call("query", "github:connection", token)),
    begin: async (token, purpose, flowId) =>
      urlFrom(
        await call(
          "action",
          purpose === "connect" ? "github:beginConnect" : "github:beginInstall",
          token,
          { flowId },
        ),
      ),
    flow: async (token, flowId) => {
      const answer = await call("query", "github:flow", token, { flowId });
      if (answer === null) return null;
      if (!isRecord(answer)) throw new UnreadableAnswerError();
      const status = answer["status"];
      if (
        status !== "pending" &&
        status !== "requested" &&
        status !== "done" &&
        status !== "failed"
      ) {
        throw new UnreadableAnswerError();
      }
      const error = nullableString(answer, "error");
      return { status, error: isGithubErrorCode(error) ? error : null };
    },
    installations: async (token) => {
      const answer = await call("action", "github:installations", token);
      if (!isRecord(answer) || !Array.isArray(answer["installations"])) {
        throw new UnreadableAnswerError();
      }
      const connection = stringField(answer, "connection");
      if (connection !== "active" && !isGithubErrorCode(connection)) {
        throw new UnreadableAnswerError();
      }
      const rows: AccountGithubInstallation[] = [];
      let skipped = 0;
      for (const row of answer["installations"]) {
        try {
          rows.push(installationFrom(row));
        } catch {
          // One row this build cannot read (or whose link is not a web page)
          // is left out; the rest of the list still shows.
          skipped += 1;
        }
      }
      if (skipped > 0) log.warn("skipped unreadable GitHub installations", { skipped });
      return { connection, installations: rows };
    },
    disconnect: async (token) => {
      await call("action", "github:disconnect", token);
    },
  };
}

// ── the snapshot ──────────────────────────────────────────────────────────

/** What a flow that ended with the backend's `code` tells the person. */
const FLOW_FAILURES: Record<GithubErrorCode, string> = {
  github_not_configured: "This Volli Cloud has no GitHub App.",
  not_connected: "Connect GitHub first.",
  needs_reconnect: "Reconnect GitHub, then try again.",
  flow_not_found: "That GitHub link no longer works. Start again.",
  flow_expired: "The GitHub link expired. Start again.",
  flow_used: "That GitHub link was already used. Start again.",
  account_already_linked: "This GitHub account is connected to another Volli account.",
  installation_not_visible: "Your GitHub account can't see that installation.",
  github_denied: "GitHub declined the request.",
  github_rate_limited: "GitHub is limiting requests. Try again in a few minutes.",
  github_unavailable: "Couldn't reach GitHub. Try again.",
};

function flowFailure(code: GithubErrorCode | null): string {
  return code !== null ? FLOW_FAILURES[code] : "GitHub didn't finish. Try again.";
}

const TIMED_OUT = "GitHub didn't finish in time. Start again.";
const FLOW_GONE = "Volli Cloud lost track of that GitHub link. Start again.";

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

export interface GithubServiceOptions {
  /** The `cloud` flag, read on every call. */
  readonly enabled: () => boolean;
  /** `null`: this build names no backend; the section is unavailable. */
  readonly backend: GithubBackend | null;
  /** The account's access token; `null` while signed out. */
  readonly accessToken: () => Promise<string | null>;
  /**
   * The account, followed from the first subscription: who is signed in
   * decides whose GitHub this is. Absent: nothing is followed.
   */
  readonly account?: {
    subscribe(listener: (snapshot: AccountSnapshot) => void): () => void;
  };
  /** Opens the system browser (harness mode records instead); rejects when it cannot. */
  readonly openBrowser: (url: string) => void | Promise<void>;
  readonly newFlowId?: () => string;
  readonly flowTimeoutMs?: number;
  readonly now?: () => number;
  /** Waits `ms`, rejecting when `signal` aborts. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly log?: AccountLogger;
}

export interface GithubService {
  subscribe(listener: (snapshot: AccountGithubSnapshot) => void): () => void;
  connect(): Promise<void>;
  install(): Promise<void>;
  cancel(): void;
  disconnect(): Promise<void>;
  /** Ends a flow in flight, stops following the account and drops every listener. At quit. */
  dispose(): void;
}

interface Flow {
  readonly purpose: AccountGithubFlow;
  readonly flowId: string;
  readonly abort: AbortController;
}

/**
 * Whose GitHub the section may show: the signed-in person's Volli user id,
 * while their account is not being deleted; `null` otherwise.
 */
function personOf(snapshot: AccountSnapshot): string | null {
  const { account } = snapshot;
  return snapshot.state === "signed-in" && account !== null && account.deletionPurgeAfter === null
    ? account.userId
    : null;
}

export function createGithubService(options: GithubServiceOptions): GithubService {
  const { backend } = options;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
  const flowTimeoutMs = options.flowTimeoutMs ?? FLOW_TIMEOUT_MS;
  const newFlowId = options.newFlowId ?? randomUUID;
  const log = options.log ?? SILENT;
  const listeners = new Set<(snapshot: AccountGithubSnapshot) => void>();

  let state: AccountGithubState = "unavailable";
  let connection: AccountGithubConnection | null = null;
  let installations: readonly AccountGithubInstallation[] | null = null;
  let requested = false;
  let failure: string | null = null;
  let flow: Flow | null = null;
  /** Every read takes a number; a read overtaken by a newer one drops its result. */
  let reading = 0;
  /** The account's person as last seen; `undefined` until the account is followed. */
  let person: string | null | undefined;
  let unfollow: (() => void) | null = null;

  const current = (): AccountGithubSnapshot =>
    state === "unavailable"
      ? UNAVAILABLE_ACCOUNT_GITHUB
      : {
          state,
          connection,
          installations,
          waiting: flow?.purpose ?? null,
          requested,
          failure: clip(failure),
        };

  const emit = (): void => {
    const snapshot = current();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        log.warn("github listener failed", { error });
      }
    }
  };

  const requireCloud = (): void => {
    if (!options.enabled()) throw new OperationUnavailableError(ACCOUNT_CLOUD_OFF);
  };

  const requireBackend = (): GithubBackend => {
    requireCloud();
    if (backend === null) {
      throw new OperationUnavailableError("This build has no Volli Cloud backend configured.");
    }
    return backend;
  };

  const requireToken = async (): Promise<string> => {
    const token = await options.accessToken();
    if (token === null) throw new Error("Sign in to Volli first.");
    return token;
  };

  const endFlow = (): void => {
    flow?.abort.abort();
    flow = null;
  };

  /** Nothing of anyone's is shown; every read in flight drops its result. */
  const unavailable = (): void => {
    endFlow();
    reading += 1;
    state = "unavailable";
    connection = null;
    installations = null;
    requested = false;
    failure = null;
  };

  /** Starts following the account, once; its first frame is who is signed in now. */
  const followAccount = (): void => {
    if (options.account === undefined || person !== undefined) return;
    person = null;
    try {
      unfollow = options.account.subscribe((snapshot) => {
        const next = personOf(snapshot);
        const before = person;
        person = next;
        // Signed out, deleting, or someone else: what was read was theirs.
        if (before !== null && before !== undefined && next !== before) {
          log.info("github section reset: the account changed");
          unavailable();
          emit();
        }
      });
    } catch (error) {
      person = undefined;
      log.warn("could not follow the account", { error: message(error, "unknown") });
    }
  };

  const readInstallations = async (live: GithubBackend, token: string, mine: number) => {
    try {
      const answer = await live.installations(token);
      if (mine !== reading) return;
      if (answer.connection === "active") {
        installations = answer.installations.slice(0, ACCOUNT_GITHUB_INSTALLATIONS_MAX);
      } else if (answer.connection === "needs_reconnect" || answer.connection === "not_connected") {
        // The backend found the connection spent while reading: say so where it shows.
        const found = await live.connection(token);
        if (mine !== reading) return;
        connection = found;
        if (found?.status !== "active") installations = null;
      } else {
        // GitHub could not be read (down, limiting, no token): the list is
        // unknown, not empty. What was shown stays, with why it is stale.
        failure = flowFailure(answer.connection);
      }
    } catch (error) {
      if (mine !== reading) return;
      log.warn("could not read the GitHub installations", { error: message(error, "unknown") });
      failure = message(error, "Couldn't read your GitHub accounts.");
    }
    emit();
  };

  /** Reads the connection (and its installations); `fresh` starts the view over first. */
  const read = async (fresh: boolean): Promise<void> => {
    reading += 1;
    const mine = reading;
    if (backend === null) {
      unavailable();
      emit();
      return;
    }
    if (fresh) {
      state = "loading";
      connection = null;
      installations = null;
      if (flow === null) {
        requested = false;
        failure = null;
      }
      emit();
    }
    try {
      const token = await options.accessToken();
      if (mine !== reading) return;
      if (token === null) {
        unavailable();
        emit();
        return;
      }
      const configured = await backend.configured(token);
      if (mine !== reading) return;
      if (!configured) {
        unavailable();
        emit();
        return;
      }
      const found = await backend.connection(token);
      if (mine !== reading) return;
      state = "ready";
      connection = found;
      if (found?.status !== "active") installations = null;
      emit();
      if (found?.status === "active") await readInstallations(backend, token, mine);
    } catch (error) {
      if (mine !== reading) return;
      log.warn("could not read the GitHub connection", { error: message(error, "unknown") });
      state = "failed";
      failure = message(error, "Couldn't read your GitHub connection.");
      emit();
    }
  };

  const finish = (mine: Flow, outcome: { failure?: string; requested?: boolean }): void => {
    if (flow !== mine) return;
    flow = null;
    failure = outcome.failure ?? null;
    requested = outcome.requested ?? false;
    emit();
  };

  /** Polls the flow until it ends, the deadline passes, or it is no longer the one in flight. */
  const follow = async (live: GithubBackend, mine: Flow): Promise<void> => {
    const deadline = now() + flowTimeoutMs;
    for (;;) {
      try {
        await sleep(POLL_INTERVAL_MS, mine.abort.signal);
      } catch {
        return;
      }
      if (flow !== mine) return;
      if (now() >= deadline) {
        finish(mine, { failure: TIMED_OUT });
        return;
      }
      let row: GithubFlowRow | null;
      try {
        const token = await options.accessToken();
        if (flow !== mine) return;
        if (token === null) {
          // Signed out meanwhile: nothing of this person's is shown any more.
          unavailable();
          emit();
          return;
        }
        row = await live.flow(token, mine.flowId);
      } catch (error) {
        if (flow !== mine) return;
        if (
          (error instanceof BackendRefusedError && error.code !== null) ||
          error instanceof UnreadableAnswerError
        ) {
          finish(mine, { failure: error.message });
          return;
        }
        // In transit (offline for a moment), or a refusal with no code (the
        // backend failing, not deciding): the next tick tries again.
        log.warn("could not read the GitHub flow", { error: message(error, "unknown") });
        continue;
      }
      if (flow !== mine) return;
      if (row === null) {
        finish(mine, { failure: FLOW_GONE });
        return;
      }
      if (row.status === "pending") continue;
      if (row.status === "failed") {
        finish(mine, { failure: flowFailure(row.error) });
        if (row.error === "needs_reconnect" || row.error === "not_connected") void read(false);
        return;
      }
      log.info("github flow finished", { purpose: mine.purpose, status: row.status });
      finish(mine, { requested: row.status === "requested" });
      void read(false);
      return;
    }
  };

  const start = async (purpose: AccountGithubFlow): Promise<void> => {
    const live = requireBackend();
    followAccount();
    endFlow();
    const mine: Flow = { purpose, flowId: newFlowId(), abort: new AbortController() };
    flow = mine;
    failure = null;
    requested = false;
    emit();
    try {
      const token = await requireToken();
      const url = await live.begin(token, purpose, mine.flowId);
      // Cancelled (or replaced) while the backend answered: no browser.
      if (flow !== mine) return;
      await options.openBrowser(url);
    } catch (error) {
      if (flow !== mine) {
        // Cancelled or replaced meanwhile: nobody is waiting on this start any more.
        log.info("a cancelled GitHub start failed", { error: message(error, "unknown") });
        return;
      }
      flow = null;
      emit();
      if (
        error instanceof BackendRefusedError &&
        (error.code === "not_connected" || error.code === "needs_reconnect")
      ) {
        // The connection changed under the window: show what it is now.
        void read(false);
      }
      throw error;
    }
    if (flow !== mine) return;
    void follow(live, mine).catch((error: unknown) => {
      log.warn("following the GitHub flow failed", { error: message(error, "unknown") });
      finish(mine, { failure: "GitHub didn't finish. Try again." });
    });
  };

  return {
    subscribe(listener) {
      requireCloud();
      followAccount();
      listeners.add(listener);
      // A fresh read emits its first frame (loading, or unavailable) before
      // its first await: the listener has the snapshot now.
      void read(true);
      return () => {
        listeners.delete(listener);
      };
    },
    connect: () => start("connect"),
    install: () => start("install"),
    cancel() {
      requireCloud();
      if (flow === null) return;
      endFlow();
      emit();
    },
    async disconnect() {
      const live = requireBackend();
      const token = await requireToken();
      await live.disconnect(token);
      log.info("github disconnected");
      endFlow();
      reading += 1;
      connection = null;
      installations = null;
      requested = false;
      failure = null;
      if (state !== "unavailable") state = "ready";
      emit();
    },
    dispose() {
      endFlow();
      reading += 1;
      unfollow?.();
      unfollow = null;
      listeners.clear();
    },
  };
}
