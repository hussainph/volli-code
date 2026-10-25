/**
 * The GitHub App's doors on the Convex site (`http.ts` routes them):
 *
 * - `GET /github/oauth/callback` — the connect flow's return: a page asking
 *   the person to confirm the Volli account; its form posts back to
 *   `POST /github/oauth/callback`, which exchanges the code (client secret +
 *   PKCE verifier), reads the person's GitHub user and verified emails, seals
 *   the pair and finishes the flow.
 * - `GET /github/setup` — the App's Setup URL, after an install, an update
 *   or an organization member's request. `installation_id` is verified
 *   against the person's own `GET /user/installations` (GitHub warns it can
 *   be spoofed); `setup_action` is a hint only.
 * - `POST /github/webhook` — signed deliveries (`githubIngest.ingest`).
 *
 * The browser routes answer a small page; the client learns the outcome from
 * its flow row. The webhook answers 202 within milliseconds; reconciles run
 * scheduled.
 */

import {
  extractGithubEvent,
  parseFlowState,
  type GithubErrorCode,
  GITHUB_HTTP_PATHS,
} from "@volli/shared/cloud";

import { internal } from "./_generated/api.js";
import { httpAction, type ActionCtx } from "./_generated/server.js";
import { flowProblem, type CompleteConnectResult } from "./githubFlows";
import { mintGithubToken } from "./githubTokens";
import { GithubApiError, githubClient } from "./lib/github/client";
import { readGithubConfig, type GithubAppConfig } from "./lib/github/config";
import { appJwt, randomSecret, sha256Base64Url, verifyWebhookSignature } from "./lib/github/crypto";
import { sealTokens, type PersonKey } from "./lib/github/seal";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
}

/** A plain page for the browser tab GitHub sent back; `form` is already-escaped markup. */
function page(title: string, body: string, status = 200, form = ""): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><meta name="viewport" content="width=device-width"><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1rem;color:#222}h1{font-size:1.25rem}button{font:inherit;padding:.4rem 1rem}</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${form}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}

const FAILURE_TEXT: Partial<Record<GithubErrorCode, string>> = {
  flow_not_found: "This link isn't valid. Start again from Volli.",
  flow_expired: "This link has expired. Start again from Volli.",
  flow_used: "This link was already used. You can return to Volli.",
  account_already_linked: "This GitHub account is connected to another Volli account.",
  installation_not_visible: "Volli couldn't confirm this installation with your GitHub account.",
  github_denied: "GitHub didn't connect. You can return to Volli and try again.",
  github_rate_limited: "GitHub is busy right now. Try again in a few minutes.",
  needs_reconnect: "Reconnect GitHub in Volli, then try again.",
  not_connected: "Connect GitHub in Volli, then try again.",
};

function failurePage(code: GithubErrorCode): Response {
  return page(
    "Volli couldn't finish",
    FAILURE_TEXT[code] ?? "GitHub is unavailable. Try again in a few minutes.",
    400,
  );
}

function apiCode(error: unknown): GithubErrorCode {
  if (error instanceof GithubApiError) {
    if (error.kind === "rate_limited") return "github_rate_limited";
    if (error.oauthError !== null || error.kind === "unauthorized") return "github_denied";
  }
  return "github_unavailable";
}

async function fail(
  ctx: ActionCtx,
  flowId: string,
  code: GithubErrorCode,
  nonce?: string,
): Promise<Response> {
  await ctx.runMutation(internal.githubFlows.fail, { flowId, code, nonce });
  return failurePage(code);
}

/** The flow a browser return names, checked against its purpose, secret and expiry. */
async function openedFlow(ctx: ActionCtx, state: string | null, purpose: "connect" | "install") {
  const parsed = parseFlowState(state);
  if (parsed === null) return { problem: "flow_not_found" as const };
  const stateHash = await sha256Base64Url(parsed.secret);
  const flow = await ctx.runQuery(internal.githubFlows.forBrowser, { flowId: parsed.flowId });
  const problem = flowProblem(flow, { purpose, stateHash, now: Date.now() });
  if (problem === "flow_expired") {
    await ctx.runMutation(internal.githubFlows.fail, { flowId: parsed.flowId, code: problem });
  }
  if (problem !== null) return { problem };
  return { problem: null, flowId: parsed.flowId, stateHash, flow: flow! };
}

