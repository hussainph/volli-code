# Workspace icons — VC-489 lab proposal

Open `pnpm lab`, then `/lab/#workspace-icons` (“Workspace icons · identity & attention”).
This is a fixture-only prototype. It changes neither the shipped workspace rail nor real read receipts.

## Study 02 — the workspace atelier

The creative follow-up lives at `/lab/#workspace-identity-studio` (“Workspace atelier · a little character”). Study 01 links to it; both remain independently reviewable.

- Four material studies: **Etched** (a carved canvas keycap), **Porcelain** (a glyph in a circular inset), **Orbit** (a tiny planet with its own ring), and **Letterpress** (a printed identity seal).
- A 24-mark Phosphor library with a fuzzy searchable picker and three collision-aware, name-based suggestions. Suggestions and search are **local and deterministic**, not model output. No project name leaves the browser, no decision service is called, and there is no provider setup or inference cost.
- Initials are treated as a first-class signature: Editorial, Architect, and Woven. Procedural mirrored stamps are keyed by the draft's stable identity plus an explicit variation, not the project name.
- Local PNG/JPEG/WebP marks, limited to 2 MB and decoded before adoption. SVG and arbitrary remote URLs are not accepted. Replacing the choice or leaving the scratch cancels the meaning of an in-flight image read. The file input resets so the same file can be retried after a failure.
- “Make it mine” commits the current name, mark, material, and canvas **only into the local rail rehearsal**. It creates or updates one fixture, never a real project. Editing the draft afterward does not change the saved mark. Renaming or requesting suggestions does not silently replace the selected glyph, and visiting another identity mode remembers the last choice in each mode.
- The oversized preview tilts under a fine mouse pointer using a gesture spring (0.5s, bounce 0.2). Pointer-driven choices reveal through transform/opacity transitions (200ms, the existing `--ease-out`). Hover feedback is a tiny 2px lift at 160ms. Keyboard choices are immediate; reduced motion and the explicit Motion off control remove movement. No ambient loop or animated navigation target was added.

This deliberately stretches the visual language inside the lab: editorial display type, tactile frames, large preview objects, and whimsical orbital decoration. It does **not** stretch the notification meanings. The 36px rail rehearsal still separates identity, selection, unread, and Session state exactly as Study 01 does.

## Production adoption — picked-folder onboarding

The atelier now supplies the production creation editor, shared marks, and shared pure identity model. Preview the actual editor at modal scale in `/lab/#workspace-onboarding`; its folder and commit remain fixtures.

- Both native directory-picker doors now adjudicate duplicate paths and missing-folder claims before opening the editor. A known folder selects its existing project. Relinking bypasses onboarding and retains the stored identity.
- A genuinely new folder is an ephemeral draft: Cancel/Escape creates nothing. “Make it mine” atomically inserts the edited name, identity, and optional canvas. Failed creation keeps the draft for retry; busy creation blocks duplicate submissions, dismissal, and dropped images. A duplicate discovered during creation selects the existing project without overwriting its identity or canvas.
- Migration 054 adds nullable `workspace_identity` JSON. Shared validation accepts only catalog glyphs, bounded stable stamp seeds/variants, initials, or local PNG/JPEG/WebP data URLs. Invalid persisted identities degrade to legacy monograms. Bootstrap and rescue export retain the identity.
- Production uploads accept source rasters under 2 MB, decode and downscale to at most 128px per side, and encode a mark under 128 KB. Failed rendering falls back to initials. No SVG or remote image source is accepted.
- Saved identities render on the real rail using their destination canvas and appearance. Legacy projects retain their original palette and monograms; selection rings, shortcuts, dragging, and context-menu actions remain unchanged. Identity editing after creation is not part of this slice.
- Jev is intentionally absent: three name-based suggestions and subsequence-ranked glyph search run locally. A human explicitly chooses the mark; rename and suggestion refresh never overwrite it.

