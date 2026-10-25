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
- **Closed vocabularies are literal unions built with `literals(...)`.** The
  ones a runner or client also reads (ticket statuses and priorities, board
  event kinds, job kinds and statuses, the Actor's arms and reasons, member
  roles and statuses, Session visibility and its reason, Working copy states, link kinds) come
  from `@volli/shared/cloud`, so the schema and the shared types cannot drift.
  The rest are inline in `schema.ts` for now; move a list to the shared
  package when something outside `convex/` needs to read it. Adding a value is
  an additive schema change; removing one is not possible while a document
  still holds it. Open sets (`billingTier`, `configEntries.kind`,
  `sessionEvents.kind`, `runnerEvents.kind`, attention `kind`, Stripe statuses)
  stay `v.string()`.
- **`json` fields** (`v.any()`) are validated by a shared codec inside the
  writing mutation.
- **Null, not undefined.** An absent value is `null` (`nullable(...)`),
  including every field the design marks optional. Only the four slots for
  later features are `v.optional` in this first version
  (`workspaces.ssoOrganizationId`, `workspaces.overage`, `projects.cloudSize`,
  `workspacePolicies.slots`). A field added to an existing table later is
  `v.optional`, because older rows do not have it.
- **The Actor** (`actor` in `lib/validators.ts`) mirrors `Actor` from
  `@volli/shared/cloud`; a type-level test holds them equal and a runtime test
  proves every arm is storable and an unknown arm is refused. Closed on write;
  clients read it with `readActor`, which turns an unknown arm into "Unknown".
- **Every public function requires an identity.** The exceptions are the
  `/runner/*` HTTP routes a box calls before it has one; each proves itself
  with a one-time secret instead. Start with the helpers in `lib/auth.ts`
  (`lib/runnerAuth.ts` for a runner caller); the decisions are the pure predicates in
  `@volli/shared/cloud` (`canSeeProject`, `canSeeSession`, `canManage`, …).
- **Session visibility is decided in one place.** A Session-creating write takes
  `visibility`, `visibilityReason` and `sharedAt` from `visibilityForNewSession`
  (`lib/visibility.ts`), never from its caller. A read of Sessions goes through
  `requireSessionVisible` (one) or `requireSessionScope(...).canSee` (many), and
  a read of board events through `visibleBoardEvents`, so `shareAll` is applied
  at read time and nothing writes it onto a Session. The only visibility write
  after creation is `shareSession`: `private → shared`, never back.

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
   event kind; job kind; the Actor's `via`,
   `reason` and `was`.
4. Where the design gives a shape, the field is an object rather than `json`:
   `runners.platform`, `runners.autoUpdate`, `runnerPresence.load`,
   `runnerLinkRequests.host`, `workingCopies.firstRun`, `runnerJobs.receipt`,
   `sessions.signal` and `sessions.stopped`.
5. Extra indexes for lookups the design describes: `workspaceInvites.by_email`
   (matching invites at sign-in), `clientSessions.by_provider_session`,
   `memberProjectPrefs.by_project` (project purge),
   `runnerCredentials.by_current_hash` / `by_previous_hash` (unused: the
   token exchange names its runner and reads `by_runner`),
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
8. A Session the caller may not see is reported `not_found`, not `forbidden`
   or `not_a_member`: whether a private Session exists is part of what is
   private. A project or Session in a deleted Workspace is `not_found` too.
9. Fields the design sketched as `v.optional` (for example `labels.mergedBy`,
   `sessions.signal`, `runnerJobs.lease`, `secrets.sealed`,
   `attentionItems.clearedReason`, `runners.platform.distro`) are `nullable`,
   per the null-not-undefined rule above. Switching later would need a
   migration; switching now costs nothing.
10. Besides `ensureViewer`, `accounts.viewer` is a read-only query for the
    signed-in person's own account (or `null` before the first
    `ensureViewer`), so a client can tell "signed in, not set up" from "set up".
11. `ensureViewer` creates the person and, in the same transaction, their
    personal Workspace (named after them, Free plan, default policy row, the
    person its one owner). Later calls create nothing.
12. `workspaceInvites.email` is nullable: `null` is a single-use link invite,
    accepted only with its token. An email invite is accepted only by a
    person whose verified email matches, by id or by token.
