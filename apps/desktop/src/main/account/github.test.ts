/**
 * The account's GitHub half (VC-897) over a stand-in for Convex's HTTP
 * functions API: the real caller and codec (`convexCaller`,
 * `convexGithubBackend`) on a fake `fetch`, so each test sees the paths,
 * kinds and bearer tokens main actually sends.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import {
  OperationUnavailableError,
  type AccountGithubSnapshot,
  type AccountSnapshot,
} from "@volli/shared";

import { BackendRefusedError, convexCaller } from "./backend";
import { convexGithubBackend, createGithubService, type GithubServiceOptions } from "./github";

const FLOW_ID = "0f8e7d6c-5b4a-4c3e-9d1b-6b4c3a1e2a9f";

const ACTIVE = {
  status: "active",
  githubUserId: "9",
  login: "dana",
  name: "Dana",
  updatedAt: 1,
};

const INSTALLATION = {
  installationId: "42",
  accountId: "7",
  accountLogin: "acme",
  accountType: "org",
  repositorySelection: "selected",
  suspended: false,
  projects: 0,
  visible: true,
  configureUrl: "https://github.com/organizations/acme/settings/installations/42",
};

/** A value; a refusal (`code` absent: one with no typed code); or `offline`: the fetch rejects. */
type Answer = { value: unknown } | { code?: string; message: string } | "offline";
type Route = (args: Record<string, string>) => Answer | Promise<Answer>;

interface Seen {
  readonly kind: string;
  readonly path: string;
  readonly args: Record<string, string>;
  readonly authorization: string | null;
}

