# Settings & Configure — the proposal (VC-111), second pass

Prototype: `pnpm lab` → **"Settings & Configure, reorganized"**.
Audit: `docs/plans/settings-audit.md` · Review that forced this rewrite:
`docs/plans/settings-redesign-review.md`.
Code: `src/renderer/lab/settings/` — `kit.tsx` is the proposal; the `panes-*.tsx`
are content poured into it.
Verification: `node apps/desktop/e2e/vc111-review-fixes.mjs` (25 checks, one per
review finding) plus enrolment in `lab-boot-check.mjs`.

---

## The split

**Scope is the surface.** Settings is app-wide, always. Configure is this
project, always. There is no scope switch anywhere.

|  | Settings | Configure |
|---|---|---|
| **Scope** | every project | this project |
| **Entry** | sidebar-footer gear | project nav tab |
| **Has** | General, Appearance, Notifications, Models, Web Search, Integrations, Storage, Updates, About | Skills, Commands, MCP Servers, Plugins, Sessions, Appearance, Worktrees |

The first pass called this "app preferences vs agent setup", which leaked in
five places at once (review §1.1). Scope is the boundary that survives, and it
still lands agent config in Configure — because agent config *is* project-scoped.

**Where a setting has two tiers**, it appears on both surfaces, the Configure
side carries `InheritControl`, and the pane states the resolution order. That
last part is what the first pass was missing, and its absence rebuilt the exact
desync the ticket is about.

---

## The eight rules (`kit.tsx`)

1. **Grouped, searchable rail.** Group labels are where the surface relationship
   is written down.
2. **Scope is the surface, not a mode.** One `InheritControl` idiom on Configure,
   one informational `OverrideNote` on Settings. The first pass's pane-level
   scope switch hid every row it couldn't scope, mis-framed the ones it kept,
   couldn't express a twelfth project, and took a hand-maintained count.
3. **One section header grammar** — icon · title · one action, with a primitive
   for each of the two legal action shapes.
4. **A setting is a row; a thing is an item.**
5. **One save model, and it can refuse.** `CommitField` validates, can be
   refused by the write, shows the refusal beside the field, confirms when
   destructive, and says "Saved" only after something was.
6. **One status vocabulary, three roles, three components** — `Health`, `Tier`,
   `Provenance`. Not one component with a boolean meaning two different things.
7. **Every pane declares its states.** `AsyncSection` owns loading / error+retry
   / empty / ready. This is the rule the first pass didn't have, and it governs
   the 80% of a settings surface that is state.
8. **Widths come from a ladder** (`CONTROL_W`), not eight ad-hoc classes.

**No section descriptions.** CLAUDE.md forbids them; the first pass added
thirteen. `PrefSection` has no `description` prop, so the rule is structural
rather than aspirational.

---

## What the review changed

| Review | Change |
|---|---|
| §2.1 | **Orphaned-worktree cleanup restored** as Settings → Storage, beside the retention window that governs it. The first pass dropped a live delete flow off the IA *and* the kill list. |
| §1.1 | Boundary redrawn as scope; **precedence published** (`ResolutionNote`) on Sessions, Skills, Commands, MCP. |
| §1.1, §1.3 | Three inheritance vocabularies → one `InheritControl`. |
| §1.2 | Pane-level `ScopeBar` deleted. Settings gets `OverrideNote`, which **names** the overriding projects instead of counting them, and derives from a list. |
| §1.4 | About keeps **per-fault remedies**. Healthy machine = one sentence; broken one grows a row per real problem. Legacy path shown. Harness inventory kept with command + origin. Copy report previews. |
| §1.5 | `CommitField` gains `validate`, `confirm`, async refusal, `disabled`, no clobber of in-progress edits. Retention confirms below 7 days; base branch refuses unknown refs; canary confirms. |
| §1.6, §7.1 | `AsyncSection` added. Width ladder added. `SectionIconAction` added. `Origin` split into `Tier` + `Provenance`. |
| §2.2 | Reasoning level restored. |
| §2.4 | Empty and no-results are separate strings. |
| §2.5 | Catalog search matches provider, so two `gpt-5.6-luna`s are distinguishable. |
| §2.6 | `.worktreeinclude` no longer a blur-saved textarea seeded with defaults — read-only until explicitly created. |
| §2.7 | Both Ghostty config buttons and the per-key revert restored. |
| §2.8 | Canvas keeps Vibrancy, Grain and ContrastAlert; rule 4 takes one **recorded** exception rather than being quietly broken. |
| §2.9 | Invented settings removed (`Reopen last project`, `Confirm before quitting`). |
| §2.10 | Integrations filtered by what's installed, with "Ask every time" and an empty state. |
| §2.11 | `testId` restored on `PrefRow`/`ItemRow`. |
| §3.1, §3.2 | `ItemList` takes data + a renderer, not children introspection; no magic `> 6`. |
| §4.1 | "Saved" rendered conditionally, so the live region can actually announce. |
| §4.2 | `InheritControl` requires a distinct `ariaLabel`. |
| §4.3 | Disclosure has `aria-expanded` + `aria-controls`. |
| §4.4 | Attention dot is `aria-hidden` **plus** an sr-only suffix — relocated, not deleted. |
| §4.5 | Help button is a sibling of the label, so it no longer toggles the control. |
| §4.6 | Real `InfoIcon`, not a unicode glyph. |
| §4.7 | Scroll container reset on pane change. |
| §4.8, §2.12 | `type="search"`, result counts in live regions. |
| §5.1 | Every section description removed; prop deleted. |
| §5.2 | `ContentColumn` + `PageHeader` composed, not re-derived. |
| §5.4 | A failed write can no longer read as "Saved". |
| §6.1–6.12 | Four factual errors corrected in the audit doc, inline. |

---

## Still open

- **`keywords` is hand-maintained** and will rot (review §1.6). Mitigation is a
  test asserting keywords against rendered labels; the real fix is deriving them.
- **200 skills render unvirtualized.** Fine at the real cap, worth knowing.
- **`Copy report…` needs a preview sheet** — designed as an intent, not built.
- **The canvas "Edit canvas…" affordance on Configure** needs a non-modal
  design, since a scrim over the window defeats the preview.
- **Deep-link migration**: `stores/ui.ts`'s `settingsCategory` uses
  `model-access`; the new key is `models`. Needs an alias, plus the
  auto-sign-in flow (review §2.3) which this prototype does not draw.

---

## Build order

1. **Updates pane** — kills the `sqlite3` command. Smallest, highest disgust.
2. **`kit.tsx` into `src/`**, replacing `settings-shell.tsx`. Nothing moves yet.
   Rules 3–8 land here, `AsyncSection` first.
3. **Storage** — retention + orphans + database in one category.
4. **About** — absorbs CLI + Doctor + harness inventory, with per-fault remedies.
5. **`InheritControl` + `OverrideNote`** — Configure → Appearance keeps its rows,
   Settings gains the override note.
6. **Configure → Skills + Commands** — surfacing data that already loads.
7. **Models restructure** — four sections, `ItemList`, precedence note.
8. **MCP + Plugins** — the only genuinely new plumbing.
9. Notifications, Integrations, zoom, diff layout — one row each.

1 and 3–4 are independent of 6–8; 2 gates everything.
