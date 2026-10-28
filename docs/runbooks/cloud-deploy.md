# Runbook: Volli Cloud deployments

> **Status.** The production deployment, its R2 bucket and the WorkOS production
> environment exist and were first deployed and self-checked for 0.3.0-canary.1
> (VC-953). `dev` and `staging`, hosted deploy CI, backups and export do not exist
> yet; their sections are still the plan, not evidence.

You need a Convex team, a Cloudflare account with R2, a WorkOS account, a Google
Cloud project for people's sign-in, Node at [`.nvmrc`](../../.nvmrc), pnpm, this
checkout at the commit being deployed, and a password manager for every key.
Nothing secret goes into a ticket, chat, repository file, shell argument or log.

Behaviour is [`convex/README.md`](../../convex/README.md), schema conventions
[`convex/SCHEMA-NOTES.md`](../../convex/SCHEMA-NOTES.md). Commands use the pinned
CLI `convex@1.48.0` via `pnpm -C convex exec convex …`, which runs in `convex/`.
`<ref>` is a deployment reference (`dev`, `staging`, `prod`).

## The environments

|               | `dev`               | `staging`           | `prod`                 |
| ------------- | ------------------- | ------------------- | ---------------------- |
| Convex        | personal dev        | prod-type `staging` | project production     |
| WorkOS        | staging environment | its own             | production environment |
| R2 bucket     | `volli-dev`         | `volli-staging`     | `volli-prod`           |
| Desktop       | optional: canary    | optional: canary    | optional: stable       |

This is not an automatic channel-to-deployment mapping: the four build variables
pin one target for every channel (step 9), so pointing a canary build at `staging`
or `prod` is a deliberate manual choice, and no per-channel selection exists yet.

Record both URLs of every deployment and never derive one from the other: the
**backend** `https://<deployment>.convex.cloud` serves the Convex client, the
**site** `https://<deployment>.convex.site` serves every HTTP route
(`convex/functions/http.ts`). `resolveAccountConfig` resolves and validates all
three origins together (`backendUrl`, `siteUrl`, `storageOrigin`), and main uses
only that config; without a site URL a build cannot link a runner.

## 1. Convex: team, project, three deployments

1. `pnpm -C convex exec convex login`, then create the team and project (`volli`);
   it arrives with a **dev** and a **production** deployment.
2. Create the middle one as a production-type deployment (a dev-type one streams
   logs and error details to clients):

   ```sh
   pnpm -C convex exec convex deployment create staging --type prod
   ```

3. Deploy keys: deployment → Settings → Deploy keys. `convex deploy` cannot
   take `--deployment`, so use an **operator** key scoped to one deployment
   (later a separate CI key). Verify it can deploy, read the forbidden-variable
   probe and invoke the internal self-check; do not broaden it to other
   environments. Other operator steps use your login with `--deployment <ref>`.
   With the key exported instead (`CONVEX_DEPLOY_KEY`), omit `--deployment`: the
   key names the target, and every command below prints it (`on prod deployment
   <name>`) — check it. Blank `CONVEX_DEPLOYMENT` and `CONVEX_URL` in that shell.
   A key with only `deployment:deploy`, `env:view`, `env:write`,
   `functions:runInternalQueries`, `functions:runInternalMutations` and `logs:view`
   covers steps 2–4, 7, 8 and 10; rotating the root key (`secretKeys:rewrap`, an
   internal action) also needs `functions:runInternalActions`.
4. Keep keys in the password manager, never `convex/.env.local`: it is gitignored,
   and the fixture stops it pointing the CLI at a cloud deployment.

## 2. Deployment variables

Set values with the value **omitted** — the CLI prompts or reads stdin, so a
secret never becomes a shell argument; `--names-only` prints no values. A value
can also be pasted in the dashboard (deployment → Settings → Environment
Variables); check afterwards with `--names-only`:

```sh
pnpm -C convex exec convex env set WORKOS_CLIENT_ID --deployment <ref>
pnpm -C convex exec convex env set VOLLI_S3_SECRET_ACCESS_KEY --deployment <ref>
pnpm -C convex exec convex env list --names-only --deployment <ref>
```

