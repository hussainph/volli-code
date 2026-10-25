/**
 * The deployment's HTTP routes (`<deployment>.convex.site`). Each area adds
 * its routes here and keeps its handlers in its own module.
 */

import { httpRouter } from "convex/server";

import { RUNNER_HTTP_PATHS } from "@volli/shared/cloud";

import { link, linkPoll, linkStart, token } from "./runnerHttp";

const http = httpRouter();

// Runner linking and the runner-token exchange (runnerHttp.ts).
http.route({ path: RUNNER_HTTP_PATHS.link, method: "POST", handler: link });
http.route({ path: RUNNER_HTTP_PATHS.linkStart, method: "POST", handler: linkStart });
http.route({ path: RUNNER_HTTP_PATHS.linkPoll, method: "POST", handler: linkPoll });
http.route({ path: RUNNER_HTTP_PATHS.token, method: "POST", handler: token });

export default http;