Study 01’s unread/activity badge aggregation and selection-bar redesign remain lab-only. Production adoption here is creation-time identity, not a claim that the cross-workspace read/activity baseline is implemented.

## The questions the rail should answer

1. **Where am I going?** A stable monogram (or the optional fixture glyph study) identifies the workspace. The destination's resolved canvas provides context, not state.
2. **Where am I now?** A short selection bar outside the tile; not a colored outline competing with notifications.
3. **Has something arrived that I have not read?** A blue upper-corner dot, using the sidebar's existing `--info` meaning. It remains even while a Session works or asks for input.
4. **Does work here need me, or is it running?** A lower-corner `StatusDot`, with the existing Session roster priority: input, recovery, active. Idle and stopped Sessions do not light a state mark.

A single priority-colored notification dot cannot answer both questions 3 and 4: reading a result would appear to resolve a wait, or a running turn would hide unread. Two positions preserve both facts. Counts belong on hover and in the accessible name, not in tiny number badges. The tile selects the workspace; the Session row opens the conversation. Selecting a workspace does not mean reading everything in it, and reading never resolves input or recovery.

## Designs to compare

- **Canvas tile:** a miniature destination canvas with generated contrast-safe ink, retaining the familiar 36px monogram. Workspace canvas and appearance overrides resolve independently; inherited choices follow the lab editor live.
- **Quiet stamp:** current-window card and ink, with a narrow strip of the destination canvas. Less colorful chrome, but less workspace distinction, especially in dark mode.
- **Today:** fixed project palette and selection ring, included as a static reference. Those colors remain confined to the reference.

**Starting recommendation:** the canvas tile with initials. It makes the new theming system visible without introducing a separate icon-color setting. Retain the quiet stamp as the alternative if a larger set of customized workspaces feels too colorful. The glyph study is deliberately not a proposal to add icon storage or a picker yet.

Do not rely on color alone for identity: inherited workspaces can have identical canvases and initials can collide. The fixture pair “Volli Code” / “Volli Companion” tests the latter. Full names remain available on hover and keyboard focus. A future custom mark can address collisions without making color a status vocabulary.

## Review in the lab

- Compare Mixed, Quiet, All working, and Input + unread, using both initials and glyphs.
- Select Paper Trail: its unread stays. Open its Session: only that receipt clears, in both comparison panes.
- Read Permission policy: its input mark stays lit; the other unread conversation remains unread.
- Switch Light / Dark / Auto and edit the lab canvas. Paper Trail is pinned light; Archive inherits both. Notification marks keep the current window's tokens, not the thumbnail's local palette.
- Use App and Reading stage widths, inspect matching initials, long names, the empty workspace, the recovery-only mark on Volli Companion, and the input/recovery collision on Cinder.
- Canopy includes a waiting/unread helper behind its working parent: no helper row appears, and its wait/read receipt does not become a direct workspace notification.

## Before production adoption of unread/activity cues

- Establish a confirmed activity/read baseline for **all** workspaces. Current project listings are fetched on arrival; an unvisited workspace must not falsely read as quiet. Pending/failed baseline presentation is not implemented by this fixture scratch.
- Aggregate project-level and Ticket Sessions using the existing attention/read projections. Helper work is represented by its parent; a helper wait must not direct a person to a nonexistent sidebar row. This scratch filters helper rows and assumes the parent's activity has already been projected.
- Keep rail order and ⌘1–9 stable. No activity-driven reorder.
- Preserve dnd-kit click/drag separation, context menus, hidden-rail inertness, and window drag regions. This scratch does not simulate those behaviors.
- Derive thumbnails only on authored-theme/appearance changes; use one shared activity subscription and boundary timer, not per-tile PTY subscriptions or polling.
- Review marks over the actual transparent canvas rail. This comparison uses the semantic `--rail` bed, so its opaque badge backing is not yet evidence that the production gradient seam is solved.

The notification/selection comparison remains provisional; picked-folder identity onboarding is integrated independently.
