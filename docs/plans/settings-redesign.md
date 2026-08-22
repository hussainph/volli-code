# Settings & Configure — the proposal (VC-111)

Prototype: `pnpm lab` → **"Settings & Configure, reorganized"**.
Audit that produced it: `docs/plans/settings-audit.md`.
Code: `src/renderer/lab/settings/` (`kit.tsx` is the actual proposal; the two
`panes-*.tsx` are content poured into it).

---

## The split

|  | Settings | Configure |
|---|---|---|
| **Is** | preferences about the app | this project's agent setup |
| **Scope** | you, everywhere (with a per-pane override) | this repo |
| **Entry** | sidebar-footer gear | project nav tab |

That boundary is the whole fix for "why are settings duplicated on both
surfaces". Today they share three category names that mean different things in
each. Under this split they share none.

**Theming does not move to Configure.** It is a preference, not agent config, so
it stays in Settings and gains a scope control instead. Configure loses its
Appearance category entirely.

---

## Settings — 8 categories, 3 groups

| Group | Category | Contents | Status |
|---|---|---|---|
| Preferences | General | startup · retention · data & export | reworked |
| | Appearance | theme · canvas · **zoom** · **diff layout** · terminal | + 2 new |
| | Notifications | master switch · 5 per-event switches | **new** |
| Services | Models | defaults · compaction · catalog · accounts | restructured |
| | Web Search | provider · key | as-is |
| | Integrations | **default editor · default terminal** | **new** |
| Application | Updates | auto-install · **channel** · version · check now | **new** |
| | About | one health line, internals behind a disclosure | replaces CLI + Harness + Doctor |

## Configure — 6 categories, 2 groups

| Group | Category | Contents | Status |
|---|---|---|---|
| Agent | Skills | list · enable · project-vs-personal · reveal | **new UI, existing data** |
| | Commands | `/` templates, same shape as Skills | **new UI, existing data** |
| | MCP Servers | servers · health · add | **new** |
| | Plugins | bundles | **new** |
| Project | Sessions | default harness · project model override · AGENTS.md | mostly new |
| | Worktrees | base branch · setup command · **editable copy set** | reworked |

**Skills and Commands are not speculative.** `main/skills.ts` and
`main/prompt-templates.ts` already read those directories on every composer open
and merge them project-over-personal. They have simply never been visible.

---

## Six rules (`kit.tsx`)

1. **The rail is grouped and searchable.** Group labels are where the
   Settings-vs-Configure relationship gets written down. Search filters
   *categories* by keyword, not rows — a row torn out of its section is a
   result nobody can act on.
2. **Scope is one control, in one place: the pane header.** `ScopeBar`. At app
   scope it reports how many settings this project overrides; at project scope
   every scopeable row grows the same Inherit/Custom switch, and Inherit names
   the value it inherits rather than going blank. Replaces three placements
   across two surfaces.
3. **One section header grammar:** icon · title · description · one action.
   The action is an `xs outline` button or an `icon-xs` ghost. Nothing else.
   Scope is not an action, so it cannot land here.
4. **A setting is a row; a thing is an item.** `PrefRow` is label→control.
   `ItemRow` is a skill/server/model — identity, meta, state. Today models are
   rendered as settings rows, so a model name reads as a setting name.
5. **Everything saves on change.** `CommitField` commits on blur and Enter with
   a quiet inline "Saved". Retires all five Input+Save pairs.
6. **One status vocabulary.** Dot = health. `Badge` = identity. `Origin` =
   provenance. A surface picks which it needs; it cannot pick what a drawing
   means.

---

## Diagnostics

Per the brief — concise, no internals. Today: two categories plus a Doctor
report, showing `binDir`, a socket path, a shell-chain boolean, a legacy-path
tri-state, a wrapper list and a PATH comparison table.

Proposed: **one sentence, one button.** `HealthSummary` renders a dot, a
headline, a detail line and up to two actions. `Details` is closed by default
and is plain-language when open (six `DetailLine`s: version, command line,
harnesses, providers, web search, database size). The escape hatch for a bug
report is **Copy report**, which puts the internals on the clipboard rather than
on screen. The failure state gets the same shape: one sentence, one **Fix this**,
still no paths.

Harness Runtimes disappears as a category — it is a selector plus one read-only
`Command` row, and it becomes one `DetailLine`.

---

## Kill list

| Thing | Replaced by |
|---|---|
| **`sqlite3` command in `auto-update.ts`** for the canary toggle | Settings → Updates → Channel (`Segmented`) |
| Settings → Harness Runtimes | one line in About → Details |
| Settings → CLI (7 rows + Doctor) | About's health line + Copy report |
| Configure → Appearance | Settings → Appearance + `ScopeBar` |
| Configure → Worktrees prose | editable `.worktreeinclude` field |
| `harness-picker.tsx`'s unused second consumer | delete (audit #9) |
| "Project default" model option | "Same as Project chats" |
| 5 × Input+Save | `CommitField` |

---

## What the prototype already corrected

Three things were wrong in the first draft and are fixed in the committed
version — worth recording because each is a trap the real implementation would
hit too:

- **A labelled status dot in a rail button poisons the button's accessible
  name.** "Updates" became "Updates Update ready" for a screen reader and for
  every name-based query. Trailing marks are `aria-hidden`; count `Badge`s are
  fine ("Skills 7").
- **`PrefRow`'s `help` renders a Tooltip**, so any surface using it needs a
  `TooltipProvider` at its root or the pane throws and paints an empty box while
  the rail still looks healthy. Caught by `lab-boot-check.mjs`, which the
  scratch is now enrolled in.
- **A `Select` whose inherit option and current value share a `value` string**
  renders both labels into the trigger ("Same as Project chatsSame as Projec").

---

## Suggested build order

1. **Updates pane** — kills the sqlite command. Smallest, highest disgust.
2. **`kit.tsx` into `src/`** — the six rules, replacing `settings-shell.tsx`.
   Nothing user-visible moves yet.
3. **About** — absorbs CLI + Harness + Doctor; deletes two categories.
4. **`ScopeBar`** — Settings → Appearance absorbs Configure → Appearance.
5. **Configure → Skills + Commands** — surfacing data that already loads.
6. **Models restructure** — four sections, `ItemList`, the rename.
7. **MCP + Plugins** — the only genuinely new plumbing.
8. Notifications, Integrations, zoom, diff layout — one row each.

Steps 1–4 are independent of 5–7 and could run in parallel sessions; 2 should
land before 3 and 4.