| Variable | Needed for | Holds |
| --- | --- | --- |
| `WORKOS_CLIENT_ID` | Sign-in | The WorkOS environment's client id (`client_…`). Read by `functions/auth.config.ts` **at push time**; without it no WorkOS token is trusted. |
| `VOLLI_RUNNER_SIGNING_KEY`, `VOLLI_RUNNER_JWKS` | Runners | The private P-256 JWK with its `kid`, and its public JWKS as a `data:` URI (read **at push time**). Without the signing key `/runner/token` answers `issuer_unconfigured`. |
| `VOLLI_SECRETS_ROOT_KEYS` | Sealed secrets | `kid:base64key[,kid:base64key…]`, current first; without it sealed secrets answer `secrets_unavailable`. |
| `VOLLI_S3_ENDPOINT` | Transcripts, blobs | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, no path. |
| `VOLLI_S3_BUCKET`, `VOLLI_S3_ACCESS_KEY_ID`, `VOLLI_S3_SECRET_ACCESS_KEY` | Transcripts, blobs | `volli-<env>` and that bucket's token (step 5). |
| `VOLLI_S3_REGION` | Optional | Leave unset for R2; defaults to `auto`. |
| `GITHUB_APP_*`, `GITHUB_WEBHOOK_SECRETS` | Optional | A GitHub App per environment (`convex/README.md`, "GitHub App"); unset, `github.config` answers `configured: false`. |

**Never set on a cloud deployment:** `VOLLI_TEST_JWKS` (it makes the test issuer
trusted, so anyone who can mint a token for it can act as any user; the test-only
functions refuse to run where it is absent), nor the fixture's
`VOLLI_CONVEX_TEST_PRIVATE_KEY`, `VOLLI_CONVEX_ADMIN_KEY` and `CONVEX_SELF_HOSTED_*`.
`WORKOS_CLIENT_ID` and `VOLLI_RUNNER_JWKS` are read at **push time**: set both before
the first push, and push again after changing either.

## 3. The runner signing key pair

A linked runner exchanges its refresh credential at `POST /runner/token` for a
15-minute ES256 token this deployment signs (issuer `https://runners.volli.app`,
audience `volli-runner`); Agent tokens use the same key. Generate a **separate pair per
environment**, outside the repository, printing only the public JWKS. Run this
block from the repository root in Bash; it keeps that working directory:

```sh
(
set -e
umask 077
KEY_DIR="$(mktemp -d)"
export KEY_DIR
node -e '
const { generateKeyPairSync } = require("node:crypto");
const fs = require("node:fs");
const kid = "volli-runner-1";
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pub = { ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" };
fs.writeFileSync(require("node:path").join(process.env.KEY_DIR, "runner-signing.jwk"), JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid }));
fs.writeFileSync(require("node:path").join(process.env.KEY_DIR, "runner-jwks.datauri"), "data:text/plain;charset=utf-8;base64," + Buffer.from(JSON.stringify({ keys: [pub] })).toString("base64"));
'
printf 'Escrow, then remove this private file: %s\n' "$KEY_DIR/runner-signing.jwk"
cat "$KEY_DIR/runner-signing.jwk" | pnpm -C convex exec convex env set VOLLI_RUNNER_SIGNING_KEY --deployment <ref>
cat "$KEY_DIR/runner-jwks.datauri" | pnpm -C convex exec convex env set VOLLI_RUNNER_JWKS --deployment <ref>
)
```

Move the file into the password manager and delete it. To rotate, list the next public
key in `VOLLI_RUNNER_JWKS` alongside the current one, push, then switch
`VOLLI_RUNNER_SIGNING_KEY`; runners refresh within 15 minutes.

## 4. The secrets root key

Team secrets are sealed with AES-256-GCM under per-Workspace (and per-person) data
keys, each stored only wrapped, under a root key this deployment holds. Once per
environment:

