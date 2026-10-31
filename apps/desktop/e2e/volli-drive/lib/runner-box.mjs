#!/usr/bin/env node
/**
 * runner-box — the fake Linux box a runner-setup acceptance run links
 * (`runner-setup-acceptance-smoke.mjs`, VC-1039).
 *
 * SIMULATION, named as one everywhere: this is not a Volli build and not the
 * `volli-runner` installer (BYO-7). It is a separate Node process that speaks
 * the REAL wire a box speaks, and injects nothing into the app:
 *
 *   1. `POST {site}/runner/link` with the one-time install token the sheet
 *      minted (`runnerHttp.ts` → `runners.linkWithInstallToken`), plus the
 *      host facts the backend validates (`parseRunnerLinkRequest`,
 *      `@volli/shared/cloud`). The reply is the runner's id, name and its
 *      first refresh credential.
 *   2. `POST {site}/runner/token` (`runners.rotateCredential` + a signed
 *      runner JWT): the rotated credential is kept in memory BEFORE the token
 *      is used, which is what a real runner must do.
 *   3. `runners.reportCapabilities`, then `runners.heartbeat` every 30 s
 *      (`RUNNER_HEARTBEAT_INTERVAL_MS`), as that runner token's Convex
 *      caller — resolved to the runner row by `convex/functions/lib/runnerAuth.ts`.
 *      The first beat is what flips `offline` to `online`.
 *
 * It trusts loopback URLs only, so it can never be pointed at a deployment.
 * It prints no secret: stdout carries NDJSON events (`{"event":"linked",…}`,
 * a failure is its stage and a documented `RUNNER_HTTP_ERROR_CODES` code —
 * never a body, a token, a credential or a JWT. The token arrives in the
 * environment (`VOLLI_RUNNER_TOKEN`, the installer's own variable), never in
 * argv where `ps` would show it.
 *
 * The harness reads `linked` and then sends one line on stdin: that is the
 * phase boundary between "linked" and "connected", so the sheet's own
 * "is linked. Waiting for it to come online…" state is deterministic rather
 * than a race against the heartbeat. SIGTERM stops it cleanly (exit 0); it
 * also stops itself after {@link DEADLINE_MS}, so a crashed harness cannot
 * leave it beating.
 */

const SITE_ENV = "VOLLI_BOX_SITE_URL";
const CONVEX_ENV = "VOLLI_BOX_CONVEX_URL";
const TOKEN_ENV = "VOLLI_RUNNER_TOKEN";

const HEARTBEAT_MS = 30_000;
const DEADLINE_MS = 10 * 60_000;

/**
 * Deliberately NOT the name typed in the sheet: if the install token's
 * name hint were lost, the backend would fall back to this hostname and the
 * runner's name would differ — which the journey then fails on.
 */
const HOSTNAME = "fake-linux-box.invalid";
// Match the installed desktop's version, so later release floors do not age this fixture out.
const VERSION = process.env.VOLLI_BOX_VERSION;
const PLATFORM = Object.freeze({
  os: "linux",
  distro: "Ubuntu 24.04 LTS",
  kernel: "6.8.0-45-generic",
  arch: "x64",
  glibc: "2.39",
});
const LOAD = Object.freeze({
  activeSessions: 0,
  activeTurns: 0,
  queueDepth: 0,
  freeDiskMb: 4096,
  freeMemMb: 2048,
});
const CAPABILITIES = Object.freeze({
  v: 1,
  nodeVersion: process.version,
  cpuCount: 4,
  memTotalMb: 8192,
  git: { version: "2.43.0" },
  docker: false,
  terminals: "available",
  browser: { state: "unavailable", reason: "a runner box has no display" },
  maxConcurrentSessions: 1,
  tools: [],
});

/** A stage and a code, and nothing that could carry a secret. */
class BoxFailure extends Error {
  constructor(stage, code) {
    super(`${stage}: ${code}`);
    this.stage = stage;
    this.code = code;
  }
}

const box = { beats: 0, stopping: false, timer: null, deadline: null };

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** {@link HOSTNAME}'s rule for the fixture backend: plain HTTP on this machine only. */
function loopback(name, raw) {
  let url;
  try {
    url = new URL(raw ?? "");
  } catch {
    throw new BoxFailure("box", "bad_backend_url");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new BoxFailure("box", "not_loopback");
  }
  return url.origin;
}

async function post(site, path, body) {
  const answer = await fetch(new URL(path, site), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: answer.status, body: await answer.json().catch(() => null) };
}

/** The documented `/runner/*` error code, or a fixed phrase: a message could echo a body. */
function errorCode(source) {
  const code = source?.error?.code ?? source?.data?.code ?? source?.code;
  return typeof code === "string" && /^[a-z_]{2,40}$/u.test(code) ? code : "unexpected_response";
}

