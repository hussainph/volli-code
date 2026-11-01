// The fake GitHub over its real HTTP door: OAuth with PKCE, refresh rotation,
// the REST endpoints the backend calls, and git smart HTTP with the token check.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import { FAKE_GITHUB_APP, startFakeGithub } from "./server.mjs";
import { createTestCertificates } from "./tls.mjs";

const exec = promisify(execFile);
const REDIRECT = "http://127.0.0.1:9/github/oauth/callback";

let github;
let scratch;

before(async () => {
  github = await startFakeGithub();
  scratch = mkdtempSync(join(tmpdir(), "fake-github-test-"));
  gitEnv = isolatedGitEnv(scratch);
  github.addUser({ id: 7, login: "dana", name: "Dana Doe" });
  github.addUser({ id: 8, login: "eve" });
  github.createRepo("dana", "demo");
  github.addInstallation({
    id: 70,
    account: { id: 7, login: "dana" },
    repositories: [{ id: 700, owner: "dana", name: "demo" }],
    userIds: [7],
  });
});

after(async () => {
  await github.close();
  rmSync(scratch, { recursive: true, force: true });
});

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function authorizeUrl(challenge, state = "flow.secret") {
  const url = new URL(`${github.webUrl}/login/oauth/authorize`);
  url.searchParams.set("client_id", FAKE_GITHUB_APP.clientId);
  url.searchParams.set("redirect_uri", REDIRECT);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

async function token(fields) {
  const response = await fetch(`${github.webUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: FAKE_GITHUB_APP.clientId,
      client_secret: FAKE_GITHUB_APP.clientSecret,
      ...fields,
    }),
  });
  return response.json();
}

async function connect() {
  const { verifier, challenge } = pkce();
  const answer = await fetch(authorizeUrl(challenge), { redirect: "manual" });
  assert.equal(answer.status, 302);
  const back = new URL(answer.headers.get("location"));
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
  assert.equal(back.searchParams.get("state"), "flow.secret");
  return token({
    code: back.searchParams.get("code"),
    code_verifier: verifier,
    redirect_uri: REDIRECT,
  });
}

const api = (path, init = {}) => fetch(`${github.apiUrl}${path}`, init);
const bearer = (value) => ({ headers: { authorization: `Bearer ${value}` } });

test("the web flow exchanges a PKCE code once, for an expiring pair", async () => {
  const pair = await connect();
  assert.match(pair.access_token, /^ghu_/u);
  assert.match(pair.refresh_token, /^ghr_/u);
  assert.ok(pair.expires_in > 0 && pair.refresh_token_expires_in > 0);

  const { verifier, challenge } = pkce();
  const { code } = github.authorize(authorizeUrl(challenge).toString());
  const wrong = await token({ code, code_verifier: `${verifier}x`, redirect_uri: REDIRECT });
  assert.equal(wrong.error, "bad_verification_code");
  // A failed exchange spends the code, as GitHub's does.
  const again = await token({ code, code_verifier: verifier, redirect_uri: REDIRECT });
  assert.equal(again.error, "bad_verification_code");

  const other = pkce();
  const second = github.authorize(authorizeUrl(other.challenge).toString());
  const mismatch = await token({
    code: second.code,
    code_verifier: other.verifier,
    redirect_uri: "http://127.0.0.1:9/elsewhere",
  });
  assert.equal(mismatch.error, "redirect_uri_mismatch");
  assert.throws(
    () =>
      github.authorize(
        authorizeUrl(other.challenge).toString().replace(FAKE_GITHUB_APP.clientId, "nope"),
      ),
    /client_id/u,
  );
});

test("a refresh rotates the pair and ends the old access token", async () => {
  const first = await connect();
  assert.equal((await api("/user", bearer(first.access_token))).status, 200);
  const next = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token });
  assert.match(next.access_token, /^ghu_/u);
  assert.equal((await api("/user", bearer(first.access_token))).status, 401);
  assert.equal((await api("/user", bearer(next.access_token))).status, 200);
  const reused = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token });
  assert.equal(reused.error, "bad_refresh_token");
  const badClient = await fetch(`${github.webUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: FAKE_GITHUB_APP.clientId, client_secret: "x" }),
  });
  assert.equal((await badClient.json()).error, "incorrect_client_credentials");
});

