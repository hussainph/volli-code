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
  roles and statuses, Session visibility, Working copy states, link kinds) come
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
   event kind; job kind; Session `visibilityReason`; the Actor's `via`,
   `reason` and `was`.
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
13. Workspace and Member writes record an Actor in `auditLog` (`workspace.*`,
    `policy.updated`, `invite.*`, `member.*`) with an `auditEntry` id, through
    `lib/audit.ts`. `detail` is typed JSON from that helper rather than a
    shared codec (nothing outside `convex/` reads it yet), and never holds an
    invite token; only the token's sha256 is stored.
14. `workspaces.activeMemberCount` stays on the Workspace row, as designed:
    Member changes are rare next to the reads that want it. It is recounted
    from the active Member rows in every Member transaction rather than
    incremented, so it cannot drift.
15. Workspace, Member and invite mutations carry no `commandId`. Each is
    idempotent by its target state (a role, a status), a create by the
    client's id, an invite acceptance by the invite. The exception is a lost
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
    `runnerJobs.payload` is provisional until the runner work types each kind
    in `JobPayloads` (an arrival's `automation.run` carries
    `trigger: "arrival"`, which is what a later move replaces).
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