13. Workspace and Member writes, and sharing a Session, record an Actor in
    `auditLog` (`workspace.*`, `policy.updated`, `invite.*`, `member.*`,
    `session.shared`) with an `auditEntry` id, through
    `lib/audit.ts`. `detail` is typed JSON from that helper rather than a
    shared codec (nothing outside `convex/` reads it yet), and never holds an
    invite token; only the token's sha256 is stored.
14. `workspaces.activeMemberCount` stays on the Workspace row, as designed:
    Member changes are rare next to the reads that want it. It is recounted
    from the active Member rows in every Member transaction rather than
    incremented, so it cannot drift.
15. Workspace, Member and invite mutations, and `sessionVisibility.share`,
    carry no `commandId`. Each is
    idempotent by its target state (a role, a status), a create by the
    client's id, an invite acceptance by the invite, a share by the one-way
    flip (sharing a shared Session writes nothing). The exception is a lost
    reply to `invites.create` for a link: a retry leaves a second pending link
    nobody holds, which expires after 7 days (the invite lifetime) and can be
    revoked.
16. Board events gain `project_archived` and `project_unarchived` (no payload
    fields): the design names project archive but no kind for it. Board event
    kinds are written by the board functions as of this change and are frozen
    from here on.
17. Ticket signals' ids are a `signal` id kind (`SignalId`), minted by the
    caller like comment ids. Labels created by naming them on a ticket are
    minted by the backend.
18. A board receipt's `intentDigest` covers the operation, the intent AND the
    acting person, so a `commandId` reused by someone else is a conflict,
    never their replay. A replay is answered only to a viewer who can still
    see the receipt's project.
19. Comment edits and removals, label colours and pure reorders (a move
    within one column) record no board event, as on the local board; the rows
    carry `editedAt` / `deletedAt` / the new key. Comments are edited and
    removed only by their author's person.
20. The board's `json` fields are typed at compile time rather than by a
    runtime codec: `boardEvents.payload` is a `BoardEventPayload` built by
    the shared rules, `boardReceipts.reply` is the function's own reply, and
    `runnerJobs.payload` is checked by `parseJobPayload` inside `enqueueJob`
    (an arrival's `automation.run` carries `trigger: "arrival"`, which is what
    a later move replaces).
21. After a create's receipt has expired (seven days), retrying it answers
    `id_taken` rather than comparing the stored row with the intent: board
    commands from an offline runner fail fast instead of buffering, so a
    retry that late does not arise.
22. A Done move or an archive trims the ticket's ready worktrees at once
    (`availableAt` = now), as the local board does; other Working copy kinds
    are not trimmed. A move out of the active columns interrupts every
    running Session on the ticket, whoever owns it: the move is a board fact,
    and the interrupt keeps the Session and its transcript.