```sh
# From the repository root in Bash.
(
set -e
umask 077
KEY_DIR="$(mktemp -d)"
export KEY_DIR
node -e 'const fs=require("node:fs"); fs.writeFileSync(require("node:path").join(process.env.KEY_DIR, "root-key.txt"), "k1:" + require("node:crypto").randomBytes(32).toString("base64"))'
printf 'Escrow, then remove this private file: %s\n' "$KEY_DIR/root-key.txt"
cat "$KEY_DIR/root-key.txt" | pnpm -C convex exec convex env set VOLLI_SECRETS_ROOT_KEYS --deployment <ref>
)
```

Escrow the file with the other recovery material and delete it; a lost root key loses
every sealed value, while env-var secrets are unaffected. Rotate by putting the new key
first and the old one after it (`k2:…,k1:…`), then
`pnpm -C convex exec convex run secretKeys:rewrap '{}' --deployment <ref>`; when no
`secretKeys` row names the old `kid`, drop it — values are never re-encrypted, only data
keys. A KMS can hold the root key instead (`RootKeyProvider`; `convex/README.md`,
"Secrets root key"). Never reuse a key between environments.

## 5. Cloudflare R2

Create `volli-dev`, `volli-staging`, `volli-prod`. Do **not** enable public access,
an `r2.dev` subdomain or a custom domain: the backend signs for the S3 endpoint and
every read is a presigned GET it authorised against Session visibility. A
jurisdictional bucket has its own endpoint (`.eu.`, `.us.`, `.fedramp.`). Create one
**R2 API token per environment**, **Object Read & Write**, scoped to that bucket —
not "Admin Read & Write". To rotate, create the next token, set the two credentials,
then revoke the old one.

Keys are written and stored verbatim (`packages/shared/src/cloud/r2-keys.ts`);
readers never re-derive them. Delete only the two staging prefixes:

| Prefix | Holds | Delete after |
| --- | --- | --- |
| `v1/p/<projectId>/` | Session history (packs, spills, Pi log segments, event archives), project blobs, environment run logs, config bundles | never |
| `v1/w/<workspaceId>/`, `v1/u/<userId>/` | Workspace and person blobs and config bundles | never |
| `v1/x/<exportId>/` | Parts of an export bundle | 7 days |
| `v1/m/<migrationId>/` | A migration's staging | 30 days |

An expired pack is not a cache miss: its index row still names the key and the
Session's history stops being readable. Leave R2's built-in abort of incomplete
multipart uploads (seven days) alone: a row is committed only after the object's
bytes and SHA-256 are in place, and committed keys are immutable.

A packaged build's renderer origin is `volli-app://bundle`
(`apps/desktop/src/main/app-protocol.ts`, a `standard` and `secure` custom scheme).
The window only downloads today, so add exactly this in Settings → CORS Policy →
JSON:

```json
[
  {
    "AllowedOrigins": ["volli-app://bundle"],
    "AllowedMethods": ["GET"]
  }
]
```

`GET` is `sessionTranscript.presignGet` (a committed pack or a spilled body); a
cross-origin GET needs `Access-Control-Allow-Origin` even with no request headers.
A built unpackaged app loads the same `volli-app://bundle` origin; only one run on
the Vite dev server (`ELECTRON_RENDERER_URL`) would need its `http://localhost:<port>`
origin as well. Acceptance of the custom-scheme origin must be verified against the
real bucket; R2 answers a preflight from the bucket policy without credentials:

```sh
# Expect 204 with Access-Control-Allow-Origin: volli-app://bundle; another
# origin, or PUT, must answer 403.
curl -sS -o /dev/null -D - -X OPTIONS -H 'Origin: volli-app://bundle' \
  -H 'Access-Control-Request-Method: GET' \
  'https://<ACCOUNT_ID>.r2.cloudflarestorage.com/volli-<env>/v1/p/probe'
```

A window reads R2 only for a spilled body (over 64 KiB) or a pack whose staging rows
have expired, an hour after packing; a Session's recent history is served from
Convex. Prove a real window GET on history older than that hour.

If the origin is rejected, stop and resolve a supported, reviewed desktop-origin
policy; do not widen to `"*"` or make the bucket public to chase the symptom. A policy can take 30 seconds to apply, and an expired presign answers `403
ExpiredRequest` with no CORS headers — presigns live five minutes.

A renderer upload would need `PUT` and `content-type` added here; uploads are the
runner's today (it sends no `Origin`), so a window upload's CORS is future work.