function unconfigured(): Response {
  return page("GitHub isn't set up", "This Volli Cloud deployment has no GitHub App yet.", 503);
}

async function finishConnect(
  ctx: ActionCtx,
  app: GithubAppConfig,
  opened: {
    flowId: string;
    stateHash: string;
    flow: { userId: string; codeVerifier: string | null; personKey: PersonKey | null };
  },
  code: string,
): Promise<Response> {
  const nonce = randomSecret();
  const claimed = await ctx.runMutation(internal.githubFlows.claim, {
    flowId: opened.flowId,
    stateHash: opened.stateHash,
    nonce,
  });
  // A second post of the same form (a double click) while the first exchanges.
  if (claimed === "busy") return page("Connecting GitHub", "You can return to Volli.");
  if (claimed !== null) return failurePage(claimed);
  const client = githubClient(app);
  let pair, user, emails;
  try {
    pair = await client.exchangeCode(
      code,
      opened.flow.codeVerifier ?? "",
      `${app.siteUrl}${GITHUB_HTTP_PATHS.oauthCallback}`,
    );
    user = await client.user(pair.accessToken);
    emails = await client.userEmails(pair.accessToken);
  } catch (error) {
    return fail(ctx, opened.flowId, apiCode(error), nonce);
  }
  let key = opened.flow.personKey;
  // A concurrent first seal for the same person mints their key once; seal again under it.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sealed = await sealTokens(opened.flow.userId, key, pair);
    const result: CompleteConnectResult = await ctx.runMutation(
      internal.githubFlows.completeConnect,
      {
        flowId: opened.flowId,
        stateHash: opened.stateHash,
        nonce,
        githubUserId: user.githubUserId,
        login: user.login,
        name: user.name,
        emails,
        accessToken: sealed.access,
        refreshToken: sealed.refresh,
        accessExpiresAt: pair.accessExpiresAt,
        refreshExpiresAt: pair.refreshExpiresAt,
        newKey: sealed.newKey,
      },
    );
    if (result.ok) {
      return page("GitHub connected", `Connected as @${user.login}. You can return to Volli.`);
    }
    if (result.code !== null) return failurePage(result.code);
    const reread = await ctx.runQuery(internal.githubFlows.forBrowser, { flowId: opened.flowId });
    key = reread?.personKey ?? null;
  }
  return fail(ctx, opened.flowId, "github_unavailable", nonce);
}

/**
 * `GET /github/oauth/callback?code&state` (or `?error&state` when the person
 * declined): asks the person to confirm which Volli account GitHub is being
 * connected to, and only the confirm (`POST`) exchanges the code.
 *
 * The confirm is what stops a forged connect: someone could start a flow on
 * their own Volli account and send its authorize link to a victim who
 * already authorized the App (sign-in did), whose browser would come back
 * here silently. Without a click on this page naming the other account, the
 * victim's GitHub would be connected to it.
 */
export const oauthCallback = httpAction(async (ctx, request) => {
  const app = readGithubConfig();
  if (app === null) return unconfigured();
  const params = new URL(request.url).searchParams;
  const state = params.get("state");
  const opened = await openedFlow(ctx, state, "connect");
  if (opened.problem !== null) return failurePage(opened.problem);
  const code = params.get("code");
  if (params.get("error") !== null || code === null || code === "") {
    return fail(ctx, opened.flowId, "github_denied");
  }
  const form = `<form method="post" action="${GITHUB_HTTP_PATHS.oauthCallback}"><input type="hidden" name="code" value="${escapeHtml(code)}"><input type="hidden" name="state" value="${escapeHtml(state!)}"><button type="submit">Connect</button></form>`;
  const account =
    opened.flow.verifiedEmail === null
      ? "a Volli account with no verified email"
      : `the Volli account ${opened.flow.verifiedEmail}`;
  return page(
    "Connect GitHub to Volli",
    `Connect your GitHub account to ${account}? If you didn't just start this in Volli, close this tab.`,
    200,
    form,
  );
});

