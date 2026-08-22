# Settings & Configure — audit (VC-111)

Read-only audit of both preference surfaces. Every claim below is a file I read, not a guess.
Numbered so items can be picked off individually.

---

## 1. What exists today

**Settings** (app-wide overlay, sidebar-footer gear) — `settings-page.tsx`, 7 categories:

| Category | What's actually in it | Kind |
|---|---|---|
| General | one row: Done-worktree retention (days) | setting |
| Appearance | App theme (mode + canvas pad), Terminal (theme, font, size, 2 file buttons) | setting |
| Model Access | 3 default-model rows, 1 compaction switch, N model rows, N provider accounts | setting |
| Web | provider segmented, instance URL, API key | setting |
| Harness Runtimes | pill selector + **one read-only row** (`Command`) | **read-only** |
| CLI | detection rows + Doctor report | **read-only** |
| Worktrees | orphan list w/ Reveal/Delete | maintenance |

**Configure** (per-project nav tab) — `configure-page.tsx`, 3 categories:

| Category | What's actually in it | Kind |
|---|---|---|
| General | base branch, setup command | setting |
| Appearance | App theme (mode + canvas, each with own scope switch), Terminal (scope switch in header) | setting |
| Worktrees | **two paragraphs of prose** about `.worktreeinclude` | **read-only** |

So: 10 categories, of which **3.5 contain no changeable setting at all**.

