/**
 * The deployment's HTTP routes (`<deployment>.convex.site`). Each area adds
 * its routes here and keeps its handlers in its own module.
 */

import { httpRouter } from "convex/server";

import { GITHUB_HTTP_PATHS, RUNNER_HTTP_PATHS } from "@volli/shared/cloud";

import { oauthCallback, oauthConfirm, setup, webhook } from "./githubHttp";
import { link, linkPoll, linkStart, token } from "./runnerHttp";

const http = httpRouter();

// Runner linking and the runner-token exchange (runnerHttp.ts).
http.route({ path: RUNNER_HTTP_PATHS.link, method: "POST", handler: link });
http.route({ path: RUNNER_HTTP_PATHS.linkStart, method: "POST", handler: linkStart });
http.route({ path: RUNNER_HTTP_PATHS.linkPoll, method: "POST", handler: linkPoll });
http.route({ path: RUNNER_HTTP_PATHS.token, method: "POST", handler: token });

// The GitHub App's callback, Setup URL and webhook (githubHttp.ts).
http.route({ path: GITHUB_HTTP_PATHS.oauthCallback, method: "GET", handler: oauthCallback });
http.route({ path: GITHUB_HTTP_PATHS.oauthCallback, method: "POST", handler: oauthConfirm });
http.route({ path: GITHUB_HTTP_PATHS.setup, method: "GET", handler: setup });
http.route({ path: GITHUB_HTTP_PATHS.webhook, method: "POST", handler: webhook });

export default http;