## 6. WorkOS

The desktop runs the browser flow as a **public client** (PKCE, no secret in the
app) and sends the access token to the backend
(`apps/desktop/src/main/account/workos.ts`); a deployment trusts only the
environment named by its `WORKOS_CLIENT_ID`. WorkOS gives a workspace one staging
and one production environment, fully separate: use staging for `dev`, production
for `prod`, and for `staging` either a separate environment if you can get one or a
recorded decision to share production's user base.

The application's client id (`client_…`) is this deployment's `WORKOS_CLIENT_ID` and
the build's `VOLLI_BUILD_WORKOS_CLIENT_ID`. On its **Redirects** tab add the loopback
redirect the desktop uses — it listens on a random port at `127.0.0.1` and answers
only `GET /auth/callback` with a matching `state`
(`apps/desktop/src/main/account/loopback.ts`, RFC 8252 §7.3):

```
http://127.0.0.1:*/auth/callback
```

WorkOS permits a wildcard port for loopback addresses and `http://127.0.0.1` even in
production, for native clients; confirm it in this dashboard. There is no custom
scheme or `volli-app://` redirect, and the request always sends
`code_challenge_method=S256` and names the provider (`GoogleOAuth`/`GitHubOAuth`).

Create a Google OAuth client of type **Web application**; its authorized redirect URI
is the value WorkOS shows in Authentication → OAuth providers → Google → Manage —
copy it, don't construct it. Paste its id and secret there, save, and publish the app
(an app in testing shows "Access Blocked"). WorkOS's defaults exist only in staging.
**GitHub** is optional: the same pattern with an OAuth App (callback is WorkOS's
GitHub redirect URI, `user:email` granted) or a GitHub App (Email addresses: read).
Neither provider's credentials belong in this repository, a build input or a variable.

`profileFromIdentity` (`convex/functions/lib/auth.ts`) reads `email`, `email_verified`
and `name`, so each environment needs a JWT template (Authentication → Features → JWT
Template) rendered into every access token:

```json
{
  "email": {{ user.email }},
  "email_verified": {{ user.email_verified }},
  "name": "{{ user.first_name }} {{ user.last_name }}"
}
```

It must render to an object of at most 3072 bytes; `iss`, `sub`, `exp`, `iat`, `nbf`
and `jti` are reserved. Only a verified email matches an email grant in the invite
gate (`convex/SCHEMA-NOTES.md`, "Invite-only preview").

## 7. Push the backend

Backend before desktop, always: `accounts.ensureViewer` accepts optional `inviteCode`
and `acceptedAgreementVersion`; Convex rejects unknown arguments, so a newer desktop
against an older backend fails, while an old canary cannot accept the current preview
agreement at all.

This step requires VC-951's checked-deploy entry point. If the selected commit
has no `deploy:checked` script or `health:deploymentChecks`, stop; a bare deploy
is not a substitute. Tests and codegen drift must pass before this command.

```sh
# Bash, from the repository root. Keep this shell out of tracing/debug mode.
read -rsp 'operator deploy key: ' CONVEX_DEPLOY_KEY; export CONVEX_DEPLOY_KEY
pnpm -C convex deploy:checked
unset CONVEX_DEPLOY_KEY
```

Reading it into the environment keeps the key out of shell history. The `prod:`
or `dev:` deploy key decides the single target; preview keys and caller deploy
flags are refused. The wrapper blanks other target selectors, refuses a target
that trusts `VOLLI_TEST_JWKS` **before** pushing, pushes functions/indexes/schema
with codegen disabled (committed output must already be current), then runs the
cloud self-check on the same target. A failed post-push check does not roll back
the deployed code: fix the reported configuration before serving users.

## 8. Self-check the deployment

VC-951's internal `health:deploymentChecks` takes optional `mode` (default
`cloud`). Only a deployment-admin caller can run it. After that change lands,
the exact independent recheck is:

```sh
pnpm -C convex exec convex run health:deploymentChecks '{"mode":"cloud"}' --deployment <ref>
```