test("the REST endpoints answer the user, the App and the installation", async () => {
  const { access_token: user } = await connect();
  assert.deepEqual(await (await api("/user", bearer(user))).json(), {
    id: 7,
    login: "dana",
    name: "Dana Doe",
  });
  const emails = await (await api("/user/emails", bearer(user))).json();
  assert.equal(emails[0].verified, true);
  const mine = await (await api("/user/installations", bearer(user))).json();
  assert.deepEqual(
    mine.installations.map((installation) => installation.id),
    [70],
  );
  assert.equal((await api("/user")).status, 401);

  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({ iss: FAKE_GITHUB_APP.clientId, iat: now - 30, exp: now + 540 }),
  ).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), github.privateKeyPem);
  const jwt = `${head}.${body}.${signature.toString("base64url")}`;
  assert.equal((await api("/app/installations/70", bearer(jwt))).status, 200);
  assert.equal((await api("/app/installations/71", bearer(jwt))).status, 404);
  assert.equal((await api("/app/installations/70", bearer(`${head}.${body}.AAAA`))).status, 401);
  const minted = await api("/app/installations/70/access_tokens", {
    method: "POST",
    ...bearer(jwt),
  });
  assert.equal(minted.status, 201);
  const { token: installation } = await minted.json();
  const repos = await (await api("/installation/repositories", bearer(installation))).json();
  assert.deepEqual(
    repos.repositories.map((repo) => repo.full_name),
    ["dana/demo"],
  );
  assert.equal((await api("/repositories/700", bearer(installation))).status, 200);

  const client = `Basic ${Buffer.from(`${FAKE_GITHUB_APP.clientId}:${FAKE_GITHUB_APP.clientSecret}`).toString("base64")}`;
  const check = await api(`/applications/${FAKE_GITHUB_APP.clientId}/token`, {
    method: "POST",
    headers: { authorization: client, "content-type": "application/json" },
    body: JSON.stringify({ access_token: user }),
  });
  assert.equal(check.status, 200);
  assert.equal(
    JSON.stringify(github.requests).includes(user),
    false,
    "the log never holds a token",
  );
});

const remote = (secret, user = "x-access-token") =>
  `http://${user}:${secret}@${github.origin.replace(/^http:\/\//u, "")}/dana/demo.git`;
// No system or global config, so no credential helper (a keychain) ever stores
// or supplies a credential: each clone proves only what its URL carries.
let gitEnv;
const isolatedGitEnv = (home) => ({
  ...process.env,
  HOME: home,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/bin/false",
});
const gitIn = (cwd, ...args) =>
  exec(
    "git",
    [
      "-c",
      "user.name=Agent",
      "-c",
      "user.email=agent@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, env: gitEnv },
  );

test("git clones and pushes only with x-access-token and a token that reaches the repo", async () => {
  const { access_token: dana } = await connect();
  const work = join(scratch, "clone");
  await exec("git", ["clone", "--quiet", remote(dana), work], { env: gitEnv });
  writeFileSync(join(work, "change.txt"), "from the agent\n");
  await gitIn(work, "add", "change.txt");
  await gitIn(
    work,
    "commit",
    "--quiet",
    "-m",
    "Agent change",
    "-m",
    "Co-authored-by: Volli <volli@example.test>",
  );
  await gitIn(work, "push", "--quiet", "origin", "HEAD:refs/heads/volli/e2e");
  const { stdout: head } = await gitIn(work, "rev-parse", "HEAD");
  assert.equal(github.refs("dana", "demo")["refs/heads/volli/e2e"], head.trim());
  const pushed = github.commit("dana", "demo", "refs/heads/volli/e2e");
  assert.equal(pushed.subject, "Agent change");
  assert.match(pushed.trailers, /Co-authored-by: Volli/u);
  assert.ok(
    github.requests.some(
      (entry) => entry.service === "git-receive-pack" && entry.credential === "user:dana",
    ),
  );

  const refused = async (url) => {
    const target = join(scratch, `refused-${randomBytes(3).toString("hex")}`);
    await assert.rejects(exec("git", ["clone", "--quiet", url, target], { env: gitEnv }));
  };
  await refused(`${github.origin}/dana/demo.git`);
  await refused(remote(dana, "dana"));
  await refused(remote("ghu_not_a_token"));
  // Eve is a GitHub user, but no installation she can reach holds the repo.
  const { verifier, challenge } = pkce();
  const { code } = github.authorize(authorizeUrl(challenge).toString(), 8);
  const eve = await token({ code, code_verifier: verifier, redirect_uri: REDIRECT });
  await refused(remote(eve.access_token));
});

test("with a certificate, one port answers HTTP for the backend and HTTPS for git", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-github-tls-"));
  const tls = createTestCertificates(dir, "localhost");
  const secure = await startFakeGithub({ hostname: "localhost", tls });
  try {
    secure.addUser({ id: 7, login: "dana" });
    secure.createRepo("dana", "demo");
    secure.addInstallation({
      id: 70,
      account: { id: 7, login: "dana" },
      repositories: [{ id: 700, owner: "dana", name: "demo" }],
      userIds: [7],
    });
    const access = secure.issueAccessToken(7);
    assert.match(secure.origin, /^http:\/\/localhost:\d+$/u);
    assert.equal(secure.httpsOrigin, secure.origin.replace("http:", "https:"));
    // Plain HTTP: the API, as a backend calls it.
    const user = await fetch(`${secure.apiUrl.replace("localhost", "127.0.0.1")}/user`, {
      headers: { authorization: `Bearer ${access}` },
    });
    assert.equal(user.status, 200);
    // HTTPS on the same port: git trusts the run's own CA and nothing else.
    const url = `https://x-access-token:${access}@${secure.httpsOrigin.replace("https://", "")}/dana/demo.git`;
    const work = join(dir, "clone");
    await exec("git", ["clone", "--quiet", url, work], {
      env: { ...gitEnv, GIT_SSL_CAINFO: tls.caPath },
    });
    await assert.rejects(
      exec("git", ["clone", "--quiet", url, join(dir, "untrusted")], {
        env: { ...gitEnv, GIT_SSL_CAINFO: "/dev/null" },
      }),
    );
  } finally {
    await secure.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
