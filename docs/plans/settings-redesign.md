# Settings & Configure — the proposal (VC-111)

Prototype: `pnpm lab` → **"Settings & Configure, reorganized"**.
Code: `apps/desktop/src/renderer/lab/settings/` — `kit.tsx` **is** the proposal;
the `panes-*.tsx` are content poured into it.

| Artifact | What it is |
|---|---|
| `docs/plans/settings-audit.md` | 31 findings against the surfaces as they ship today |
| `docs/plans/settings-redesign-review.md` | independent adversarial review of the first prototype |
| `docs/plans/settings-redesign-review-2.md` | second independent review, after the component pass |
| `apps/desktop/e2e/vc111-review-fixes.mjs` | 55 checks, one per finding. Manual: needs `pnpm lab` running |
| `apps/desktop/e2e/lab-boot-check.mjs` | the scratch is enrolled |

---

## The split

**Scope is the surface.** Settings is app-wide, always. Configure is this
project, always. There is no scope switch anywhere.

|  | Settings | Configure |
|---|---|---|
| **Scope** | every project | this project |
| **Entry** | sidebar-footer gear | project nav tab |
| **Groups** | Preferences · Services · System | Agent · Project |
| **Categories** | General, Appearance, Notifications, Models, Web Search, Integrations, Storage, Updates, About | Skills, Commands, MCP Servers, Plugins, Sessions, Appearance, Worktrees |

Agent configuration lands in Configure because agent configuration *is*
project-scoped — the ticket's ask and the scope rule agree.

**The one asymmetry, stated up front.** Web search is app-wide; MCP servers are
per-project. Both are "tools the agent can reach", so a reader hunting for agent
tooling will not find it all on one surface. The reason is real — web search is
one account and one key, while an MCP server is a process with a config file per
repo — but "defensible" is not "discoverable", so Configure → MCP carries a hint
pointing at the other one. If per-project web-search keys are ever wanted, this
is the seam that has to move.

**Where a setting has two tiers** it appears on both surfaces, the Configure
side carries `OverrideControl`, and the pane publishes its resolution order in
an `InfoHint`. The first prototype had models on both surfaces and stated no
precedence — rebuilding the desync it was meant to fix.

---

## The nine rules (`kit.tsx`)

1. **Grouped, searchable rail.** Group labels carry the relationship.
2. **Scope is the surface, not a mode.** Divergence is marked once per row, by
   `OverrideControl` — a revert button that exists only when there is something
   to revert.
3. **One section header grammar**: icon · title · optional `(i)` · one action.
4. **A setting is a `PrefRow`. A collection is a `DataTable`.**
5. **One save model, and it can refuse** (`CommitField`).
6. **Status has three roles and three components**: `Health` (is it working),
   `Provenance` (who set it), and a table column (where it came from).
7. **Every collection declares loading, error, empty and no-results**
   (`AsyncSection`).
8. **Widths come from `CONTROL_W`.** Nothing else sets one.
9. **Prefer the repo's primitive.** If one exists, `kit.tsx` wraps it.

### What rule 9 cost the first two passes

`pick-ui-library`'s first instruction is *check what's already installed*. It
found `kit.tsx` had grown a parallel design system:

| Hand-rolled | Already in the repo | Consequence |
|---|---|---|
| `ItemRow` | `ui/list-row.tsx` (5 surfaces) | had re-made the bug that file exists to prevent — actions inside the activation target, hover fill on inert rows |
| `Health`'s tone map | `ui/status-dot.tsx` (12 surfaces) | a second state→colour map, the exact drift StatusDot's header says it ends |
| rail eyebrows | `ui/section-heading.tsx` | four elements where the eye reads one |
| loading text | `ui/skeleton.tsx` | no reduced-motion gate |
| search fields | `ui/input-group.tsx` | no `aria-invalid` border wiring |
| rail count pills | `Badge variant="count"` | a pill where the repo draws bare mono |

**The one object the app genuinely lacks is a table** — `grep` finds no
`<table>` in the renderer. `DataTable` is new, built from the same tokens.
**Virtuoso is deliberately not added**: it earns its keep past ~1,000 rows and
the largest collection here is a few hundred. Revisit if a list becomes
unbounded — before reaching for pagination.

### Copy and pills, as budgets

- **No section descriptions.** `PrefSection` has no `description` prop, so the
  rule is structural. `PrefRow.description` survives for the **trust-boundary
  exception only** — two uses, both about automatic deletion.
- **Hints are ≤ 12 words.** Written against Google's UI-string guidance: keep
  the one fact the control cannot say about itself, cut the rest. Average 7.4.
  Enforced by the check, which walks every category and reads every panel.
- **`Segmented` appears twice**: Light/Dark/Auto, and its Configure override
  twin. Provider, diff layout and channel are `Select`s.