Require `{ok:true, mode:"cloud", deployment:"remote", problems:[]}`. An unsafe
deployment throws `deployment_unsafe` and the CLI exits non-zero; its report
contains variable names and problem codes, never values. It refuses a test issuer
or a missing required variable from step 2. Test mode is only for loopback and is
refused on a hosted deployment; it cannot replace the cloud check. These are
presence checks, not proof that the keys, providers or storage actually work.
If the function is not available yet, this gate remains **blocking**.

The names-only inventory and HTTP-route probe below are diagnostics, not a passing
self-check. If `VOLLI_TEST_JWKS` is present, stop, unset it and push the auth config
again through the checked command before serving users.

```sh
pnpm -C convex exec convex env list --names-only --deployment <ref>
curl -sS -o /dev/null -w '%{http_code}\n' -X POST '<explicit-site-url>/runner/link'
```

`404` from the probe means the site URL is wrong or the push did not land; a `4xx` from
the route itself (`/runner/link` takes JSON only) is the good answer: `400` with
`{"error":{"code":"invalid_request","message":"Send the body as application/json."}}`.

## 9. The desktop build: inputs, launch, tokens

`.github/workflows/release.yml` reads four repository **variables** (`vars.…`) in both
desktop build steps, dry-run and publishing, and compiles them into main:

| GitHub repository variable | Value |
| --- | --- |
| `VOLLI_BUILD_WORKOS_CLIENT_ID` | `client_…`, identical to that deployment's `WORKOS_CLIENT_ID` |
| `VOLLI_BUILD_CONVEX_URL` | `https://<deployment>.convex.cloud` |
| `VOLLI_BUILD_CONVEX_SITE_URL` | `https://<deployment>.convex.site` |
| `VOLLI_BUILD_STORAGE_ORIGIN` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |

They pin the published desktop's target for **every** channel, canary and stable, with
no runtime override. All four empty is an unconfigured build; any partial set **fails
the build**. The owner sets all four only after the self-check passes, never to a dev
fixture or loopback target. A staging-targeted build is a manual run with those values —
there is no automatic channel-specific selection yet. This is build plumbing only.

The build's rules (`packagedCloudConfig` in `apps/desktop/src/main/deployment-config.ts`,
called from `apps/desktop/vite.config.ts`): the three URL values are exact HTTPS
origins — a path, credentials, query, hash or wildcard is rejected, while a trailing slash is
accepted and normalised away; public values only, never a deploy key, signing key, S3
secret or root key; a packaged build reads only the compiled config and never
`process.env`; one build names one environment, and a `staging` build never falls back
to `prod`. An unpackaged build reaches a real environment through its runtime
environment (`VOLLI_ACCOUNT_PROVIDER=workos`, `VOLLI_WORKOS_CLIENT_ID`,
`VOLLI_CONVEX_URL`, `VOLLI_CONVEX_SITE_URL`, `VOLLI_CLOUD_STORAGE_ORIGIN`); a packaged
build ignores every one.

### A dev check against a real deployment

Use the reviewed `volli-drive --deployment` launch path for an **unpackaged** build.
It supplies those runtime inputs without changing the release build or any of the four
GitHub variables. The default launch stays local; `--cloud` stays a loopback-only fixture.
There is no automatic target selection from shell variables, release channel or a missing
profile. Packaged apps are refused before any build or spawn, and packaged runtime config
still ignores the environment.

Create a **gitignored**, checkout-local `.scratch/deployments/staging.json`:

```json
{
  "name": "staging",
  "convexUrl": "https://<staging-deployment>.convex.cloud",
  "siteUrl": "https://<staging-deployment>.convex.site",
  "workosClientId": "client_<staging-public-id>",
  "storageOrigin": "https://<staging-account-id>.r2.cloudflarestorage.com"
}
```

Only `dev`, `staging` and `prod` are supported names. The profile's `name` must match;
a profile labelled `prod` cannot be used as a staging alias. All four values are required,
origins must be exact HTTPS origins, and unknown fields are rejected. Never put deploy
keys, WorkOS API keys, signing keys, S3 credentials or tokens in a profile. Do not commit
profiles or evidence. Verify the deployment name/URLs against the operator inventory:
public URLs alone cannot tell the driver whether an arbitrary backend is production.