23. Transcript bodies (`transcripts.ts`): the runner stages bodies with its
    own `stageArtifacts` mutation, called before the `accept` that
    references them, rather than inside `accept` itself; `stageArtifactRows`
    is the helper an `accept` can share (export it) if it later carries
    them. The pack format adds two fields: a header's `missing` (bodies the
    runner could not read, whose staging rows are kept) and an entry's
    `redacted` (redaction changed the body, so `digest` is the artifact's
    identity, not this body's checksum). Pi log objects hold the range's
    lines after redaction, not its raw bytes; the offsets still name the
    source file's range. A Session in `releasing` still takes its holder's
    uploads, so a handoff can pack.
24. Board events about a Session the viewer cannot see are dropped from reads
    (`boardEventVisibility` / `visibleBoardEvents`; the activity feeds and
    `board.ticketEvents` read through it). A Session id
    carried only as attribution on a board change everyone sees (an agent
    Actor's `sessionId`, a `session` origin on a shared Session's start) is
    kept: the change and the person it acted for are board facts, and the id
    reads as `not_found` to anyone who cannot see that Session (deviation 8
    still holds for every lookup). A subagent is never shared on its own
    (`share_parent`); sharing its root carries down. `sessions.sharedAt` is
    when a Session became shared: its creation time when born shared, the
    flip's time otherwise.
25. Runner vocabularies (kind, status, install mode, link method, local
    credential kind) come from `@volli/shared/cloud` (`runners.ts`), which
    the runner-side client reads too.
26. `runnerLinkAttempts` (one row per person: a fixed window of failed
    device-code entries) is added so a code cannot be guessed, and
    `runnerLinkRequests.installMode` (optional, added with the link flow) so
    a runner linked by a device code starts with the right install mode.
27. A runner cut off for credential reuse is recorded as a `token_reuse`
    runner event and shown in the owner's runner list
    (`statusReason: credential_reuse`). It also raises a Needs-you runner
    alert for the owner (`r:{runnerId}:credential_reuse`, project-less, see
    39), cleared when they remove the runner.
28. `runnerJobs.failure` (optional, added after the first version) holds the
    job's last failure: what the runner reported, or a lease that ran out
    (`by: "backend"`). A retry keeps it, so a waiting job and a dead letter both
    say why, and a repeated failure report is recognised as a duplicate.
    `runnerJobs.lease` is kept after the lease ends: it names the lease that
    completed the job, which is what makes `complete` idempotent and fenced.
    `runnerJobs.result` is checked as plain JSON of at most 64 KiB
    (`jobResultProblem`); its kind-specific shape is checked by the work that
    reads it, once a kind has a typed result.
29. Team secrets: `secrets.sealed.kid` names the **data key** a value is
    sealed under (a `secretKeys` row), not the root key; the data key row
    names its root key (`rootKid`). `secretKeys` is added for this: one data
    key per Workspace (`w:{workspaceId}`, for Workspace and project secrets)
    and per person (`u:{userId}`), stored only wrapped, never returned by a
    query. A project that moves Workspace keeps opening its secrets (the data
    key is found by id); a value written after the move is sealed under the
    new Workspace's key. A data key is therefore never deleted while a row
    still names it: a Workspace purge must re-seal or delete a moved
    project's values before it drops the old key, or delivery for that
    project fails closed (the runner refuses to run a command without the
    set rather than run it without its secrets).
30. A secret is keyed by `(scopeKey, name)`, so `secrets.set` upserts and the
    backend mints the id of a new row (the name is the natural key a client
    retries with). Writes carry no `commandId`, like Workspace writes (15).
31. `secrets.plain` (env vars only) is returned to readers: an env var is
    plain by kind and shown in the Secrets tab. A `secret`'s value and
    ciphertext are never returned; `last4` is written only for secrets of 16
    or more characters. `requestedBySessionId` stays `null` until an agent
    can request a secret by name. A scope holds at most 100 secrets and
    64 KiB of names and values (`MAX_SECRETS_PER_SCOPE`, `MAX_SCOPE_BYTES`),
    so a resolved set stays far inside a process's environment limit.
32. Session facts and folds are stored as JSON text: `sessionEvents.payload`
    and `.provenance` hold the codec's encoding of the envelope's parts, and
    `sessionStates.state` the bounded fold's. Event payloads carry object keys
    a Convex value refuses (`$schema` in an MCP tool schema, non-ASCII keys),
    so they cross the boundary as text both ways: `sessions.accept` takes each
    fact's JSON text, `sessions.command` an intent's, and `history` and
    `snapshot` return renderer-safe JSON text.
33. `sessionStates.catchUpAt` (optional) marks a scheduled catch-up or refold
    of the fold over the accepted history; `null` once it reaches the head.
    `sessionStates.derivedThrough` (optional) is the last fact whose derived
    rows (turns, attention items, job receipts) were written, so a refold
    rebuilds the state without replaying old derived rows over newer ones.
    A stored state is read only by the fold version and event vocabulary that
    wrote it; any other is refolded from the accepted history on the next
    accept.
34. A Session started on a runner is created by its first `accept`, whose
    sequence 1 is the Engine's `session.create` command (`session.created`
    follows at 2 and must match the row).