**Competitive read** (the ticket's ask):
- **Claude Code** publishes a 4-level scope table — User / Shared project / Project local / Managed — with an explicit "Who it affects" column and a precedence diagram. Scope is the *first* thing documented, not an afterthought.
- **Cursor** collapsed rules/skills/MCP/commands/hooks into **one "Customize" page with a scope filter** (user / workspace / team) instead of parallel pages per scope. Their own changelog frames it as "without switching between separate settings pages."

The lesson for both of our problems is the same: **one surface, scope as a filter/column — not two surfaces that mirror each other.**

---

## 2. Structural problems

**1. Settings and Configure are two shells rendering the same category names.**
"General", "Appearance", "Worktrees" exist in both, mean different things in each, and neither surface
mentions the other. A user who theme'd a project and then opens Settings → Appearance sees the *app*
canvas with no indication it isn't what's on screen.

**2. Scope is invisible on the app-wide side.**
Configure has Inherit/Custom switches everywhere. Settings has exactly one hint that a project is
overriding it — a small "Project override" pill in App theme (`CanvasShadowedNote`). Terminal theme,
mode, and canvas can all be shadowed; only one says so.

**3. The scope control sits at three different heights.**
Configure → App theme puts Inherit/Custom **on each row**. Configure → Terminal puts it in the
**section header action**. Settings puts it **nowhere**. Same concept, three placements, one page apart.

**4. Two different save models, no rule for which you get.**
Explicit **Save button** (five of them): retention (`settings-page.tsx:213`), base branch
(`configure-page.tsx:133`), setup command (`:172`), web instance (`web-access-settings.tsx:201`),
web API key (`:248`).
**Saves on change**: every model default, every switch, every theme control, font size.
Five exceptions, split across both surfaces, with no rule saying which you get.

> Corrected after external review — this said "the only three" in a sentence listing five.

**5. Section header actions have four different shapes.**
`icon-xs` ghost refresh (Worktrees, CLI), `icon-sm` ghost refresh (Model Access), `xs outline`
text button (Doctor), `Segmented` control (Configure Terminal). Four idioms for "the thing in the
top-right of a card."

**6. Status is spoken in four vocabularies.**
`StatusDot` + "On/Off" text (Web), `StatusDot` alone (CLI), `Badge` (Harness origin),
`ThemeOriginPill` (every theme row), and plain muted text ("Stored in your keychain"). Nothing tells
you which one means "healthy" vs "provenance" vs "identity."

**7. Freeform blocks and hairline rows are interleaved inside one card.**
`CanvasEditor` drops a raw `<div className="flex flex-col gap-4 pb-2">` gradient pad between
`SettingsRow`s. Result: a tall unlabeled visual object, then divided label/control rows, in the same
section. This is the "some elements have much more emphasis" complaint, precisely.

**8. Harness Runtimes is a category with nothing to change.**
`harness-settings.tsx` is 30 lines: a selector and one read-only `Command` row. The doc comment on
`harness-picker.tsx`'s `HarnessIdentitySection` says the last configurable row "was retired."

> Corrected after external review, twice. The comment is in `harness-picker.tsx`, not
> `harness-settings.tsx`. And calling the pane a pure *diagnostic* is half wrong: `HarnessSelector`
> lists user-installed manifest harnesses, so it is the only surface that answers "did Volli pick up
> the harness I registered, and which binary will it launch?" That is an **inventory**, and it is why
> collapsing it to a comma-separated list loses something real.

**9. `harness-picker.tsx` was extracted for a caller that doesn't exist.**
Its header says it was lifted out "when Configure gained a Runtime category." Configure has no
Runtime category. The abstraction is carrying a second consumer that was never built.

**10. CLI + Doctor + Worktrees are operations, not preferences.**
Three of seven Settings categories are "what is true about this machine" / "clean up this mess."
Mixing them with preferences is why the rail feels arbitrary.

**11. Configure → Worktrees is documentation with a settings chrome on it.**
Two `<p>`s explaining `.worktreeinclude`, wrapped in a `SettingsSection`, in a nav tab called
Configure. Nothing is configurable.

**12. Configure → General uses the project's *name* as its section title.**
Settings → General uses "Retention". So one surface titles the section by scope, the other by
subject.

**13. No search in either shell.**
10 categories and ~45 individual controls (Model Access alone renders one row per available model).
`SettingsShell` has a category rail and nothing else.

**14. No *explicit* "reset to default" control except the terminal overlay revert.**
The Ghostty overlay has a per-key revert button (`appearance-settings.tsx:221`). Elsewhere the
reset exists only as a *value* you re-select — "Project default" (`model-access-settings.tsx:378`),
"Default reserve" (`:465`), Configure's `Inherit` (which clears the stored column). Those are real
resets; what is missing is a consistent affordance that says so.

> Softened after external review — the original claim ("nowhere except the overlay") was too strong.

---

## 3. Model Access specifically (the ticket calls this out)

**15. One pane is doing four unrelated jobs.**
Default models · compaction policy · per-model curation · provider accounts. It's the longest pane in
the app and the only one that scrolls indefinitely.

**16. The "Models" list is unbounded and unsearchable.**
One `SettingsRow` per available model, grouped by provider, with no filter and no count. Sign in to
three providers and this is a wall.

**17. Each model row does two unrelated things with no column headers.**
A compaction-reserve `Select` and a visibility `Switch` sit side by side. Nothing labels either
column, and neither carries a `title` — so hovering tells you nothing at all. Only a screen
reader gets the `aria-label`.

> Corrected after external review — this said "you have to hover for the `aria-label`", which
> describes an affordance that does not exist.

**18. "Project default" is app-wide.**
The Ticket/Utility pickers offer an option literally labelled **"Project default"** — but every
model-access key is app-wide `app_state` (`volli:model-access-defaults`), and the value it inherits
is the row labelled **"Project chats"**. So the option name refers to a *different row's label*, on a
pane that has no project scope at all. This is the single most confusing string in Settings.

**19. Compaction is split across two sections.**
The global auto-compaction switch is in a "Compaction" section; the per-model reserve that
implements it is a dropdown on a model row two sections down. The code comment explains why — the
reasoning is sound — but nothing in the UI connects them.

**20. Reasoning level is a naked `Select` with no explanation and no disabled reason.**
It greys out when no model is chosen, and says nothing about why.

---

## 4. Settings we don't have (and should)

**21. Updates.** `auto-update.ts` ships a prerelease/canary toggle whose doc comment literally says
*"No Settings UI yet"* and then gives you a **`sqlite3` command to run by hand.** No version display,
no "check now", no channel choice.

**22. Notifications.** Native notifications fire for ticket moves, agent `notify` calls, retention
sweeps, and updates. Zero configurability — no master switch, no per-event control.

**23. UI zoom.** `uiScale` is persisted app-wide and is reachable *only* through the View menu
(⌘+/−/0). It belongs in Appearance as a row.

**24. Default external editor.** `external-apps.ts` allowlists 9 apps for Files' "Open in…" and
there's no way to say which one is yours.

**25. Diff presentation.** Inline vs side-by-side is a persisted **app-wide** preference toggled from
inside a diff view. That's a setting living in a workbench.

**26. Commands & Skills.** `.volli/commands/`, `<userData>/commands/`, and `.agents/skills/` are three
real config surfaces with **no UI at all** — can't list, enable, disable, or reveal them. This is
exactly what Cursor put on its Customize page.

**27. Data & backup.** "Export Database as JSON…" exists only in the File menu. No DB path, no size,
no reveal-in-Finder, no import.

**28. Keyboard shortcuts.** Six shortcut hooks, no reference surface, no remapping.

**29. Chrome preferences aren't settings.** `workspaceRailHidden`, `sidebarPinned`, `railCollapsed`,
`homeRailMode` all persist app-wide but are only reachable by hotkey or drag — discoverable by
accident only.

**30. No per-project overrides where they'd actually help.** Model defaults, web access, retention
TTL, and default harness are all app-wide only. Meanwhile *appearance* — the least consequential of
them — has full per-project scoping. The scoping effort went to the wrong settings.

**31. `.worktreeinclude` is read-only prose** (#11) where it could be an editable list.

---

## 5. Proposed direction

**A. One shell, scope as a control — not two pages.**
Merge Configure into Settings. Each pane that *can* be scoped carries one Inherit/Custom switch in a
fixed position (section header, per Cursor's scope filter), and the app-wide value is always visible
behind it. Kills #1, #2, #3, #12 and the ticket's headline "desync" complaint.

**B. Split preferences from diagnostics.**
Settings holds things you *change*. CLI, Doctor, Harness Runtimes, and orphan cleanup move to a
separate "System" / "Diagnostics" area. Kills #8, #10, #11.

**C. One save model: everything saves on change.**
Retire the three Input+Save rows (debounce-on-blur instead). Kills #4.

**D. Fixed section-header grammar.**
`title · icon · optional scope switch · optional icon-xs action`, in that order, one size each.
Kills #5, #6.

**E. Every control is a row.**
`CanvasEditor`'s pad becomes a row with a label, or moves behind a "Customize…" button. Kills #7.

**F. Break up Model Access** into Defaults (3 rows) / Compaction (switch + reserves together) /
Models (searchable, with column headers) / Accounts. Rename "Project default" → "Same as Project
chats". Kills #15–#20.

**G. Add the cheap missing settings first:** Updates (#21), Notifications (#22), Zoom (#23),
Default editor (#24), Diff presentation (#25). All five are existing persisted state that just needs
a row.
