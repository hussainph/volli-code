/**
 * The Volli model gateway Worker. See `README.md` for what it relays, how to
 * run it locally, and what the backend and runner halves still owe it.
 */
import type { GatewayEnv, UsageBatch, WaitUntil } from "./env.ts";
import { createGateway } from "./gateway.ts";

const gateway = createGateway({
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
});

export default {
  fetch: (request: Request, env: GatewayEnv, ctx: WaitUntil) => gateway.fetch(request, env, ctx),
  queue: (batch: UsageBatch, env: GatewayEnv) => gateway.queue(batch, env),
};