35. **GitHub installations are global**, not owned by a Workspace (the
    design gave `githubInstallations` a `workspaceId`). A GitHub account can
    install an App only once, and its repositories serve a person's personal
    and team Workspaces alike, so the row is unique by `installationId` and
    the Workspace a repository serves is its project's. `workspaceId` and
    `by_workspace` are gone (no deployment held a row); the table gains
    `accountId` (GitHub's numeric id), the `permissions` and
    `events` snapshot, `deletedAt` and `reconciledAt`, and
    `installedByUserId` is nullable (an install started on GitHub's own page
    has no Volli person).
36. `githubConnections` gains the GitHub profile (`login`, `name`, verified
    `emails`), a `status` (`active` / `needs_reconnect` / `revoked`), the
    refresh lease and `updatedAt`, as required fields: no deployment held a
    row. The sealed tokens are nullable (forgotten on revoke). `by_github_user`
    holds one Volli account per GitHub account. The tokens are sealed under
    the person's data key (`secretKeys` owner `u:{userId}`), bound to the
    person and to the token's role.
37. Two new tables: `githubFlows` (a connect or install browser round trip,
    single use, purged an hour after it expires; a request to an
    organization's owners waits 14 days) and `githubWebhookDeliveries` (one
    row per applied delivery id, so a redelivery is a no-op; purged after
    seven days).
38. `projectRepos` gains optional `githubAccess` and `accessCheckedAt`
    (optional: rows the migration importer writes need not carry them; absent
    reads as not yet checked) and two indexes, `by_github_repo` (webhook
    routing) and `by_installation` (an installation's removal or reconcile).
39. `attentionItems` is written only by `lib/attention.ts`. Its ids are each
    producer's frozen derivation (`attention.ts` in `@volli/shared/cloud`):
    `s:{sessionId}:{sourceId}` (Session items; the backend's own source ids
    are `volli:blocked`, `volli:quarantine:{sequence}` and
    `volli:notify:{notifyId}`), `t:{ticketId}:review:{userId}` (review
    requests) and `r:{runnerId}:{alert}` (runner alerts), so a refold, a
    retry or a later board write finds the same row. Widened (expand only):
    `projectId` is `nullable` (a runner alert belongs to no project, and is
    visible to its person only); `workspaceId` (optional, nullable) is set
    only on a billing item, the same exception usage rows make; `source`
    gains `notify`; `by_ticket` (ticket, source, cleared) finds a ticket's
    open review requests.
    Visibility is decided at read time (`canSeeAttention`, membership through
    the project's current Workspace); an `access_lost` sweep after a Member is
    suspended, removed or leaves keeps stored rows honest for counts and
    pushes, and a person active there again by the time it runs keeps theirs.
40. `sessions.by_place_runner` (added with Mac re-registration) finds the
    Sessions placed on a runner, so a Mac that lost its credential and
    registers again as its successor (`registerThisMac` with
    `replacesRunnerId`) moves them in the same transaction. The predecessor
    is revoked with reason `replaced` and, like a removed runner, leaves the
    owner's list and frees its name; its Session claims pass on at the next
    generation. `runners.status` gains `asleep` (a Mac whose lid closed),
    which the offline sweep does not watch. Working-copy jobs stay with the
    replaced runner until Working copies move; that move is not part of this
    handover.
41. `runners.desktopRegistrationId` is an optional desktop registration retry
    key (a client-minted lowercase UUID); older rows and other link methods
    omit it. `registerThisMac` and `linkFromDesktop` accept optional nullable
    `registrationId` (invalid values are ignored). A matching caller-owned,
    non-gone runner with an unused generation-1 credential is returned with
    its current hash replaced by the freshly minted credential's hash, without
    creating another runner or moving work again. Used credentials and gone
    runners take the normal registration path. A Mac still heartbeating in a
    live status cannot be replaced, even when `replacesRunnerId` names it.

## Migrated rows

- `automationRuns` has optional `error` and `retryCommandId`: a migrated
  failed arrival attempt keeps its error and the command id its Retry replays
  under.
- Migrated rows are mapped by `migrationDocument` (`@volli/shared/cloud`),
  which supplies every field local history does not decide (project ship
  behaviour, a Session's open status and unfolded `usageTotals: null`, a
  Working copy's clean diff, a pre-claim delegation's `legacy:<child>` tool
  call). `test/migration.test.ts` inserts one record of every stream.
- Two known gaps, both owned by the Session intake work: a migrated root
  Session's `origin` is `user` even when an Automation started it, and the
  migration stores Session event payloads, config definitions and job
  payloads after a storability check only, not through the per-kind codecs
  the intake will apply (it classifies `kindKnown`/`quarantine` with the
  shared Session event codec before sending).
- Migrated Session event rows hold `payload` and `provenance` as values, where
  the intake stores JSON text (note 32); the intake reads both. A payload with
  a key a Convex value refuses (`$schema`, non-ASCII) cannot be imported that
  way, so the import should send them as text.

## Streamed text

Where `streamChunks` and `sessionViewers` depart from the data-model design:

- `streamChunks` gains `baseline` and `throughSequence`, and the
  `by_session_message_baseline` and `by_session_created` indexes, before
  its first writer. `baseline` marks a chunk that starts with a `reset`,
  where a late joiner starts and a reader that missed rows restarts;
  `throughSequence` is the overlay's staleness guard. Both are required,
  not `v.optional`: no row was ever written without them. `delta` is
  `v.string()`, the operations' JSON text, because their payloads carry
  object keys a Convex value refuses. An increment is capped at 16 KB as
  designed; a baseline (one `reset` of the whole message) at 64 KB, the
  inline cap of a settled body. A larger message stops streaming and shows
  whole when it settles.
- The cursor read is per Session, not `chunksSince(messageId, seq)`: one
  `streamChunks.since` finds the open streams among the Session's newest
  rows plus the reader's cursors, and starts a stream without a cursor (or
  with one a newer baseline overtook) at its latest baseline rather than at
  seq 0, so a late joiner reads at most ~10 s of rows per stream.
- `streamChunks` rows are deleted by the runner's `settle`, which names the
  settling fact's sequence and deletes once `acceptedThrough` reaches it
  — the runner knows which streams a settled fact ends, including a
  streamed text message that settles under its executor's own id; the
  accept fold learns message ids only once transcript bodies arrive with
  `accept`, and then calls the same cleanup through
  `scheduleStreamCleanup` — by the accept fold at turn end, and by a
  15-minute sweep.

## Invite-only preview

`previewAccess` is deployment-admin managed, not Workspace-admin managed.
Its natural key is `(kind, key)`: a normalized email, a Volli user UUID, or
an invite code's SHA-256. Only a verified email matches an email grant. Codes
are single-use and bind atomically to one account; retrying on that account
is harmless. No query returns codes or the allowlist. Revocation and expiry
are checked from the original grant, including after code redemption.

Deployment operators use the internal function with the Convex CLI (select
the intended deployment explicitly; these examples omit that selection):

```sh
pnpm exec convex run previewAccess:set '{"kind":"email","value":"person@example.com","enabled":true}'
pnpm exec convex run previewAccess:set '{"kind":"user","value":"<volli-user-uuid>","enabled":false}'
pnpm exec convex run previewAccess:set '{"kind":"code","value":"<random-code-at-least-16-characters>","enabled":true,"expiresAt":1900000000000}'
```

Run from `convex/`. Only deployment-admin credentials can invoke this
internal function; ordinary authenticated clients and Workspace owners
cannot. Supply codes through a trusted operator environment, not tickets or
chat. Store and share the original code securely; only its hash is retained.
Setting `enabled: false` revokes that grant; if a person holds several grants,
revoke all of them to remove access. Re-enabling a code never resets its
account binding. Expiry is optional, in epoch milliseconds; an omitted expiry
on an existing grant leaves it unchanged.

`accounts.ensureViewer` returns `previewAccess: granted | waitlisted` and
accepts an optional `inviteCode` (the desktop's sign-in pane sends it).
Waitlisted sign-ins create an account but no Workspace. The first granted
sign-in creates the personal Workspace once; optional
`users.previewWorkspaceCreated` records that setup, while older accounts
with memberships keep their existing Workspaces. Every Workspace create and
both invite-accept paths recheck the allowlist, even on idempotent replays.
Workspace invites alone do not grant preview access.

On stable desktop launches, stored flags and environment opt-ins cannot
bypass preview access. A deliberate sign-in marker permits restoring the
sealed account and checking the backend before choosing the product store;
only a fresh grant for that marker's user enables `cloud` for this launch.
The check has a two-second deadline so unreachable account I/O cannot block
the local app from opening.
Missing, waitlisted, expired, deleted, mismatched, or unreachable accounts
leave every cloud product surface off and the local board unchanged. Offline
stable launches fail closed (canary's cached-board behavior is unchanged).
The Account sign-in pane is the sole stable pre-enrollment exception on a
build with a configured provider and backend: it
shows the waitlist message without enabling cloud. Signing in or out still
requires a restart to change stores; a running window never hot-swaps.
Dev/canary flag-off launches do not read the account or launch marker.
Canary sign-ins also require invitation; already invited canary accounts
retain their existing offline cached-board launch. Invite codes are retained
only in memory during transient retries, not across app restarts.

Preview agreement acceptance is a separate release prerequisite: the legal
version and explicit server-recorded acceptance must be wired before preview
shipping. An invitation is not acceptance of the agreement.

CI holds the backend preview gate and the desktop launch gate at 100%
statements, branches, functions and lines. Backend transport tests also
prove that clients cannot call the internal admin mutation and concurrent
code redemption admits only one account.
