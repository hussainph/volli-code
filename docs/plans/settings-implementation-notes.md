# VC-111 — implementation notes

**You are picking up a finished design, not a brief.** The prototype in
`apps/desktop/src/renderer/lab/settings/` is the specification. Where this doc
and the prototype disagree, the prototype is right — it is the thing that was
reviewed twice and driven in a browser.

Read in this order:

1. `docs/plans/settings-redesign.md` — the proposal, the nine rules, build order.
2. `apps/desktop/src/renderer/lab/settings/kit.tsx` — **this is the design.**
   Every non-obvious decision is a comment explaining what broke without it.
3. `docs/plans/settings-audit.md` — why each change exists.
4. `docs/plans/settings-redesign-review.md` and `-review-2.md` — two independent
   audits. Read the "blocking" sections; several fixes are load-bearing and not
   obvious from the code alone.

```bash
pnpm lab                                    # port 5174 → "Settings & Configure, reorganized"
node apps/desktop/e2e/vc111-review-fixes.mjs   # 59 checks. Needs the lab running.
cd apps/desktop && ../../node_modules/.bin/tsc --noEmit -p tsconfig.web.json --composite false
```

`npx tsc` does not work in this repo. The lab boot check reports
`ticket-kickoff` broken — that is **pre-existing on `main`** and not yours.

---

## What is done, and must not be re-litigated

These were each argued, built, reviewed, and in several cases rebuilt after
being got wrong. The reasoning lives in the code comments.

| Decision | Where |
|---|---|
| Scope is the surface: Settings = app-wide, Configure = this project | `kit.tsx` rule 2 |
| Divergence is said **once**, by `OverrideControl`'s revert button — no gutter marks, no Inherit/Custom pills | `kit.tsx` `OverrideControl` |
| Provenance is a table **column** plus one filter, never a pill per row | `kit.tsx` `DataTable`, `panes-configure.tsx` `Source` |
| Collections are bounded, scrolling tables; `PrefRow` is for settings only | `kit.tsx` rule 4 |
| `PrefSection` has **no** `description` prop — the copy rule is structural | `kit.tsx` `PrefSection` |
| Hints are ≤ 12 words, in an `(i)` | enforced by the check |
| One save model that **can refuse** | `kit.tsx` `CommitField` |
| Diagnostics collapse to About: headline + only the faults present | `kit.tsx` `HealthPanel` |

---

## Port `kit.tsx` first, and port it honestly

Everything else depends on it. Six things in it exist because their absence
caused a real bug — if you simplify them away you will reintroduce that bug:

1. **`PrefShell`'s root needs `w-full flex-1`.** Without it the root is a
   shrink-to-fit flex item and the whole surface collapses to ~670px jammed
   against the left edge. This shipped once and was invisible in screenshots.
2. **`Column.width` takes a CSS length or percentage, never a grid track.**
   `minmax(0,1fr)` is dropped by React as invalid, the attribute reaches the DOM
   empty, and the column sizes by `table-layout: fixed`'s remainder rule — so it
   renders *correctly by accident* and the API lies. Omit `width` to mean "the
   rest"; use percentages for a ratio.
3. **`CommitField` must keep `validate` / `confirm` / async refusal.** Retention
   governs an automatic folder deletion; without the refusal path,
   select-all-type-`1`-click-away silently arms a one-day sweep.
4. **`InfoHint` opens `side="top"` and is `pointer-events-none` unless
   `interactive`.** It used to open over the rows it explained and eat the next
   click — the very click it had persuaded the reader to make.
5. **`RowHelp`/`hint` is a sibling of `<label>`, never a child.** A `<button>`
   inside a `<label htmlFor>` toggles the control it names.
6. **`useRovingRows`.** A table is one tab stop. Enter/Space must only fire when
   the row *itself* has focus, or it swallows the space that toggles a switch
   the user already stepped into.

**Delegate, don't re-derive.** `kit.tsx` wraps `ui/list-row.tsx`,
`ui/status-dot.tsx`, `ui/section-heading.tsx`, `ui/skeleton.tsx`,
`ui/input-group.tsx`, `ui/popover.tsx` and `Badge variant="count"`. Two passes
hand-rolled these and both reintroduced bugs those files exist to prevent.
If you need a primitive, `grep` the repo before writing one.

---

## Order of work

Ship in this order. **1 and 3–5 are independent of 6–8; step 2 gates everything.**