```sh
alias volli-drive='node apps/desktop/e2e/volli-drive/cli.mjs'
volli-drive launch --deployment staging --fixture empty
# Or supply ALL four flags instead of a file (no partial merge/fallback):
volli-drive launch --deployment staging --fixture empty \
  --convex-url 'https://<staging-deployment>.convex.cloud' \
  --site-url 'https://<staging-deployment>.convex.site' \
  --workos-client-id 'client_<staging-public-id>' \
  --storage-origin 'https://<staging-account-id>.r2.cloudflarestorage.com'
```

Production requires **both** `--deployment prod --confirm-prod` on every new launch,
including flag-only launches; the confirmation is never read from a file or environment.
The matching file is `.scratch/deployments/prod.json` with `"name": "prod"`. Do not
label production inputs as staging. The mode can write real data after sign-in; use a
non-prod deployment for rehearsals and a dedicated test account/Workspace.

The instance keeps the normal keychain traps, mock Chromium keychain, isolated HOME,
userData, database, socket and per-instance sealing keys. Sign-in is **real WorkOS PKCE**,
not the fixture issuer. No deploy/admin key is needed or inherited. The model remains
fake by default; use `--model env` only when intentionally testing real provider calls.

Drive the sign-in button in Settings → Account, then:

```sh
volli-drive doctor vd-xxxxxx
volli-drive sign-in-url vd-xxxxxx  # recorded URL only; nothing opens or follows it
# Open that URL yourself in a browser (private window recommended) and sign in.
# Once the app offers Restart to open Volli Cloud:
volli-drive restart vd-xxxxxx     # same isolated profile, guard proved again
volli-drive doctor vd-xxxxxx
# Drive the actual check, then always clean up:
volli-drive stop vd-xxxxxx
```

The browser request is recorded rather than opened by the harness. Authentication and
preview access are the normal deployment's gates; this mode bypasses neither. Fixture
sign-in, simulated power and backend setup commands remain unavailable to a real target.
`stop` removes scratch, including the instance's sealed sign-in; evidence survives under
`.scratch/volli-drive/<id>/`. Inspect/redact it before sharing: it can contain account or
Workspace data and authorization URLs.

**Launch, CSP and tokens.** `CloudLaunch` keeps `store: "cloud"` as the legacy wire
discriminator for the Convex store and adds `deployment?: "cloud" | "local"` and
`siteUrl?: string | null`; new launches name both, older bridges omit them. The window's
CSP sources are composed by main from the chosen launch and the config's storage origin
— exactly those origins, never a derived one. Runner tokens come from an injected source
(`RunnerConnectionDeps.tokens`, one per linked connection): today the hosted exchange on
the site URL, later an in-process issuer for an embedded deployment, which is **not
wired**. The window's Convex client gets a short-lived access token from main on demand
(`account.accessToken`); the refresh token never leaves main.

## 10. The gates, and the order

Deploying a backend turns nothing on for anyone. With `cloud` off, no cloud surface is
enabled and the app behaves exactly as today (`docs/experimental-flags.md`). On a
**stable** build, stored flags and environment opt-ins cannot bypass preview access:
only a launch-time check returning `previewAccess: "granted"` enables cloud for that
launch, and missed, waitlisted or unreachable accounts leave the local board unchanged
(past its two-second deadline, the local app opens). Canary and dev builds keep the
switch. Grants are deployment-admin data:

```sh
pnpm -C convex exec convex run previewAccess:set '{"kind":"email","value":"person@example.com","enabled":true}' --deployment <ref>
```

An email grant matches only the verified email of the account that actually signs
in: Google's account chooser may pick another signed-in account, so test a granted
address in a private window. Codes are single-use and stored only as a hash; send
them through a trusted channel, never a ticket or chat. Revoke with `"enabled":false`. Rules:
`convex/SCHEMA-NOTES.md`, "Invite-only preview". Order: deploy the backend, grant the
first people, then publish the build that names it.

## Not implemented (follow-ups)