/** `POST /github/oauth/callback` (the confirm form): exchanges the code and finishes the flow. */
export const oauthConfirm = httpAction(async (ctx, request) => {
  const app = readGithubConfig();
  if (app === null) return unconfigured();
  // Browsers send `Origin` with a form post; only this site's own page may post it.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(app.siteUrl).origin)
    return failurePage("flow_not_found");
  const form = new URLSearchParams(await request.text());
  const opened = await openedFlow(ctx, form.get("state"), "connect");
  if (opened.problem !== null) return failurePage(opened.problem);
  const code = form.get("code");
  if (code === null || code === "") return fail(ctx, opened.flowId, "github_denied");
  return finishConnect(ctx, app, opened, code);
});

/** `GET /github/setup?installation_id&setup_action&state`. */
export const setup = httpAction(async (ctx, request) => {
  const app = readGithubConfig();
  if (app === null) return unconfigured();
  const params = new URL(request.url).searchParams;
  const installationId = params.get("installation_id");
  const state = params.get("state");
  // An install begun on GitHub's own page carries no state: the webhook
  // recorded the installation already, and installations are global.
  if (state === null || state === "") {
    return page("Volli is installed", "Open Volli to finish.");
  }
  const opened = await openedFlow(ctx, state, "install");
  if (opened.problem !== null) {
    return opened.problem === "flow_not_found"
      ? page("Volli is installed", "Open Volli to finish.")
      : failurePage(opened.problem);
  }
  if (installationId === null || !/^[1-9][0-9]{0,19}$/u.test(installationId)) {
    // An organization member's request to its owners, or a cancel.
    await ctx.runMutation(internal.githubFlows.markRequested, { flowId: opened.flowId });
    return page(
      "Request sent",
      "If you asked an organization owner to approve Volli, Volli will tell you when they do.",
    );
  }
  const mint = await mintGithubToken(ctx, opened.flow.userId);
  if (!mint.ok) return fail(ctx, opened.flowId, mint.code);
  const client = githubClient(app);
  let installation;
  try {
    const visible = await client.userInstallations(mint.token);
    if (!visible.some((facts) => facts.installationId === installationId)) {
      return fail(ctx, opened.flowId, "installation_not_visible");
    }
    installation = await client.installation(
      await appJwt(app.clientId, app.privateKey, Date.now()),
      installationId,
    );
  } catch (error) {
    return fail(ctx, opened.flowId, apiCode(error));
  }
  if (installation === null) return fail(ctx, opened.flowId, "installation_not_visible");
  const problem = await ctx.runMutation(internal.githubFlows.completeInstall, {
    flowId: opened.flowId,
    stateHash: opened.stateHash,
    installation,
  });
  if (problem !== null) return failurePage(problem);
  await ctx.scheduler.runAfter(0, internal.githubIngest.reconcileInstallation, { installationId });
  return page(
    "Volli is installed",
    `Volli is installed on ${installation.accountLogin}. You can return to Volli.`,
  );
});

/** Largest webhook body accepted (GitHub caps payloads at 25 MB; Volli's events are small). */
const MAX_WEBHOOK_BYTES = 5 * 1024 * 1024;

/** `POST /github/webhook`: signature, App id, then one ingest per delivery id. */
export const webhook = httpAction(async (ctx, request) => {
  const app = readGithubConfig();
  if (app === null) return new Response(null, { status: 503 });
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_WEBHOOK_BYTES) return new Response(null, { status: 413 });
  const signed = await verifyWebhookSignature(
    app.webhookSecrets,
    body,
    request.headers.get("x-hub-signature-256"),
  );
  // A delivery for another App (a staging one) must never land here.
  const forThisApp =
    request.headers.get("x-github-hook-installation-target-type") === "integration" &&
    request.headers.get("x-github-hook-installation-target-id") === app.appId;
  if (!signed || !forThisApp) return new Response(null, { status: 401 });
  const deliveryId = request.headers.get("x-github-delivery");
  const name = request.headers.get("x-github-event");
  if (deliveryId === null || deliveryId === "" || name === null || name === "") {
    return new Response(null, { status: 400 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return new Response(null, { status: 400 });
  }
  await ctx.runMutation(internal.githubIngest.ingest, {
    deliveryId: deliveryId.slice(0, 100),
    name: name.slice(0, 100),
    event: extractGithubEvent(name, payload),
  });
  return new Response(null, { status: 202 });
});
