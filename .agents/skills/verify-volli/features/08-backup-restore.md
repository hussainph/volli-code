# Local backup and restore

Use `launch --fixture basic` (cloud flag off). Doctor must prove all guards
before driving. Use current snapshot refs for every action.

1. Read `state sql "SELECT ticket_number, title, status FROM tickets ORDER BY ticket_number"`
   and project id/name/prefix/path as the baseline (four tickets, one project).
2. Settings → Storage → Backups → **Back up now**. Wait for a listed Verified
   bundle. Capture its date/size and a screenshot.
3. Home → New ticket → create a fifth ticket with a distinctive title, without
   starting a Session. Prove its row with `state sql` and screenshot.
4. Settings → Storage → restore that listed bundle. Check the project label and
   its proposed current local directory. **Prepare restore**. Wait for Ready,
   then capture the credentials sentence. Read SQL again: all FIVE tickets must
   still be live. Preparation must never replace the live profile.
5. Take a fresh snapshot of **Restart and restore**. Use
   `restore-restart <id> --gen N --ref <ref>`. This command clicks that real button
   and records only the native `app.relaunch` boundary so no unmanaged Electron
   starts. It requires a local fixture, current ref and exact button label. It
   proves a clean, unsignalled child exit and the durable product restore intent,
   then relaunches the same scratch profile and rechecks every guard.
6. Doctor again. Read SQL: the fifth ticket is gone; the four original ticket
   rows and project metadata match the baseline. Screenshot Home. In Storage,
   check that **Previous profile → Show in Finder** remains available (the shell
   recorder records the reveal, never opens Finder).
7. Read the preserved `.volli-replaced-<n>/volli.db` readonly in the owned scratch
   tree: it must retain all five tickets. Do not modify it or copy a real profile.
8. Stop the instance. Keep screenshots, the transcript, guard/quit records and
   before/after SQL as local evidence, not committed repository files.

The fake model is a boundary double; this path starts no model turn. Native
`app.relaunch` is the only additional double. Backup writing/verification,
directory proposals, staging, switch, migrations and SQLite are production code.