/** Convex's HTTP functions API, answering each function path from `routes`. */
function convex(routes: Record<string, Route>) {
  const seen: Seen[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const kind = String(url).replace(/^.*\/api\//u, "");
    const body = JSON.parse(String(init?.body)) as {
      path: string;
      args: Record<string, string>;
    };
    // A poll that never ends is a failing test, not a full heap.
    if (seen.length > 100) throw new Error("too many backend calls");
    const headers = new Headers(init?.headers);
    seen.push({
      kind,
      path: body.path,
      args: body.args,
      authorization: headers.get("authorization"),
    });
    const route = routes[body.path];
    if (route === undefined) return new Response("{}", { status: 404 });
    const answer = await route(body.args);
    if (answer === "offline") throw new TypeError("fetch failed");
    const payload =
      "value" in answer
        ? { status: "success", value: answer.value, logLines: [] }
        : {
            status: "error",
            errorMessage: answer.message,
            errorData:
              answer.code === undefined
                ? { message: answer.message }
                : { code: answer.code, message: answer.message },
            logLines: [],
          };
    return new Response(JSON.stringify(payload), {
      status: "value" in answer ? 200 : 400,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetch: fetchImpl as typeof fetch, seen };
}

/** A queue of answers for one path; the last repeats. */
function sequence(...answers: Answer[]): Route {
  return () => (answers.length > 1 ? answers.shift()! : answers[0]!);
}

/** An answer the test releases when it chooses: the fetch stays in flight until then. */
function held() {
  let release: ((answer: Answer) => void) | null = null;
  const route: Route = () =>
    new Promise<Answer>((resolve) => {
      release = resolve;
    });
  return {
    route,
    inFlight: () => release !== null,
    answer: (answer: Answer) => release!(answer),
  };
}

function service(routes: Record<string, Route>, overrides: Partial<GithubServiceOptions> = {}) {
  const backend = convex(routes);
  const opened: string[] = [];
  const frames: AccountGithubSnapshot[] = [];
  const log = { info: vi.fn(), warn: vi.fn() };
  const github = createGithubService({
    enabled: () => true,
    backend: convexGithubBackend(
      convexCaller({ url: "https://deployment.example/", fetch: backend.fetch }),
      log,
    ),
    log,
    accessToken: async () => "tok",
    openBrowser: (url) => void opened.push(url),
    newFlowId: () => FLOW_ID,
    // A real turn of the event loop between polls, so timers (and waitFor) run.
    sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    ...overrides,
  });
  const latest = () => frames.at(-1)!;
  const calls = (path: string) => backend.seen.filter((seen) => seen.path === path).length;
  return { github, backend, opened, frames, latest, calls, log };
}

/** Lets every timer and fetch already queued run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

const CONFIGURED = { value: { configured: true, slug: "volli", webUrl: "https://github.com" } };
const installations = (...rows: unknown[]): Answer => ({
  value: { connection: "active", installations: rows },
});
const flowRow = (status: string, error: string | null = null): Answer => ({
  value: { purpose: "connect", status, error, accountLogin: null },
});
/** What `github:installations` answers when GitHub could not be read: nothing listed. */
const unread = (connection: string): Answer => ({ value: { connection, installations: [] } });

function signedIn(
  userId: string | null,
  deletionPurgeAfter: number | null = null,
): AccountSnapshot {
  return {
    state: "signed-in",
    provider: "dev",
    signingInWith: null,
    account: { displayName: "Dana", email: null, userId, deletionPurgeAfter, backend: "synced" },
    failure: null,
  };
}

/** The account service, as far as the GitHub half follows it. */
function accountFeed(first: AccountSnapshot) {
  let listener: ((snapshot: AccountSnapshot) => void) | null = null;
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((next: (snapshot: AccountSnapshot) => void) => {
    listener = next;
    next(first);
    return unsubscribe;
  });
  return { subscribe, unsubscribe, push: (snapshot: AccountSnapshot) => listener!(snapshot) };
}

describe("the account's GitHub half", () => {
  it("connects: opens the browser, polls its flow to done, then shows the connection", async () => {
    const connection = sequence({ value: null }, { value: ACTIVE });
    const t = service({
      "github:config": () => CONFIGURED,
      "github:connection": connection,
      "github:beginConnect": () => ({
        value: { url: "https://github.com/login/oauth/authorize?state=x" },
      }),
      "github:flow": sequence(
        { value: { purpose: "connect", status: "pending", error: null, accountLogin: null } },
        { value: { purpose: "connect", status: "done", error: null, accountLogin: null } },
      ),
      "github:installations": () => installations(INSTALLATION),
    });
    t.github.subscribe((snapshot) => void t.frames.push(snapshot));
    expect(t.frames[0]).toMatchObject({ state: "loading" });
    await vi.waitFor(() => expect(t.latest()).toMatchObject({ state: "ready", connection: null }));

    await t.github.connect();
    expect(t.opened).toEqual(["https://github.com/login/oauth/authorize?state=x"]);
    await vi.waitFor(() =>
      expect(t.latest()).toEqual({
        state: "ready",
        connection: { status: "active", login: "dana", name: "Dana" },
        installations: [
          {
            installationId: "42",
            accountLogin: "acme",
            accountType: "org",
            repositorySelection: "selected",
            suspended: false,
            configureUrl: INSTALLATION.configureUrl,
          },
        ],
        waiting: null,
        requested: false,
        failure: null,
      }),
    );
    expect(t.frames.some((frame) => frame.waiting === "connect")).toBe(true);
    // The flow the browser was sent on is the one main follows; every call carries the token.
    expect(t.backend.seen.map(({ kind, path, args }) => [kind, path, args])).toEqual([
      ["query", "github:config", {}],
      ["query", "github:connection", {}],
      ["action", "github:beginConnect", { flowId: FLOW_ID }],
      ["query", "github:flow", { flowId: FLOW_ID }],
      ["query", "github:flow", { flowId: FLOW_ID }],
      ["query", "github:config", {}],
      ["query", "github:connection", {}],
      ["action", "github:installations", {}],
    ]);
    expect(new Set(t.backend.seen.map(({ authorization }) => authorization))).toEqual(
      new Set(["Bearer tok"]),
    );
  });

  it("surfaces a flow that failed with the backend's reason, and stops waiting", async () => {
    const t = service({
      "github:config": () => CONFIGURED,
      "github:connection": () => ({ value: null }),
      "github:beginConnect": () => ({ value: { url: "https://github.com/login/oauth/authorize" } }),
      "github:flow": () => ({
        value: {
          purpose: "connect",
          status: "failed",
          error: "account_already_linked",
          accountLogin: null,
        },
      }),
    });
    t.github.subscribe((snapshot) => void t.frames.push(snapshot));
    await vi.waitFor(() => expect(t.latest().state).toBe("ready"));
    await t.github.connect();
    await vi.waitFor(() =>
      expect(t.latest()).toMatchObject({
        waiting: null,
        connection: null,
        failure: "This GitHub account is connected to another Volli account.",
      }),
    );
  });

  it("installs: an install GitHub left requested is marked, and the list is read again", async () => {
    const list = sequence(installations(), installations(INSTALLATION));
    const t = service({
      "github:config": () => CONFIGURED,
      "github:connection": () => ({ value: ACTIVE }),
      "github:beginInstall": () => ({
        value: { url: "https://github.com/apps/volli/installations/select_target" },
      }),
      "github:flow": () => ({
        value: { purpose: "install", status: "requested", error: null, accountLogin: null },
      }),
      "github:installations": list,
    });
    t.github.subscribe((snapshot) => void t.frames.push(snapshot));
    await vi.waitFor(() => expect(t.latest()).toMatchObject({ installations: [] }));
    await t.github.install();
    expect(t.opened).toEqual(["https://github.com/apps/volli/installations/select_target"]);
    await vi.waitFor(() =>
      expect(t.latest()).toMatchObject({
        waiting: null,
        requested: true,
        installations: [{ accountLogin: "acme" }],
      }),
    );
    // beginInstall names no Workspace: the desktop has none to give yet.
    expect(t.backend.seen.find(({ path }) => path === "github:beginInstall")?.args).toEqual({
      flowId: FLOW_ID,
    });
  });

  it("refuses an install without a connection, and reads the connection again", async () => {
    const t = service({
      "github:config": () => CONFIGURED,
      "github:connection": () => ({ value: null }),
      "github:beginInstall": () => ({ code: "not_connected", message: "Connect GitHub first." }),
    });
    t.github.subscribe((snapshot) => void t.frames.push(snapshot));
    await vi.waitFor(() => expect(t.latest().state).toBe("ready"));
    const refused = t.github.install();
    await expect(refused).rejects.toThrow(BackendRefusedError);
    await expect(refused).rejects.toThrow("Connect GitHub first.");
    expect(t.opened).toEqual([]);
    expect(t.latest().waiting).toBeNull();
    await vi.waitFor(() =>
      expect(t.backend.seen.filter(({ path }) => path === "github:connection")).toHaveLength(2),
    );
  });

  it("surfaces a refused disconnect and keeps the connection", async () => {
    const t = service({
      "github:config": () => CONFIGURED,
      "github:connection": () => ({ value: ACTIVE }),
      "github:installations": () => installations(),
      "github:disconnect": sequence(
        { code: "github_unavailable", message: "GitHub is unavailable. Try again." },
        { value: null },
      ),
    });
    t.github.subscribe((snapshot) => void t.frames.push(snapshot));
    await vi.waitFor(() => expect(t.latest()).toMatchObject({ installations: [] }));
    await expect(t.github.disconnect()).rejects.toThrow("GitHub is unavailable. Try again.");
    expect(t.latest().connection).toMatchObject({ login: "dana" });

    await t.github.disconnect();
    expect(t.latest()).toMatchObject({ state: "ready", connection: null, installations: null });
  });

  it("stops polling on cancel, and drops the flow's late answer", async () => {
    let wake: (() => void) | null = null;
    const t = service(
      {
        "github:config": () => CONFIGURED,
        "github:connection": () => ({ value: null }),
        "github:beginConnect": () => ({ value: { url: "https://github.com/login" } }),
        "github:flow": () => ({
          value: { purpose: "connect", status: "done", error: null, accountLogin: null },
        }),
      },
      {
        sleep: (_ms, signal) =>
          new Promise<void>((resolve, reject) => {
            wake = resolve;
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      },
    );
    t.github.subscribe((snapshot) => void t.frames.push(snapshot));
    await vi.waitFor(() => expect(t.latest().state).toBe("ready"));
    await t.github.connect();
    await vi.waitFor(() => expect(wake).not.toBeNull());
    expect(t.latest().waiting).toBe("connect");
    t.github.cancel();
    expect(t.latest()).toMatchObject({ waiting: null, failure: null });
    wake!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(t.backend.seen.some(({ path }) => path === "github:flow")).toBe(false);
    // Quiet when nothing is in flight.
    t.github.cancel();
  });

  it("gives up after the flow's lifetime with a sentence, not silence", async () => {
    let clock = 0;
    const t = service(
      {
        "github:config": () => CONFIGURED,
        "github:connection": () => ({ value: null }),
        "github:beginConnect": () => ({ value: { url: "https://github.com/login" } }),
        "github:flow": () => {
          clock += 400;
          return {
            value: { purpose: "connect", status: "pending", error: null, accountLogin: null },
          };
        },
      },
      { now: () => clock, flowTimeoutMs: 1_000 },
    );
    t.github.subscribe((snapshot) => void t.frames.push(snapshot));
    await vi.waitFor(() => expect(t.latest().state).toBe("ready"));
    await t.github.connect();
    await vi.waitFor(() =>
      expect(t.latest()).toMatchObject({
        waiting: null,
        failure: "GitHub didn't finish in time. Start again.",
      }),
    );
    expect(t.backend.seen.filter(({ path }) => path === "github:flow")).toHaveLength(3);
  });

  it("has no section without a GitHub App, while signed out, or with no backend", async () => {
    const unconfigured = service({ "github:config": () => ({ value: { configured: false } }) });
    unconfigured.github.subscribe((snapshot) => void unconfigured.frames.push(snapshot));
    await vi.waitFor(() => expect(unconfigured.latest().state).toBe("unavailable"));

    const signedOut = service({}, { accessToken: async () => null });
    signedOut.github.subscribe((snapshot) => void signedOut.frames.push(snapshot));
    await vi.waitFor(() => expect(signedOut.latest().state).toBe("unavailable"));
    await expect(signedOut.github.connect()).rejects.toThrow("Sign in to Volli first.");
    expect(signedOut.backend.seen).toEqual([]);

    const frames: AccountGithubSnapshot[] = [];
    const none = createGithubService({
      enabled: () => true,
      backend: null,
      accessToken: async () => "tok",
      openBrowser: () => {},
    });
    none.subscribe((snapshot) => void frames.push(snapshot));
    expect(frames.map(({ state }) => state)).toEqual(["unavailable"]);
    await expect(none.install()).rejects.toThrow("no Volli Cloud backend");
  });

  it("says when the connection could not be read, and when GitHub could not list accounts", async () => {
    const failed = service({ "github:config": () => ({ code: "boom", message: "Broken." }) });
    failed.github.subscribe((snapshot) => void failed.frames.push(snapshot));
    await vi.waitFor(() =>
      expect(failed.latest()).toMatchObject({ state: "failed", failure: "Broken." }),
    );

    // GitHub limiting requests lists nothing: that is not "no accounts".
    const limited = service({
      "github:config": () => CONFIGURED,
      "github:connection": () => ({ value: ACTIVE }),
      "github:installations": () => unread("github_rate_limited"),
    });
    limited.github.subscribe((snapshot) => void limited.frames.push(snapshot));
    await vi.waitFor(() =>
      expect(limited.latest()).toMatchObject({
        state: "ready",
        installations: null,
        failure: "GitHub is limiting requests. Try again in a few minutes.",
      }),
    );

    // The backend found the connection spent while listing: it shows as needing a reconnect.
    const spent = service({
      "github:config": () => CONFIGURED,
      "github:connection": sequence(
        { value: ACTIVE },
        { value: { ...ACTIVE, status: "needs_reconnect" } },
      ),
      "github:installations": () => ({
        value: { connection: "needs_reconnect", installations: [] },
      }),
    });
    spent.github.subscribe((snapshot) => void spent.frames.push(snapshot));
    await vi.waitFor(() =>
      expect(spent.latest()).toMatchObject({
        connection: { status: "needs_reconnect" },
        installations: null,
      }),
    );
  });

  it("keeps the list shown when a later read finds GitHub down, and says it is stale", async () => {
    const t = service({
      "github:config": () => CONFIGURED,
      "github:connection": () => ({ value: ACTIVE }),
      "github:beginInstall": () => ({ value: { url: "https://github.com/apps/volli" } }),
      "github:flow": () => flowRow("done"),
      "github:installations": sequence(installations(INSTALLATION), unread("github_unavailable")),
    });
    t.github.subscribe((snapshot) => void t.frames.push(snapshot));
    await vi.waitFor(() => expect(t.latest().installations).toHaveLength(1));
    await t.github.install();
    await vi.waitFor(() =>
      expect(t.latest()).toMatchObject({
        waiting: null,
        installations: [{ accountLogin: "acme" }],
        failure: "Couldn't reach GitHub. Try again.",
      }),
    );
  });

  it("skips an installation row it cannot read, and never shows a link that is not a web page", async () => {
    const t = service({
      "github:config": () => CONFIGURED,
      "github:connection": () => ({ value: ACTIVE }),
      "github:installations": () =>
        installations(
          { ...INSTALLATION, installationId: "41", configureUrl: "javascript:alert(1)" },
          INSTALLATION,
          { ...INSTALLATION, installationId: "43", accountType: "enterprise" },
          "not a row",
        ),
    });
    t.github.subscribe((snapshot) => void t.frames.push(snapshot));
    await vi.waitFor(() =>
      expect(t.latest()).toMatchObject({
        installations: [{ installationId: "42" }],
        failure: null,
      }),
    );
    expect(t.latest().installations).toHaveLength(1);
    expect(t.log.warn).toHaveBeenCalledWith("skipped unreadable GitHub installations", {
      skipped: 3,
    });
  });

  it("refuses a list whose connection it cannot read", async () => {
    const t = service({
      "github:config": () => CONFIGURED,
      "github:connection": () => ({ value: ACTIVE }),
      "github:installations": () => ({
        value: { connection: "something_new", installations: [INSTALLATION] },
      }),
    });
    t.github.subscribe((snapshot) => void t.frames.push(snapshot));
    await vi.waitFor(() =>
      expect(t.latest()).toMatchObject({
        installations: null,
        failure: "Volli Cloud answered with GitHub details this build cannot read.",
      }),
    );
  });

  it("ends a flow whose answer it cannot read instead of polling it forever", async () => {
    const t = service({
      "github:config": () => CONFIGURED,
      "github:connection": () => ({ value: null }),
      "github:beginConnect": () => ({ value: { url: "https://github.com/login" } }),
      "github:flow": () => ({ value: { purpose: "connect", status: "finished" } }),
    });
    t.github.subscribe((snapshot) => void t.frames.push(snapshot));
    await vi.waitFor(() => expect(t.latest().state).toBe("ready"));
    await t.github.connect();
    await vi.waitFor(() =>
      expect(t.latest()).toMatchObject({
        waiting: null,
        failure: "Volli Cloud answered with GitHub details this build cannot read.",
      }),
    );
    expect(t.backend.seen.filter(({ path }) => path === "github:flow")).toHaveLength(1);
  });

  it("refuses every call with cloud off", async () => {
    const t = service({}, { enabled: () => false });
    expect(() => t.github.subscribe(() => {})).toThrow(OperationUnavailableError);
    await expect(t.github.connect()).rejects.toThrow(OperationUnavailableError);
    await expect(t.github.disconnect()).rejects.toThrow(OperationUnavailableError);
    expect(() => t.github.cancel()).toThrow(OperationUnavailableError);
    expect(t.backend.seen).toEqual([]);
  });
});

describe("the GitHub flow's lifecycle", () => {
  const notConnected = {
    "github:config": () => CONFIGURED,
    "github:connection": () => ({ value: null }) as Answer,
    "github:beginConnect": () => ({ value: { url: "https://github.com/login" } }) as Answer,
  };

  it("goes unavailable when the access token is gone mid-poll, and polls no more", async () => {
    let token: string | null = "tok";
    const t = service(
      {
        ...notConnected,
        "github:flow": () => {
          token = null;
          return flowRow("pending");
        },
      },
      { accessToken: async () => token },
    );
    t.github.subscribe((snapshot) => void t.frames.push(snapshot));
    await vi.waitFor(() => expect(t.latest().state).toBe("ready"));
    await t.github.connect();
    await vi.waitFor(() => expect(t.latest().state).toBe("unavailable"));
    await settle();
    expect(t.calls("github:flow")).toBe(1);
    expect(t.latest()).toMatchObject({ waiting: null, connection: null });
  });

  it("drops a poll's answer that lands after a cancel: nothing changes, nothing is read again", async () => {
    const poll = held();
    const t = service({ ...notConnected, "github:flow": poll.route });
    t.github.subscribe((snapshot) => void t.frames.push(snapshot));
    await vi.waitFor(() => expect(t.latest().state).toBe("ready"));
    await t.github.connect();
    // The poll's fetch is in flight, not between ticks.
    await vi.waitFor(() => expect(poll.inFlight()).toBe(true));
    t.github.cancel();
    const after = t.frames.length;
    expect(t.latest()).toMatchObject({ waiting: null, failure: null });

    poll.answer(flowRow("done"));
    await settle();
    expect(t.frames).toHaveLength(after);
    expect(t.calls("github:config")).toBe(1);
    expect(t.calls("github:flow")).toBe(1);
  });

  it("drops a poll's answer that lands after dispose", async () => {
    const poll = held();
    const t = service({ ...notConnected, "github:flow": poll.route });
    t.github.subscribe((snapshot) => void t.frames.push(snapshot));
    await vi.waitFor(() => expect(t.latest().state).toBe("ready"));
    await t.github.connect();
    await vi.waitFor(() => expect(poll.inFlight()).toBe(true));
    const before = t.frames.length;
    t.github.dispose();

    poll.answer(flowRow("done"));
    await settle();
    expect(t.frames).toHaveLength(before);
    expect(t.calls("github:config")).toBe(1);
    expect(t.calls("github:flow")).toBe(1);
  });

  it("lets a newer subscription's read win over a slow one", async () => {
    const slow = held();
    let configs = 0;
    const t = service({
      "github:config": (args) => {
        configs += 1;
        return configs === 1 ? slow.route(args) : CONFIGURED;
      },
      "github:connection": () => ({ value: ACTIVE }),
      "github:installations": () => installations(INSTALLATION),
    });
    t.github.subscribe((snapshot) => void t.frames.push(snapshot));
    await vi.waitFor(() => expect(slow.inFlight()).toBe(true));
    t.github.subscribe(() => {});
    await vi.waitFor(() => expect(t.latest().installations).toHaveLength(1));
    const before = t.frames.length;

    // The first read's answer would hide the section; it is overtaken.
    slow.answer({ value: { configured: false } });
    await settle();
    expect(t.frames).toHaveLength(before);
    expect(t.latest()).toMatchObject({ state: "ready", connection: { login: "dana" } });
  });

  it("polls through a network error to done", async () => {
    const t = service({
      ...notConnected,
      "github:connection": sequence({ value: null }, { value: ACTIVE }),
      "github:flow": sequence("offline", flowRow("done")),
      "github:installations": () => installations(),
    });
    t.github.subscribe((snapshot) => void t.frames.push(snapshot));
    await vi.waitFor(() => expect(t.latest().state).toBe("ready"));
    await t.github.connect();
    await vi.waitFor(() =>
      expect(t.latest()).toMatchObject({
        waiting: null,
        connection: { login: "dana" },
        installations: [],
        failure: null,
      }),
    );
    expect(t.calls("github:flow")).toBe(2);
    expect(t.log.warn).toHaveBeenCalledWith("could not read the GitHub flow", expect.anything());
  });

  it("keeps polling through a refusal with no typed code, to done", async () => {
    const t = service({
      ...notConnected,
      "github:connection": sequence({ value: null }, { value: ACTIVE }),
      "github:flow": sequence({ message: "Server Error" }, flowRow("pending"), flowRow("done")),
      "github:installations": () => installations(),
    });
    t.github.subscribe((snapshot) => void t.frames.push(snapshot));
    await vi.waitFor(() => expect(t.latest().state).toBe("ready"));
    await t.github.connect();
    await vi.waitFor(() =>
      expect(t.latest()).toMatchObject({ waiting: null, connection: { login: "dana" } }),
    );
    expect(t.calls("github:flow")).toBe(3);
    expect(t.frames.every(({ failure }) => failure === null)).toBe(true);
  });

  it("ends on a typed refusal, a flow that is gone, or a code this build does not know", async () => {
    const refused = service({
      ...notConnected,
      "github:flow": () => ({ code: "unauthenticated", message: "Sign in again." }),
    });
    refused.github.subscribe((snapshot) => void refused.frames.push(snapshot));
    await vi.waitFor(() => expect(refused.latest().state).toBe("ready"));
    await refused.github.connect();
    await vi.waitFor(() =>
      expect(refused.latest()).toMatchObject({ waiting: null, failure: "Sign in again." }),
    );

    const gone = service({ ...notConnected, "github:flow": () => ({ value: null }) });
    gone.github.subscribe((snapshot) => void gone.frames.push(snapshot));
    await vi.waitFor(() => expect(gone.latest().state).toBe("ready"));
    await gone.github.connect();
    await vi.waitFor(() =>
      expect(gone.latest()).toMatchObject({
        waiting: null,
        failure: "Volli Cloud lost track of that GitHub link. Start again.",
      }),
    );
    expect(gone.calls("github:flow")).toBe(1);

    const unknown = service({
      ...notConnected,
      "github:flow": () => flowRow("failed", "something_new"),
    });
    unknown.github.subscribe((snapshot) => void unknown.frames.push(snapshot));
    await vi.waitFor(() => expect(unknown.latest().state).toBe("ready"));
    await unknown.github.connect();
    await vi.waitFor(() =>
      expect(unknown.latest()).toMatchObject({
        waiting: null,
        failure: "GitHub didn't finish. Try again.",
      }),
    );
  });

  it("does not surface a start that failed after it was cancelled", async () => {
    const begin = held();
    const t = service({ ...notConnected, "github:beginConnect": begin.route });
    t.github.subscribe((snapshot) => void t.frames.push(snapshot));
    await vi.waitFor(() => expect(t.latest().state).toBe("ready"));
    const connecting = t.github.connect();
    await vi.waitFor(() => expect(begin.inFlight()).toBe(true));
    t.github.cancel();
    begin.answer({ code: "github_unavailable", message: "GitHub is unavailable." });
    await expect(connecting).resolves.toBeUndefined();
    expect(t.opened).toEqual([]);
    expect(t.latest()).toMatchObject({ waiting: null, failure: null });
  });

  it("resets when the account signs out, starts a deletion, or becomes someone else", async () => {
    const account = accountFeed(signedIn("u1"));
    const poll = held();
    const t = service({ ...notConnected, "github:flow": poll.route }, { account });
    t.github.subscribe((snapshot) => void t.frames.push(snapshot));
    await vi.waitFor(() => expect(t.latest().state).toBe("ready"));
    expect(account.subscribe).toHaveBeenCalledOnce();
    // The same person again (a refresh of their snapshot) changes nothing.
    account.push(signedIn("u1"));
    expect(t.latest().state).toBe("ready");

    await t.github.connect();
    await vi.waitFor(() => expect(poll.inFlight()).toBe(true));
    account.push(signedIn("u2"));
    expect(t.latest()).toEqual({
      state: "unavailable",
      connection: null,
      installations: null,
      waiting: null,
      requested: false,
      failure: null,
    });
    const after = t.frames.length;
    // The old person's flow answers late: dropped, and nothing is read for anyone.
    poll.answer(flowRow("done"));
    await settle();
    expect(t.frames).toHaveLength(after);
    expect(t.calls("github:config")).toBe(1);

    // The new person's window subscribes again and reads afresh.
    t.github.subscribe((snapshot) => void t.frames.push(snapshot));
    await vi.waitFor(() => expect(t.latest().state).toBe("ready"));
    expect(account.subscribe).toHaveBeenCalledOnce();
    account.push(signedIn("u2", Date.UTC(2026, 10, 24)));
    expect(t.latest().state).toBe("unavailable");

    // Restored, then signed out.
    account.push(signedIn("u2"));
    t.github.subscribe(() => {});
    await vi.waitFor(() => expect(t.latest().state).toBe("ready"));
    account.push({ ...signedIn(null), state: "signed-out", account: null });
    expect(t.latest().state).toBe("unavailable");

    t.github.dispose();
    expect(account.unsubscribe).toHaveBeenCalledOnce();
  });

  it("still works when the account cannot be followed", async () => {
    const t = service(
      { "github:config": () => CONFIGURED, "github:connection": () => ({ value: null }) },
      {
        account: {
          subscribe: () => {
            throw new Error("cloud is off");
          },
        },
      },
    );
    t.github.subscribe((snapshot) => void t.frames.push(snapshot));
    await vi.waitFor(() => expect(t.latest().state).toBe("ready"));
    expect(t.log.warn).toHaveBeenCalledWith("could not follow the account", {
      error: "cloud is off",
    });
  });
});
