# Schema notes

How `functions/schema.ts` is built, and where it departs from the data-model
design it implements. Read this before adding a table, a field or a function
that writes one.

## Conventions

- **Ids are ours.** Every entity has an `id`: a lowercase canonical UUID minted
  by whoever originates it (a client, a runner, or the backend for facts it
  originates) and checked by the writing mutation with `parseId` from
  `@volli/shared/cloud`. References between tables are these strings, stored
  with the `uuid` validator. A Convex `_id` never leaves `convex/`. Each entity
  table has a `by_uuid` index on `id` (Convex reserves `by_id`); a 1:1 side
  table is keyed by its owner's id. `test/schema.test.ts` holds this.
- **Uniqueness is enforced by the writing mutation**, with an index lookup
  before the insert. Convex has no unique constraint. A field the design calls
  "unique" has an index whose name says what it is unique by.
- **High-volume rows carry `projectId`, never `workspaceId`.** A project can
  move Workspace; the Workspace is resolved through the project. Usage and
  billing rows are the exception and keep the Workspace the spend happened in.
- **Hot fields get their own document** (counters, presence, credentials,
  intake cursors, viewer heartbeats, ticket bodies), so a list subscription
  does not re-run every time one changes.
- **No machine paths.** Absolute paths stay in the runner's local SQLite. The
  schema test fails on any field named like a path.
- **Closed vocabularies come from `@volli/shared/cloud`** (ticket statuses,
  board event kinds, job kinds, the Actor's arms and reasons, member roles, …)
  through `literals(...)`, so the schema and the shared types cannot drift.
  Adding a value is an additive schema change made in the same commit;
  removing one is not possible while a document still holds it. Open sets
  (`billingTier`, `configEntries.kind`, `sessionEvents.kind`, `runnerEvents.kind`,
  attention `kind`, Stripe statuses) stay `v.string()`.
- **`json` fields** (`v.any()`) are validated by a shared codec inside the
  writing mutation.
- **Null, not undefined.** An absent value is `null` (`nullable(...)`). The
  `v.optional` fields in this first version are slots for later features and
  JSON bags; a field added to an existing table later is `v.optional`, because
  older rows do not have it.
- **The Actor** (`actor` in `lib/validators.ts`) mirrors `Actor` from
  `@volli/shared/cloud`; a type-level test holds them equal and a runtime test
  proves every arm is storable and an unknown arm is refused. Closed on write;
  clients read it with `readActor`, which turns an unknown arm into "Unknown".
- **Every public function requires an identity.** Start with the helpers in
  `lib/auth.ts`; the decisions are the pure predicates in
  `@volli/shared/cloud` (`canSeeProject`, `canSeeSession`, `canManage`, …).

## Deviations from the design

Each was a decision made while turning the design into code.

1. `users.primaryEmail` is nullable. A purge nulls PII and keeps the row as a
   tombstone, and a sign-in identity need not carry an email claim.
2. `workspaceBlobs` and `userBlobs` are present (the design names them and
   gives them the `blobs` shape). `userPrefs.railOrder`,
   `authIdentities.createdAt` and `workspaceInvites.createdAt` are added.
3. Where the design names a closed set, the field is a literal union rather
   than a string: runner kind, status, install mode and link method; link
   request status; Working copy kind, state and first-run states; pull request
   state; ticket signal kind and verdict; ticket link kind and source; blob
   link owner kind; watch target kind; delegation status; attention source and
   cleared reason; environment run script, source, outcome and runner kind;
   Automation run trigger and status; deletion target kind and status; billing
   merchant mode; GitHub repository selection; MCP credential kind; local
   credential kind; environment `runsOn` and `requiresOs`; client kind; board
   event kind; job kind; the Actor's `via`, `reason` and `was`.
4. Where the design gives a shape, the field is an object rather than `json`:
   `runners.platform`, `runners.autoUpdate`, `runnerPresence.load`,
   `runnerLinkRequests.host`, `workingCopies.firstRun`, `runnerJobs.receipt`,
   `sessions.signal` and `sessions.stopped`.
5. Extra indexes for lookups the design describes: `workspaceInvites.by_email`
   (matching invites at sign-in), `clientSessions.by_provider_session`,
   `memberProjectPrefs.by_project` (project purge),
   `runnerCredentials.by_current_hash` / `by_previous_hash` (token exchange),
   `runnerLinkRequests.by_poll_secret`, `runnerEvents.by_at` and
   `stripeEvents.by_received` (TTL sweeps), `billingAccounts.by_stripe_customer`
   and `subscriptions.by_stripe_subscription` (webhooks), and `by_uuid` on
   `projectMoves` and `runnerInstallTokens`.
6. Board events: the `linked` / `unlinked` payloads name the link kind
   `linkKind`, because `kind` is the payload's discriminant. Only
   `worktree_changed` survives as a migrated-only kind; migrated
   `worktree_scope_changed` rows become `checkout_mode_changed`. The payloads
   of kinds new to the cloud are provisional until their first writer ships.
7. Object-storage key slots that hold derived ids (attachment ids, Pi file ids,
   export and migration parts) accept one safe path segment
   (`[A-Za-z0-9][A-Za-z0-9._:-]{0,199}`, no `..`). Config bundle revisions are
   unpadded, as designed.
8. A Session the caller may not see is reported `not_found`, not `forbidden`:
   whether a private Session exists is part of what is private.
9. `ensureViewer` creates the person only. Creating their first Workspace
   belongs to the Workspaces work, which calls it.

## Auth hook

The real sign-in provider is not wired. `auth.config.ts` trusts only the test
issuer, and only where `VOLLI_TEST_JWKS` is set. `lib/auth.ts` exports
`ProfileFromIdentity` and `profileFromIdentity`, the one place a provider's
claims become a `users` profile; the accounts work adds its provider to
`auth.config.ts` and, if its claims differ from the standard OIDC ones, passes
its own mapping to `ensureViewer`.