| # | Step | Size | Notes |
|---|---|---|---|
| 1 | **Updates pane** | S | Kills the `sqlite3` command in `main/auto-update.ts`. Do this first — smallest, and it removes the thing the ticket owner most wanted gone. Channel switch confirms before entering canary. |
| 2 | **`kit.tsx` → `src/`**, replacing `settings-shell.tsx` | L | Nothing moves category-wise yet. Land `AsyncSection` and `DataTable` here. See the migration risks below. |
| 3 | **Storage** | M | New category: retention + orphan sweep + database. `sweepOrphans` already exists and is app-wide by construction. |
| 4 | **About** | M | Absorbs CLI + Doctor + harness inventory. `cli-status-model.ts` already computes per-check remedies — feed them to `Fault[]`. |
| 5 | **`OverrideControl`** | M | Configure → Appearance keeps its rows; Settings gains `OverrideNote`. |
| 6 | **Configure → Skills + Commands** | M | Read-only first. The data already loads. |
| 7 | **Models restructure** | M | Four sections; catalogue as a table. |
| 8 | **MCP + Plugins** | XL | All new plumbing — see below. |
| 9 | Notifications, Integrations, zoom, diff layout | S | One row each. |

---

## Migration risks in step 2

- **`stores/ui.ts` `settingsCategory`** uses `"model-access"`; the new key is
  `"models"`. `chat-plane.tsx:906` deep-links here for auto-sign-in. Accept both
  as aliases or migrate every caller — otherwise sign-in opens on General.
- **`testId`s are load-bearing.** `PrefRow`/`ItemRow` keep `testId` because
  ~15 references exist across unit tests and `canvas-theming-smoke.mjs`.
  Run the full suite, not just typecheck.
- **`harness-picker.tsx`** is **inlined** into Configure → Sessions, not deleted.
  Its header explains it was extracted for a second caller; that caller becomes
  the harness row in step 5.
- **Model access keys are app-wide** in `app_state`
  (`volli:model-access-defaults`, `volli:model-access-hidden-models`,
  `volli:compaction-policy`). Today's "Project default" option label is
  misleading — the new Settings/Configure split is what makes it honest, so the
  per-project store is new work.

---

## The plumbing that does not exist yet

The prototype draws these fully and writes nothing. Each dialog is a finished
interaction design; only the save is missing.

### Commands — small (~2–3h)
`main/prompt-templates.ts` already reads `<project>/.volli/commands/` and
`<userData>/commands/`, merged project-over-personal. Needed: an IPC write for
`<name>.md`, a name-collision check, and a list refresh. The dialog's slug rule
(`^[a-z0-9-]+$`) exists because the filename becomes the invocation.

### Per-project skill enable/disable — small (~3–5h)
`main/skills.ts` reads `<project>/.agents/skills/` and `~/.agents/skills/`, and
has `isUserInvokeOnly` for a *global* opt-out. A **project-scoped disable list**
is new: a store, IPC, and a merge in the loader. The prototype's switch is
labelled "Enable X in this project" precisely because that ambiguity was the
first review's finding — keep the label honest with whatever you build.
`MAX_SKILLS_PER_DIR` is 200 **per directory**, so 400 rows is reachable.

### MCP — extra large (2–3 days minimum, ~1 week for robust)
`grep -rn "mcp" apps/desktop/src/main/` finds nothing but a branch name. Needs:
a per-project config reader, a process spawner for stdio and an HTTP client for
remote, a per-server tools cache (the "12 tools" cell), health monitoring (the
status dot), IPC for list/add/remove/start/stop, and **Agent Runtime injection
of the tools into the model's tool set**. That last one is the real work; the UI
is the easy part. Ship steps 1–7 without it.

### Plugins — unscoped
No backing store and no format decision. Treat the pane as a placeholder.

---

## Known gaps that are choices, not oversights

- **No virtualization.** `DataTable` caps rendering at `maxItems` (500) with a
  footer, and search runs *before* the cap so a withheld row stays reachable.
  Past ~1,000 rows switch to **Virtuoso** (the curated pick) rather than raising
  the cap or adding pagination.
- **`keywords` is hand-maintained.** The check now walks every row label on both
  surfaces and fails if one is unreachable from the rail search — it caught real
  drift on its first run. **Keep that check green when you add rows.**
- **Web search is app-wide while MCP is per-project.** Deliberate and documented;
  Configure → MCP carries a hint pointing at the other surface. If per-project
  web keys are ever wanted, that is the seam that moves.
- **The canvas editor is a popover on Configure, inline on Settings.** A
  `Dialog` would scrim the window whose background is being edited.
- **`lab/settings/fixtures.tsx` is lab-only.** Do not port it. What production
  inherits is `AsyncState<T>` and the fact that every pane was designed against
  loading, error, empty and ready.

---

## Before you open the PR

- [ ] `vp test` (not just typecheck) — `testId` and canvas smoke tests.
- [ ] Every new row label reachable from rail search (the M4 check).
- [ ] No `description` on a `SettingsSection`; hints ≤ 12 words.
- [ ] Spacing on the `docs/DESIGN.md` ladder — **0 / 1 / 2 / 4 / 6 only.** No
      half-steps. Nineteen violations were introduced and removed once already.
- [ ] Keyboard: one tab stop per table, arrows between rows, Escape steps out.
- [ ] A refused `CommitField` announces — `aria-describedby` must resolve.
