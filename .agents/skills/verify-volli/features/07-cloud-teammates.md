# Cloud teammates: attribution, private Sessions, read-only viewing and Share

Use the loopback cloud fixture and two isolated `volli-drive` instances with
**different** `--cloud-subject` and `--cloud-email` values. Grant preview access to
each fixture email. Build with `VOLLI_CLOUD_LOOPBACK=1`. Never use a real profile
or deployment for this recipe.

## Setup (not proof)

- Create two accounts with distinct display names, a project and a ticket in
  the first account's Workspace, and an email invitation for the second.
- Sign in through each instance's Settings → Account, accept the Preview
  Agreement, follow the recorded dev sign-in URL using `cloud-sign-in-browser`,
  and restart through the supervisor.
- The second account joins through Settings → Workspace → Invitations to you.
  Join opens the team's Workspace.
- Before choosing a folder on the first instance, call the drive socket's
  `cloud-checkout-folder` boundary double. Choose that scratch folder in the UI.

## Drive and assert

1. The first account opens **New chat**, types a distinctive message and sends
   it. The fake model replies. A new draft must have a composer before a durable
   Session exists. Once accepted, the row and header show the private lock.
2. On the second account, inspect the listing, board and command palette search.
   The private Session must not appear; its title and transcript must not be
   exposed. Read `sessions.list` as both fixture users for backend evidence:
   only the owner receives that Session while it is private.
3. On the owner, use **Session sharing → Share with workspace…** (or the tab or
   row context menu). Confirm names the Workspace, includes subagents and says
   that sharing cannot be undone. Cancel once and verify no visibility change.
4. Confirm **Share**. The backend now returns the shared Session to both users;
   the second account's row shows the owner's initials and the shared marker.
   Open it: the transcript loads, but no message box, answer form or stop control
   is offered. The boundary says **Only Name can send to this Session.**
5. Hover and keyboard-pin the teammate's peek. It may open the conversation,
   but must not offer Send/Answer or reveal a reply field.
6. Post a ticket comment through the second account's UI. It says **You** there
   and the second person's name on the first account. The first account must
   not see Edit/Delete on the other person's comment. Activity names the actor
   rather than collapsing everyone to the viewer.

Capture screenshots, snapshots and backend reads before and after Share. Keep
all evidence in `.scratch/volli-drive/`, not tracked source. Run doctor on each
instance: active guard, eight trapped methods, no violations. Stop both instances
and the fixture backend when finished.

The departed-owner label, descendant cascade, policy override, membership
isolation and private lookup/board-event filtering also have focused renderer and
`convex-test` coverage. Do not call setup seeding proof of those UI paths.