- **Provenance is a column, not a pill per row**, with one filter in the
  toolbar.

---

## Old → new

| Today | Becomes |
|---|---|
| Settings → Appearance (app + project mixed) | Settings → Appearance (app only) + Configure → Appearance (overrides) |
| Settings → Model Access | Settings → Models — Defaults, Compaction, Catalog (table), Accounts |
| Settings → Web Access | Settings → Web Search |
| Settings → CLI | Settings → About |
| Settings → Harness Runtimes | Settings → About (Harnesses, as inventory) |
| Settings → Worktrees (retention) | Settings → Storage, beside the orphan sweep |
| orphaned-worktree cleanup | Settings → Storage (was homeless in pass 1 — a live delete flow dropped off the IA) |
| Configure → Project/Sessions/Appearance | Configure → Sessions, Appearance, Worktrees |
| *(nothing)* | Configure → Skills, Commands, MCP Servers, Plugins |

## Kill list

- The `sqlite3` prerelease command in `main/auto-update.ts` → a Channel row
  with a confirm.
- The pane-level scope switch (`Segmented` "App / This project").
- `SettingsSection`/`SettingsRow` `description` at every current call site.
- `HarnessPicker`'s second view — **inlined** into Configure → Sessions, not
  deleted outright. `harness-picker.tsx:5` says it was lifted out "when
  Configure gained a Runtime category"; that caller is the harness row in
  step 5, so the abstraction collapses into its one remaining site.
- `InheritNote` — replaced by `OverrideControl`.

---

## Build order

1. **Updates pane** — kills the `sqlite3` command. Smallest, highest disgust.
2. **`kit.tsx` into `src/`**, replacing `settings-shell.tsx`. Nothing moves yet.
   `AsyncSection` and `DataTable` land here.
3. **Storage** — retention + orphans + database in one category.
4. **About** — absorbs CLI + Doctor + harness inventory, per-fault remedies.
5. **`OverrideControl`** — Configure → Appearance keeps its rows; Settings gains
   `OverrideNote`.
6. **Configure → Skills + Commands** — surfacing data that already loads.
7. **Models restructure** — four sections, catalogue as a table.
8. **MCP + Plugins** — the only genuinely new plumbing.
9. Notifications, Integrations, zoom, diff layout — one row each.

1 and 3–4 are independent of 6–8; 2 gates everything.

---

## Sorted out in the lab

Everything below was closed in the prototype, so implementation inherits it
rather than rediscovering it.

- **Keyboard traversal (`useRovingRows`).** A table is one tab stop. Arrows move
  between rows, Home/End jump, Enter steps into a row's controls, Escape steps
  back out. Two hundred tab stops became one.
- **All four data states are drivable.** `AsyncSection` existed but every pane
  passed `ready(...)`, so loading, error and empty had never rendered. The lab
  chrome now switches every collection through them (`lab/settings/fixtures.tsx`
  — lab-only; production gets its state from IPC). The error's Try again really
  recovers, so the affordance is tested rather than drawn.
- **The creation loops close.** New command and Add MCP server write to local
  state, so create → appears in the table → searchable → correct Source can all
  be judged. A new MCP server lands in `starting`, which is what the real
  connect will do.
- **`DataTable` caps rendering** at `maxItems` with a footer, search first.

## Still open

- **`keywords` is hand-maintained** and will rot. Mitigation: a test asserting
  keywords against rendered labels. Real fix: derive them.
- **`Copy report…` needs a preview sheet** — designed as an intent, not built.
- **Configure → Appearance's "Edit canvas…"** needs a non-modal design; a scrim
  defeats the live preview it is judged against.
- **Deep-link migration**: `stores/ui.ts`'s `settingsCategory` uses
  `model-access`; the new key is `models`. Needs an alias, plus the
  auto-sign-in flow the prototype does not draw.
- **New command / Add MCP server** are designed as forms but write nothing.
  `main/prompt-templates.ts` already reads both command folders; MCP has no
  backing store yet and is the largest piece of new plumbing in the plan.
- **Skill enable/disable per project** has no store. `main/skills.ts` has
  `isUserInvokeOnly` for a global opt-out; a project-scoped disable list is new.
- **The table is not virtualized** (see rule 9), and the headroom is smaller
  than first claimed: `MAX_SKILLS_PER_DIR` is 200 **per directory**
  (`main/skills.ts:47`) and a project merges two, so 400 is reachable now.
  `DataTable` caps rendering at `maxItems` (500) with a footer that says what it
  withheld; search runs before the cap, so a withheld row stays reachable. Past
  ~1,000, switch to Virtuoso rather than raising the cap.
- **`Column.width` takes a CSS length or percentage, never a grid track.** Three
  columns passed `minmax(0,1fr)`; React drops it as invalid, so they sized by
  `table-layout: fixed`'s remainder rule and looked correct by accident.