/** One non-empty line on stdin: the harness has read `linked` and lets the box connect. */
function released() {
  return new Promise((resolve, reject) => {
    const done = (error) => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.pause();
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk) => {
      if (String(chunk).trim() !== "") done();
    };
    const onEnd = () => done(new BoxFailure("box", "released"));
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.resume();
  });
}

function stop(reason) {
  if (box.stopping) return;
  box.stopping = true;
  if (box.timer !== null) clearInterval(box.timer);
  if (box.deadline !== null) clearTimeout(box.deadline);
  process.stdout.write(`${JSON.stringify({ event: "stopped", reason, beats: box.beats })}\n`, () =>
    process.exit(0),
  );
}

/** A stage and a code on stderr (flushed before the exit), never a body or a secret. */
function fail(error) {
  const failure = error instanceof BoxFailure ? error : new BoxFailure("box", "failed");
  process.stderr.write(`${failure.stage}: ${failure.code}\n`, () => process.exit(1));
}

async function main() {
  // Registered first: a SIGTERM anywhere (even mid-link) is still a clean stop.
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  box.deadline = setTimeout(() => stop("deadline"), DEADLINE_MS);

  if (typeof VERSION !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/u.test(VERSION)) {
    throw new BoxFailure("box", "missing_version");
  }
  const installToken = process.env[TOKEN_ENV];
  if (!installToken || !installToken.startsWith("vrt_")) {
    throw new BoxFailure("box", "missing_install_token");
  }
  const site = loopback(SITE_ENV, process.env[SITE_ENV]);
  const convexUrl = loopback(CONVEX_ENV, process.env[CONVEX_ENV]);

  const link = await post(site, "/runner/link", {
    installToken,
    host: { hostname: HOSTNAME, platform: PLATFORM, installMode: "user" },
    // No `name`: the name typed in the sheet (the token's hint) must win.
    name: null,
  });
  if (link.status !== 200) throw new BoxFailure("link", errorCode(link.body));
  const grant = link.body ?? {};
  if (
    typeof grant.runnerId !== "string" ||
    typeof grant.name !== "string" ||
    typeof grant.credential !== "string" ||
    !grant.credential.startsWith("vrc_")
  ) {
    throw new BoxFailure("link", "unexpected_response");
  }
  emit({
    event: "linked",
    runnerId: grant.runnerId,
    name: grant.name,
    generation: grant.generation,
  });

  await released();
  // The harness letting go of stdin is a stop too: never outlive it.
  process.stdin.on("end", () => stop("stdin"));
  process.stdin.on("close", () => stop("stdin"));
  process.stdin.resume();

  const exchange = await post(site, "/runner/token", {
    runnerId: grant.runnerId,
    // A box that loses this reply must link again: nothing re-reads the old one.
    credential: grant.credential,
  });
  if (exchange.status !== 200) throw new BoxFailure("token", errorCode(exchange.body));
  const token = exchange.body ?? {};
  if (
    typeof token.token !== "string" ||
    token.token.split(".").length !== 3 ||
    typeof token.credential !== "string" ||
    !(token.expiresAt > token.serverTime)
  ) {
    throw new BoxFailure("token", "unexpected_response");
  }
  // Persisted before use, the order a runner owes the backend's reuse detection.
  emit({
    event: "token",
    generation: token.generation,
    rotated: token.credential !== grant.credential,
    ttlMs: token.expiresAt - token.serverTime,
    expiresAt: token.expiresAt,
    serverTime: token.serverTime,
  });

  const [{ ConvexHttpClient }, { makeFunctionReference }] = await Promise.all([
    import("convex/browser"),
    import("convex/server"),
  ]);
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(token.token);

  const report = {
    version: VERSION,
    platform: PLATFORM,
    installMode: "user",
    capabilities: CAPABILITIES,
    localCredentials: [],
  };
  const reported = await client
    .mutation(makeFunctionReference("runners:reportCapabilities"), { report })
    .catch((error) => {
      throw new BoxFailure("report", errorCode(error));
    });
  emit({ event: "reported", changed: reported?.changed === true, version: VERSION });

  const bootId = `sim-${crypto.randomUUID()}`;
  const beat = async () => {
    if (box.stopping) return;
    const reply = await client
      .mutation(makeFunctionReference("runners:heartbeat"), { bootId, load: LOAD })
      .catch((error) => {
        throw new BoxFailure("heartbeat", errorCode(error));
      });
    box.beats += 1;
    emit({
      event: box.beats === 1 ? "online" : "beat",
      status: reply?.status ?? null,
      beats: box.beats,
    });
  };
  await beat();
  box.timer = setInterval(() => void beat().catch(fail), HEARTBEAT_MS);
}

main().catch(fail);
