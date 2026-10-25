#!/usr/bin/env node
/**
 * Mint a gateway grant for running the Worker locally under `wrangler dev`.
 *
 *   VOLLI_DEV_PROVIDER_KEY=sk-ant-… pnpm --filter @volli/gateway dev:grant \
 *     --provider anthropic --api anthropic-messages --upstream https://api.anthropic.com
 *
 * The first run writes `.dev.vars` (the Worker's local issuer JWKS and sealing
 * keyring, which `wrangler dev` reads) and `.dev-issuer.json` (the issuer's
 * private key, kept so later runs mint grants the same Worker accepts). Both
 * are gitignored and hold throwaway keys, never a production secret.
 *
 * It prints the grant, the base URL to point an SDK at, and an example call.
 * The provider key is read from the environment so it never lands in shell
 * history; it is sealed into the grant and only the Worker can open it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { GatewayApi } from "@volli/shared/cloud";

import {
  createDevIssuer,
  createDevSealingKey,
  type DevIssuer,
  type DevRoute,
  type DevSealingKey,
  mintDevGrant,
} from "./dev-credentials.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const varsPath = resolve(root, ".dev.vars");
const statePath = resolve(root, ".dev-issuer.json");
// GATEWAY_APIS, spelled here because this script imports no runtime value from
// @volli/shared (Node's type stripper cannot resolve its extensionless imports).
const APIS = [
  "anthropic-messages",
  "openai-responses",
  "openai-completions",
] as const satisfies readonly GatewayApi[];

const { values } = parseArgs({
  // `pnpm run x -- --flag` forwards the `--` itself; accept it either way.
  args: process.argv.slice(2).filter((arg, index) => index > 0 || arg !== "--"),
  options: {
    provider: { type: "string", default: "anthropic" },
    api: { type: "string", default: "anthropic-messages" },
    upstream: { type: "string", default: "https://api.anthropic.com" },
    connection: { type: "string" },
    port: { type: "string", default: "8787" },
  },
});

const api = values.api as DevRoute["api"];
if (!(APIS as readonly string[]).includes(api)) {
  console.error(`--api must be one of ${APIS.join(", ")}`);
  process.exit(2);
}
const providerKey = process.env.VOLLI_DEV_PROVIDER_KEY;
if (!providerKey) {
  console.error("Set VOLLI_DEV_PROVIDER_KEY to the provider API key to seal into the grant.");
  process.exit(2);
}

let state: { issuer: DevIssuer; sealingKey: DevSealingKey };
if (existsSync(statePath)) {
  state = JSON.parse(readFileSync(statePath, "utf8"));
} else {
  state = { issuer: await createDevIssuer(), sealingKey: await createDevSealingKey() };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  const vars = [
    `GATEWAY_ISSUER=${state.issuer.issuer}`,
    `GATEWAY_JWKS='${state.issuer.jwks}'`,
    `GATEWAY_SEALING_KEYS='${state.sealingKey.keyring}'`,
  ];
  writeFileSync(varsPath, `${vars.join("\n")}\n`, { mode: 0o600 });
  console.error(`Wrote ${varsPath} and ${statePath}. Restart \`wrangler dev\` if it is running.`);
}

const connectionId = values.connection ?? crypto.randomUUID();
const { token } = await mintDevGrant({
  issuer: state.issuer,
  sealingKey: state.sealingKey,
  routes: [
    { providerId: values.provider, connectionId, upstream: values.upstream, api, key: providerKey },
  ],
});
const baseUrl = `http://127.0.0.1:${values.port}/v1/c/${connectionId}`;
console.log(
  JSON.stringify({ connectionId, baseUrl, grant: token, expiresInSeconds: 600 }, null, 2),
);
console.error(
  `\nExample:\n  curl -N ${baseUrl}/v1/messages -H "x-api-key: $GRANT" -H "x-volli-call-id: $(uuidgen | tr A-Z a-z)" \\\n` +
    `    -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \\\n` +
    `    -d '{"model":"claude-haiku-4-5","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"hi"}]}'`,
);