**Hosted deploy CI.** No workflow deploys this backend; `release.yml` wiring the four
build variables (step 9) is build plumbing, not deploy CI. Intended shape: staging on
merge to `main`, prod on a release tag with manual approval, drift and tests first, a
per-environment CI key from GitHub environment secrets, and a refusal of any target
with `VOLLI_TEST_JWKS` set. Step 7 is manual until then.

**Backup, restore and full export.** Nothing schedules a backup, and there is no drill. A
Convex backup, or
`pnpm -C convex exec convex export --path <dir> --include-file-storage --deployment <ref>`,
holds table documents (`<table>/documents.jsonl`, plus `_storage/`) and nothing else: no
code, environment variables, scheduled functions or R2 objects. Index rows name R2 keys
verbatim, so a restore without the bucket restores references to missing bytes — keep a
deployment and its bucket together. A restore drill (export → import into a scratch
deployment → check a Session's history against its packs) has not been run. Full-workspace
export — one versioned archive of a Convex snapshot plus `v1/p/`, `v1/w/`, `v1/u/`,
skipping `v1/x/` and `v1/m/` — does not exist, and is **not** the local `volli-backup`
bundle ([`docs/backup-bundle.md`](../backup-bundle.md)).

**Logs, inventory, self-check.** `--type prod` for `staging` is the current answer to log
and error exposure; production log redaction and an automated variable inventory remain.
VC-951 supplies the checked-deploy/self-check commands above; their availability and
actual hosted results must be verified before this preparation becomes a deployment.

## Rescue a stuck project move (deployment operators only)

Use this only when a move's importer can no longer drive it (lost Workspace
role/membership, preview access or account). With deployment-admin credentials,
select the intended deployment explicitly:

```sh
pnpm -C convex exec convex run projectImports:rescue '{"moveId":"<move-uuid>","action":{"kind":"abort"}}' --deployment <ref>
pnpm -C convex exec convex run projectImports:rescue '{"moveId":"<move-uuid>","action":{"kind":"reassign","userId":"<replacement-user-uuid>","runnerId":"<their-runner-uuid>"}}' --deployment <ref>
```

Abort marks the hidden move `aborting` for the purge chain; until that chain is
deployed it remains marked for purge. Reassignment requires an active owner/admin
of the **same Workspace**, with live preview access and their own non-revoked
runner. It explicitly grants that person access to the hidden imported history.
They resume the existing move via `projectImports.status`, using its `driver` for
authorization and its **unchanged `importTarget`** for row mapping and manifest
verification. Existing rows, Session ownership, runner placement and manifest
counts/digests are not rewritten. Private Sessions still belong to their original
owner after commit; this does not transfer Session ownership or make a departed
person's runner usable. If the project must instead land under the replacement's
identity/runner, abort, await `purged`, then start a fresh move with a new manifest.
Do not begin a new move or recompute the promise while resuming this one. Replaying
`begin` uses the replacement's driver runner and the original manifest promise.
Ordinary client calls recheck the replacement's
live access; the former driver cannot drive it even if access is restored.

Every rescue records the operator action in `auditLog`, not the identity of the
admin-key holder; record that operator identity in your incident log. Account loss
(including deletion) does not transfer ownership: the original user ids stay on
the history, including for any account-retention cleanup. Use abort rather than
reassign if the history should be erased instead of preserved.

Committed moves, purged
moves and gone Workspaces are refused, and a purge already started cannot be
reassigned. Uncommitting a committed move remains its driver's operation, not an
operator escape hatch. Workspace owners/admins cannot call this internal function.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| WorkOS sign-in works, backend answers unauthenticated | `WORKOS_CLIENT_ID` missing, or a different WorkOS environment than the build's client id. It is read at push time: set it, push again. |
| `/runner/token` answers `issuer_unconfigured` | No `VOLLI_RUNNER_SIGNING_KEY`; no credential was spent. |
| Live text arrives; settled packs fail | Storage: bucket CORS, `VOLLI_BUILD_STORAGE_ORIGIN` or a key mismatch. Live chunks and staged inline bodies never touch the store. |
| Deploy targets the wrong deployment | The deploy key decides the target: check the name the CLI prints. |

Widening a credential, bucket, lifecycle rule or CORS origin to chase a symptom is the
wrong fix: the narrow value is the design.
