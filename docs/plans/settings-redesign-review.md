# Settings & Configure redesign — independent review (VC-111)

Read: `docs/plans/settings-audit.md`, `docs/plans/settings-redesign.md`,
`renderer/lab/settings/{kit,panes-settings,panes-configure}.tsx`,
`renderer/lab/scratches/settings-redesign.tsx`, and the eight app files they replace.
Every claim below is a file I opened.

The audit is good. The proposal is not the audit. Several of the audit's sharpest findings
(#14 reset-to-default, #17 unlabelled columns, #20 the reasoning select) are answered in the
proposal by **deleting the control that had the problem**, and one whole working pane
(orphaned worktrees, with its permanent-delete flow) disappears without appearing on the
kill list. The kit closes four drifts and opens five new ones, because it has no vocabulary
for the thing every real pane in this app actually is: asynchronous, failable, and empty
before it is full.

---

## 1. Claims that do not hold

### 1.1 "Settings = app preferences, Configure = this project's agent setup" is a boundary a user can hold

**Does not hold.** It is stated in `panes-settings.tsx:5-8` and the proposal's split table, and
it is contradicted by the proposal's own two panes.

Where it breaks, concretely:

- **Models are on both surfaces again.** `panes-settings.tsx:349` (Settings → Models → Defaults →
  "Ticket Sessions") and `panes-configure.tsx:300-311` (Configure → Sessions → "Model") are two
  controls that both decide which model a Ticket Session in this project runs. Nothing states
  precedence. The audit praised Claude Code for publishing a precedence table
  (`settings-audit.md` §1) and the proposal ships none. This is the ticket's headline "desync"
  complaint, rebuilt, in the same commit that claims to fix it.
- **Three inheritance vocabularies for one concept.** Settings says `"Same as Project chats"`
  (`panes-settings.tsx:481`), Configure says `"Same as Settings — claude-sonnet-4.6"`
  (`panes-configure.tsx:305`), and Appearance says `Inheriting <value>` via `InheritToggle`
  (`kit.tsx:279-311`). Rule 2 says scope is "one control, in one place". Two of these three are
  in-row selects, i.e. exactly the placement rule 2 forbids.
- **Web Search is agent tooling filed under Settings.** `WebPane` (`panes-settings.tsx:492`) is a
  provider + key for a tool the agent calls. MCP servers — also "tools and data the agent can
  reach" (`panes-configure.tsx:427`) — are filed under Configure. Under the stated boundary these
  belong on the same surface. Ask a user which page holds "the agent's ability to search the web"
  and the split gives them no answer.
- **Personal-tier skills are edited from a per-project page.** `main/skills.ts:110-127` merges
  `<project>/.agents/skills/` over `<home>/.agents/skills/`. `SkillsPane`
  (`panes-configure.tsx:118-152`) lists both tiers with a `Where` chip and one `Switch` per row —
  and the switch has no scope. Turning off the personal `mintlify` skill from inside `volli-code`:
  off everywhere, or off here? The prototype cannot say, and neither can the split. That is the
  audit's finding #1 ("mean different things in each") reproduced inside one pane.
- **"Terminal" now means two things inside Settings.** Appearance → Terminal is the embedded
  Ghostty surface (`panes-settings.tsx:255`); Integrations → Terminal is which external terminal
  app to hand a folder to (`panes-settings.tsx:562`). Audit finding #1 was that two surfaces
  shared category names meaning different things. The redesign moves that collision *inside a
  single surface*, one rail apart.
- **Worktrees are split by verb.** How a worktree is *made* is Configure → Worktrees
  (`panes-configure.tsx:340`); how long one is *kept* is Settings → General → Retention
  (`panes-settings.tsx:95`). Same object, two surfaces, and the retention row is the one that
  deletes things.

The boundary that would actually survive is not "app vs agent". It is **"applies to every project"
vs "applies to this one"** — which is the boundary `ScopeBar` already implements, and which the
proposal then declines to apply to Skills, Commands, MCP, Models or Harness.

### 1.2 A per-pane `ScopeBar` is better than today's per-row scope switches

**Partly holds, and the prototype demonstrates the failure.**

It is genuinely better in one respect: today's three placements (per-row in Configure → App theme,
section-header in Configure → Terminal, nowhere in Settings) are indefensible. But the pane-level
frame costs more than the proposal admits.

**a) It hides settings that are not scopeable.** `AppearancePane` at project scope renders only a
"Terminal theme" row (`panes-settings.tsx:256-262`); Font and Size vanish, because they are
global-only. A user who sets the scope to `volli-code` and looks for terminal font size concludes
Volli has no such setting. Today `appearance-settings.tsx:96-118` always shows all three.

**b) It lies about the settings it *does* keep.** The `Display` section — Zoom and Diff layout,
`panes-settings.tsx:212-243` — renders identically in both scopes with no inherit control. So with
"Applies to · volli-code" selected, two of the five settings on screen are app-wide and say
nothing about it. The bar's whole job is to frame the pane, and it frames two rows falsely.

**c) It cannot express one project's override while you look at another.** The `Segmented` has
exactly two options: `All projects` and *the selected project* (`kit.tsx:243-249`). With twelve
projects there is no way, from Settings, to learn that `acme-api` pinned light mode, no way to
clear it, and no list of which projects override what. "3 overridden in volli-code"
(`kit.tsx:261`) answers a question about the project you happen to have selected, which is rarely
the project you are wondering about. Today's `CanvasShadowedNote`
(`appearance-settings.tsx:180-187`) has the same limit but does not claim to have solved it.

**d) `overrides` is a hand-maintained duplicate of the pane's contents.** It is a number prop
(`kit.tsx:232-238`) passed literally as `overrides={1}` (`panes-settings.tsx:155`). Nothing derives
it from the rows. Add a scopeable row and forget to bump the count and the bar is silently wrong —
which is the exact class of drift the six rules exist to close. The centrepiece of rule 2 is itself
a drift generator.

**e) No project selected.** Settings is app-wide chrome opened from the sidebar-footer gear
(`stores/ui.ts:16`, `settingsOpen`), reachable with no project selected — `ConfigurePage` has an
explicit "Nothing to configure / Select a project first" state for exactly this
(`configure-page.tsx:34-46`). `ScopeBar`'s `projectName` is a required non-nullable `string`
(`kit.tsx:231`) and the prototype hardcodes `PROJECT_NAME = "volli-code"`
(`panes-settings.tsx:72`). The state is not designed.

**f) A long project name breaks the control.** The second segment's label is the raw project name
(`kit.tsx:247`). `Segmented` renders labels into `Button`s with no truncation
(`ui/segmented.tsx:70-88`). A 60-character monorepo folder name blows the bar out of the 720px
`max-w-content` measure. `ItemRow` and the rail button truncate; `ScopeBar` does not.

**What per-row switches express that `ScopeBar` cannot:** the *simultaneous* view. Today
Configure → App theme shows mode-inherited-and-canvas-custom on one screen with both app-wide
values named inline (`project-appearance-settings.tsx:188-231`). Under `ScopeBar` you can never see
the app-wide column and the project column at once — you toggle between them, and the app-scope
view degrades to a scalar count.

### 1.3 Theming into Settings-with-scope + agent config into Configure is coherent

**Does not hold as stated, and the proposal breaks its own rule proving it.**

The theming half is defensible: theming is a preference and `ScopeBar` is a real control. The
problem is that the proposal does not apply the same reasoning to the settings that are *also*
per-project. `SessionsPane` (`panes-configure.tsx:280-322`) introduces per-project harness and
per-project model as bare `Select`s whose inherit option is a string in the dropdown. So the app
ends up with:

- scope-as-a-bar (Appearance),
- scope-as-a-select-option (Sessions → Model, Sessions → Harness),
- scope-as-a-chip-with-no-control (Skills/Commands `Where`, which shows provenance but offers no
  way to change it).

Rule 2 says "scope is one control, in one place: the pane header … never a row". `panes-configure.tsx`
violates it twice, in the file that ships with the rule.

And the line itself is arbitrary in the direction the ticket warned about: a user who has just
learned that per-project things live in the per-project place will go to Configure to theme a
project, find Appearance gone, and have to be told the rule. The proposal has no answer for that
first-run moment — no redirect row, no "Appearance moved to Settings" affordance.

### 1.4 Collapsing CLI + Harness Runtimes + Doctor into one "About" pane loses nothing needed

**Does not hold.** This is the weakest claim in the proposal. Read `cli-status-model.ts` and the
losses are enumerable:

1. **The legacy-link remedy needs the path it refuses to print.**
   `cli-status-model.ts:233-240` reports `"Another volli sits in /usr/local/bin"` with
   `detail: status.legacy.path`, and the `ours` variant says *"Admin-owned; harmless, and safe to
   delete yourself."* (`:225-232`). The user cannot delete a file whose path the UI has decided is
   an internal. `AboutPane` promises "still no paths" (`panes-settings.tsx:634`, `:679`).
2. **`installSuppressed` has a named recovery.** `cli-status-model.ts:133-140`:
   `"Removed"` → *"Reinstall from File → Install Volli CLI & Agent Skills."* One health dot cannot
   carry a menu path, and the `HealthSummary` failure card takes exactly one `Fix this` button.
3. **Four distinct `link.state`s need four different remedies** — `ours`, `missing`, `foreign`
   ("Owned by another tool"), `not-symlink` ("A file of yours holds the name")
   (`cli-status-model.ts:126-155`). "Everything's working" / "isn't working" is one bit over a
   four-state space.
4. **Doctor's per-check `remedy` strings are dropped.** `cli-settings.tsx:222-236` renders
   `check.title` / `check.detail` / `→ check.remedy` per check plus a summary, with **Fix & Re-run**
   available both from the footer and from the error state (`:200-210`). `AboutPane` has neither
   `--fix` nor per-check remedies. `Fix this` is one button over an N-check report where some checks
   are fixable and some are not.
5. **`SessionPathComparison`'s `pending` state has no representation.** `cli-status-model.ts:105-116`
   deliberately distinguishes `pending` from `matching` and `diverged` because the interactive PATH
   pass is asynchronous — and CLAUDE.md's *Session environment* section makes `pending` a documented,
   user-facing concept ("`pending` is not a failure"). A single `StatusDotState` must call it healthy
   or unhealthy; both are wrong. The whole PATH comparison table
   (`session-path-comparison.tsx`, coverage-enrolled) has no home.
6. **The CLI read is project-scoped and About is not.** `cli-settings.tsx:60-63` passes
   `cwd: projectCwd` so the status can report the selected project's git credential-helper chain.
   `AboutPane` has no project notion at all, so that truth is simply gone.
7. **Harness identity is more than a comma list.** `harness-picker.tsx:127-145` shows the
   *resolved command* per harness and a Built-in/Registered origin chip. A user who installed a
   harness manifest and wants to know whether Volli sees it, and which binary it will launch, loses
   that entirely to `DetailLine label="Harnesses" value="Claude Code, Codex"`
   (`panes-settings.tsx:657`) — which is `truncate`d with no `title` (`kit.tsx:691-698`), so with
   five harnesses it shows an ellipsis and nothing else.
8. **`HealthSummary` has no composition rule for N faults.** The CLI can be simultaneously
   not-on-PATH, socket-down and shadowed by a foreign legacy link. The prototype stacks two
   `HealthSummary` cards (`panes-settings.tsx:648-687`) but presents that as "the failure state
   shown for comparison", not as a rule. "One sentence, one button" is a claim about the happy path.
9. **"Copy report" is unreviewable.** For a local-first app whose whole posture is that data stays
   on the machine, a button that puts `binDir`, socket paths, `$PATH`, home directory and usernames
   on the clipboard *without showing them* is worse than printing them. The user cannot see what
   they are about to paste into a public issue. And `Copy report` has no primitive in `kit.tsx` —
   it is a bare `Button` (`panes-settings.tsx:653`).

There is a real finding underneath this claim (the CLI pane *is* too raw), but "loses nothing a
user genuinely needs" is false at least nine times.

### 1.5 "Everything saves on change" is right

**Holds as a principle, fails as implemented.** The audit's #4 complaint is about *inconsistency*,
and one rule is better than five exceptions. But `CommitField` (`kit.tsx:537-600`) cannot express
the three things those Save buttons were actually carrying: **validation before write, a disabled
state, and an error slot.** Concretely:

- **Retention TTL is destructive and unvalidated.** `parseTtlDaysInput`
  (`settings-page.tsx:126-129`) rejects blanks and sub-1 values and toasts; the field is `disabled`
  while loading and saving; the input reflects main's *clamped* value back. `CommitField` sends the
  raw string on blur (`kit.tsx:564`), has no `disabled` prop, no validation hook and no error slot.
  Select-all-and-type-`1`-then-click-away now commits a 1-day retention. That setting drives an
  automatic sweep that **removes worktree folders** (`settings-page.tsx:136-146`). There is no undo
  and no confirm. This is the clearest case where commit-on-blur is wrong.
- **The web API key must not commit on blur.** `web-access-settings.tsx:248-260`: Save is disabled
  while `key.trim() === ""`, plaintext is cleared from React state the moment main confirms, there
  is a **Remove** action, and a three-state label (`Not set` / `Stored in your keychain` /
  `Stored, but unreadable here`, `:55-59`). The prototype's `WebPane`
  (`panes-settings.tsx:514-524`) hardcodes `<Origin mine>In your keychain</Origin>` — a claim that is
  false whenever no key is stored — drops Remove, and holds the plaintext in `draft` +
  `committed.current` for the life of the mount. Blurring a half-pasted key replaces a working one.
- **The SearXNG endpoint has a refusal that needs somewhere to land.** A rejected instance URL comes
  back as an endpoint-policy sentence rendered *beside the field*
  (`web-access-settings.tsx:110-114`, `:268-270`) precisely because it is a correction to what the
  user just typed. `CommitField` has no error affordance, so that refusal has to become a toast —
  regressing a decision the file documents in its header.
- **Base branch commits an unverified ref.** `configure-page.tsx:110-121` at least gates on a
  `saving` flag; neither version validates that the ref exists. Commit-on-blur makes the failure
  surface later, at worktree creation, far from the field. A blur-commit is fine *if* the field can
  show `Branch "mian" not found` inline. It cannot.
- **`Channel: Canary`** (`panes-settings.tsx:614-622`) is a one-click switch to a build line that
  ships broken work and cannot be trivially downgraded. Save-on-change with no confirm is the wrong
  default for it.
- **`CommitField`'s `useEffect` clobbers an in-progress edit.** `kit.tsx:552-555` resets `draft`
  whenever the `value` prop changes. In the real app, values arrive from a store/bridge, so a
  background refresh mid-typing wipes what the user is typing. The existing fields key their reset
  on `project?.id` for exactly this reason (`configure-page.tsx:105-107`).

So: keep the rule, but `CommitField` needs `disabled`, `error`, and a `validate` that can *refuse*
a commit and hold the draft. Retention and base branch additionally need commit-on-Enter-only, or a
confirm.

### 1.6 The kit's six rules are complete

**No.** Drift still permitted under all six:

- **No async vocabulary at all.** Every real pane in this app has loading / error / retry states —
  `WorktreesSettings`, `CliSettings`, `WebAccessSettings`, `ModelAccessSettings`,
  `ProjectAppearanceSettings` all render `Notice` + retry (e.g. `settings-page.tsx:305-320`,
  `cli-settings.tsx:151-165`). `kit.tsx` has **zero** primitives for loading, error, retry or
  disabled-with-a-reason. Every pane will therefore invent its own — which is precisely the drift
  rules 3 and 6 were written to stop. This is the single biggest hole in the kit.
- **No rule for control width.** The prototype uses `w-72`, `w-56`, `w-48`, `w-40`, `w-32`, `w-24`,
  `w-20`, `w-10` across two files. The right edge is ragged and nothing governs it.
- **No rule for in-row button size.** `PrefRow` children use `size="sm" variant="outline"`
  (`panes-settings.tsx:206`), `ItemRow` children use `size="icon-xs" variant="ghost"`
  (`panes-configure.tsx:141`), `SectionAction` hardcodes `size="xs" variant="outline"`
  (`kit.tsx:701-713`). Three rungs, no rule. Rule 3 governs only the header slot — and it names two
  legal shapes while `SectionAction` implements one, so the `icon-xs` ghost variant has no
  primitive and will be hand-rolled forever.
- **Rule 6 is violated inside the file that ships it.** `Health` is passed as `badges`
  (`panes-settings.tsx:437-441`) — health drawn in the identity slot. `Origin` is used for a
  key-*state* rather than provenance (`:516`). And `Origin`'s `mine` prop means "Volli set it" in
  Settings and "this project" in Configure (`panes-configure.tsx:73-76`) — one prop, two meanings,
  which is the definition of the drift rule 6 forbids.
- **`keywords` is a hand-maintained index.** `kit.tsx:71` + `panes-settings.tsx:748-757`. Add a row,
  forget a keyword, it is unfindable. The prototype already demonstrates the failure: the Models
  category advertises `"reasoning"` (`panes-settings.tsx:755`) and the pane has no reasoning control.
- **Nothing about reset-to-default.** Audit #14 said there is none anywhere. It is not on the kill
  list, not in the six rules, and the one place it existed —
  `appearance-settings.tsx:211,221-235`'s per-key `RevertButton` — is deleted by the redesign (§4.3).
- **Nothing about destructive confirms.** `AlertDialog` usage (`settings-page.tsx:437-461`,
  `Sign out`, `Delete worktree`) is ungoverned.

---

## 2. What is missing entirely

**2.1 Orphaned-worktree cleanup is silently deleted.** `SETTINGS_GROUPS`
(`panes-settings.tsx:701-806`) has eight categories and none of them is Worktrees. Today
`settings-page.tsx:103-107` → `DirtyWorktreesList` (`:236-465`) is a real feature: the dirty-orphan
list with per-row Reveal/Delete, a confirm dialog, the "Removed when Volli started — the branches
are still in git" report, and the "Kept for now, removable after `<date>`" report. The audit's §5.B
said it should move to a Diagnostics area; the proposal has no such area, `AboutPane` does not
contain it, and it is not on the kill list. A working data-safety surface vanishes without anyone
deciding to remove it. **This alone blocks implementation.**

**2.2 The reasoning-level control is deleted.** `model-access-settings.tsx:387-405` is a live
per-purpose `Select` over `model.reasoningLevels`. Audit #20 correctly says it is naked and gives no
disabled reason. The proposal's `ModelSelect` (`panes-settings.tsx:471-490`) does not have it at
all. A setting that costs money and changes output quality is not fixed by removing it.

**2.3 The Model Access deep link and auto-sign-in flow.** `stores/ui.ts:221,237` +
`settings-page.tsx:75-79` + `chat-plane.tsx:906`: a blocked chat opens Settings **on the
`model-access` category with a provider to sign in to**, consumed once
(`model-access-settings.tsx:99-108`). The proposal renames the category to `models` with no
migration note, and `AboutPane`/`ModelsPane` have no sign-in-in-progress, cancel, or retry state —
today that is a whole component (`model-access-accounts.tsx`) with its own conversation. There is an
e2e smoke for it (`e2e/model-access-signin-smoke.mjs`).

**2.4 Every empty and error state.** `ItemList` (`kit.tsx:480-520`) has one string, `empty`, used
for "no results match your filter". There is no separate **zero items** state, so a project with no
skills renders *"No skills match."* when nothing was searched. Also unaddressed: 200 skills (the
real cap — `main/skills.ts:47` `MAX_SKILLS_PER_DIR = 200`) rendered as 200 unvirtualized `ItemRow`s;
a skills directory that exists but cannot be read (`skills.ts` returns `{ok:false}` and the proposal
has no error row); zero providers signed in; offline; a provider that signs out mid-session; first
run with nothing configured.

**2.5 Duplicate model names across providers.** `model-access-settings.tsx:520-535` documents that
*"eight providers ship a model called exactly 'GPT-5.6 Luna'"*, which is why today's list is
**grouped by provider** and the picker label is `"<model> · <provider>"`. The proposal's Catalog
drops the grouping (`panes-settings.tsx:404-437`), keys rows by `model.name`, and `ItemList` filters
on `name` only — so searching `anthropic` matches nothing even though the provider is right there in
`meta`, and two identically-named models from different providers collide.

**2.6 The `.worktreeinclude` editor is a trap.** `panes-configure.tsx:358-370` is a `Textarea` with
`defaultValue` seeded with *the built-in defaults* and no commit affordance at all (violating rule 5
in the file that ships it). Blur-saving that would **materialize a file that did not exist**,
freezing today's defaults into the repo so future default changes stop applying. It is also a
tracked repo file: writing it from Settings creates an uncommitted working-tree change, possibly
inside a worktree. No "file absent" state, no read-only-repo error, no diff-from-default view.

**2.7 The Ghostty escape hatch is removed.** Today Appearance → Config files has two buttons —
**Ghostty config** and **Volli overlay** (`appearance-settings.tsx:100-118`) — and Configure has
**This project's overlay** (`project-appearance-settings.tsx:331-343`). The proposal collapses all
of it into one `SectionAction label="Open overlay"` (`panes-settings.tsx:259`) which names no file
and, at project scope, cannot say which of the two overlays it opens. Decision #67/#68 is that *the
file is the full interface*; keeping the trust sentence while removing the button that proves it is
the wrong half.

**2.8 The canvas editor is 90% larger than the row it becomes.** `CanvasEditor`
(`canvas-editor.tsx:1108-1168`) is not just a gradient pad: it is the pad, the stop row, the primary
colour picker, **and two more `SettingsRow`s (Vibrancy, Grain) plus `ContrastAlert`** — an
accessibility guardrail with a one-click "ease" remediation. `panes-settings.tsx:198-211` replaces
all of it with a swatch and an `Edit…` button opening something that does not exist, is not
designed, and is not in the build order. Worse: the editor's value is that it previews live against
the real window, and any modal that opens over it will paint `bg-scrim` across the thing being
judged (`docs/DESIGN.md`, Alpha section). "Every control is a row" is the one rule that does not
survive this pane.

**2.9 Two invented settings with no backing state and one that is an anti-feature.**
`GeneralPane` (`panes-settings.tsx:78-88`) adds *"Reopen the last project on launch"* — no such
persisted state exists in `src/main` — and *"Confirm before quitting with live sessions"*, which is
a switch that disables `quit-gate.ts`, a documented data-loss guard whose header explains that
turning it off previously *"took the work the user had just chosen to keep"*. Neither is in the
audit. `NotificationsPane`'s five per-event switches (`:293-341`) likewise have no persisted state
and no IPC.

**2.10 Integrations ignores app detection.** `main/external-apps.ts:20-33` has nine apps *and a
`findBundle` probe* — the catalogue is filtered to what is installed. `IntegrationsPane`
(`panes-settings.tsx:541-580`) hardcodes the list, has no "not installed" state, no "ask every time"
option, and no empty state when none of the nine are present.

**2.11 Test and coverage impact is not mentioned anywhere.** `PrefRow` (`kit.tsx:391-441`) drops
`SettingsRow`'s `testId` prop, which exists specifically to address Model Access's forty
identically-shaped rows (`settings-shell.tsx:229-236`). Breaks: `model-access-settings.test.tsx`
(`default-model-*`), the `visibility-*` / `compaction-reserve-*` / `auto-compaction` ids, and the
`appearance-mode` / `project-appearance-*` ids consumed by `e2e/canvas-theming-smoke.mjs:371-1198`.
Separately, CLAUDE.md's coverage gate holds a protected renderer surface at 100%, and
`cli-status-model.ts` says in its own header that it is enrolled *because these mappings decide what
a user is told*. Collapsing CLI into a sentence orphans it and requires a new enrolled pure fold
(status → headline) that the proposal does not describe.

**2.12 No keyboard entry to the new search, and no Escape story.** The rail search
(`kit.tsx:132-146`) has no shortcut, no `type="search"`, no result-count live region, and no clear
button. Settings is an overlay; nothing says whether ⌘F reaches the field or whether Escape closes
the overlay or clears the query.

---

## 3. What is over-built or will not survive real data

**3.1 `ItemList` introspects its children.** `kit.tsx:487-500` types `children` as
`readonly React.ReactElement[]` and filters on `String(child.props.name)`. This breaks on: a single
child, a conditional child, a fragment, a `.map()` result nested one level, and any wrapper
(`memo`, `Tooltip`) around `ItemRow`. It also contradicts `ItemRow`'s own type — `name` is
`React.ReactNode` (`kit.tsx:449`), so a `<span>` name filters as `"[object Object]"`. This should
take data plus a render function, not children.

**3.2 `children.length > 6`.** `kit.tsx:502` — a magic threshold that hides the search field on the
seven-item list you might still want to search, and shows it on the seven-item list you do not.

**3.3 The fake table in Catalog.** `panes-settings.tsx:412-416` hand-writes `w-40` and `w-10`
header spans to line up with a `w-40` `SelectTrigger` and a `w-10` switch cell, with a comment
claiming they "MATCH the controls below … rather than being eyeballed". They are duplicated magic
numbers in two places, which is eyeballing with extra steps — and it breaks with real data:
`CompactionReserveSelect` **returns `null`** for any model whose window yields no reserve choices
(`model-access-settings.tsx:445-447`), at which point the switch slides left and sits under the
"Compaction reserve" header.

**3.4 `PrefSection` is a byte-for-byte fork of `SettingsSection`.** Compare `kit.tsx:322-360` with
`settings-shell.tsx:118-172` — same markup, same classes, same `first:`-wrapper comment. The build
order says "kit.tsx into src/ … replacing settings-shell.tsx", so this is a fork of a live component
with existing consumers, presented as a new primitive.

**3.5 `Origin` and `SectionAction` are one-line wrappers that weaken their rules.** `Origin`
(`kit.tsx:626-628`) is `<Badge variant={mine ? "accent" : "outline"}>` — the same component rule 6
assigns to *identity*, so the "three drawings" are two components and a boolean. `SectionAction`
implements one of rule 3's two legal shapes.

**3.6 `CommitField`'s `width` prop is a raw Tailwind class string** (`kit.tsx:542`) — a leak of the
ungoverned-widths problem into the primitive's API.

**3.7 `HealthSummary` carries `state` + `headline` + `detail` + `actions` + disclosure children**
for two call sites, while the actually-needed primitive (Copy report, and a rule for N faults) is
absent.

---

## 4. Accessibility and keyboard problems in the proposed primitives

**4.1 The "Saved" live region can never announce, and always reads.** `kit.tsx:575-584`: the span's
text is the constant string `"Saved"`; only `opacity` changes. `aria-live` fires on *content*
change, so a screen reader will never announce a save — and because `opacity-0` leaves the node in
the accessibility tree, every `CommitField` on the page reads "Saved" permanently, whether or not
anything was saved. Both halves are wrong. It needs conditional rendering (or `visibility`) with the
text inserted on commit.

**4.2 Every `InheritToggle` has the same accessible name.** `kit.tsx:297` hardcodes
`ariaLabel="Scope"`. A pane with mode, canvas and terminal inherit switches announces three groups
called "Scope". Today's code is careful about exactly this: `"Appearance scope"`, `"Canvas scope"`,
`"Terminal theme scope"` (`project-appearance-settings.tsx:184,210,314`). This is a straight
regression.

**4.3 The disclosure has no `aria-expanded` or `aria-controls`.** `kit.tsx:673-682` toggles
`open` and swaps the label text only.

**4.4 `aria-hidden` status dots make rail state invisible to screen readers.** The proposal presents
this as a correction it earned (`panes-settings.tsx:783-788`, `panes-configure.tsx:410-412`). It
half-is: naming the dot poisons the button name, true. But `aria-hidden` means a blind user gets
*no* signal that an update is ready or that an MCP server is failing without entering every pane.
The fix is a visually-hidden suffix or an `aria-description`, not deletion.

**4.5 The help button lives inside its row's `<label htmlFor>`.** `kit.tsx:398-408` — clicking the
tooltip trigger also activates the labelled control, so pressing "what is this?" next to a `Switch`
toggles the switch. Inherited from `settings-shell.tsx:213-223`, but the kit re-ships it while
claiming to have fixed the drift.

**4.6 The help glyph regressed from an icon to a text character.** `kit.tsx:370-373` renders a
literal `ⓘ` at `text-label` where the shell renders `<InfoIcon className="size-3.5" />`
(`settings-shell.tsx:196`). The docstring says *"kept from today's shell, unchanged"* — it is not
unchanged. A unicode glyph does not participate in the Phosphor weight/size language CLAUDE.md
governs, and renders differently across fallback fonts.

**4.7 Pane switching keeps the scroll offset.** `kit.tsx:185-196` keys the inner `div` but the
scroll container is the unkeyed parent, so leaving a scrolled Models pane for Web Search lands on
blank space. No focus is moved to the new pane heading either.

**4.8 `useCategoryFilter` result-count is never announced**, and "No settings match" (`kit.tsx:176`)
is not in a live region.

---

## 5. Where the proposal violates the repo's own rules

**5.1 CLAUDE.md, "UI copy: let controls talk" — violated repeatedly.** The rule is explicit: *do not
add `description` on `SettingsSection`/`SettingsRow`, tutorial tooltips, or paragraphs under
controls unless the user asked.* The prototype adds section descriptions to Data
(`panes-settings.tsx:113`), Defaults (`:353`), Compaction (`:389`), Catalog (`:401`), "Tell me when"
(`:317`), Integrations (`:546`), Skills (`:132`), Commands (`:170`), MCP (`:206`), Plugins (`:242`),
Sessions (`:285`, `:314`), Worktrees (`:355`); plus category descriptions on six rail entries; plus
two *new* tooltips (`:363`, `:611`); plus `ScopeBar`'s "Anything left on Inherit follows All
projects." (`kit.tsx:267`). `appearance-settings.tsx:36-38` carries an explicit handoff note — *"UI
slop pass stripped tutorial descriptions/tooltips from this pane … Don't add helper text back"* —
and the redesign adds it back.

**5.2 DESIGN.md, `<PageHeader>` is "the page-level header, and the only one … Board and both
settings shells compose it; nothing re-derives a title row."** `PrefShell` re-derives it:
`kit.tsx:187-192` inlines `mx-auto w-full max-w-content px-gutter` (i.e. `<ContentColumn>` copied as
a string, which DESIGN.md's opening principle names as the failure mode) and a hand-rolled
`<h1 className="text-heading font-semibold">` instead of `<PageHeader variant="reading">`.
`settings-shell.tsx:87-93` does it correctly today.

**5.3 DESIGN.md spacing ladder.** `kit.tsx:663` uses `mt-1.5`, a half-step; DESIGN.md says the
half-steps "are gone" with five recorded exceptions, and this is not one of them.

**5.4 CLAUDE.md, "Surface every failed mutation".** `CommitField` has no failure path — `onCommit`
returns `void` and the field shows "Saved" unconditionally the moment the draft differs
(`kit.tsx:562-567`), before anything has been persisted. A failed write shows "Saved".

---

## 6. Factual errors in the audit and the proposal

1. **"The three Input+Save rows are the *only* three"** (`settings-audit.md` §2.4) — the same
   sentence lists five, and there are five: retention (`settings-page.tsx:213`), base branch
   (`configure-page.tsx:133`), setup command (`:172`), **Save instance**
   (`web-access-settings.tsx:201-210`), **Save key** (`:248-260`). `kit.tsx:530` repeats "three";
   the proposal doc and kill list say five. Three statements, two numbers.

2. **"you have to hover for the `aria-label` to learn which is which"** (audit #17) — false, and it
   understates the problem. `aria-label` is not a hover affordance; neither the reserve
   `SelectTrigger` (`model-access-settings.tsx:453-457`) nor the visibility `Switch` (`:271`) has a
   `title`. Hovering shows nothing at all.

3. **"harness-settings.tsx … Its own doc comment says the last configurable row 'was retired'"**
   (audit #8) — that comment is in `harness-picker.tsx:122-125`, not `harness-settings.tsx`.

4. **The kill list says delete "`harness-picker.tsx`'s unused second consumer" while the proposal
   builds that exact consumer.** `panes-configure.tsx:290-299` adds a per-project Harness select —
   which is precisely the "Configure gained a Runtime category" caller
   (`harness-picker.tsx:5-8`) the audit (#9) said never existed. You cannot delete the abstraction
   and ship its caller in the same plan.

5. **"Section header actions have four different shapes"** (audit #5) vs **"five idioms"**
   (`kit.tsx:317-320`) — the audit names four idioms across five panes. And both undercount: there
   is a fifth idiom, a `Badge` in the action slot (`harness-picker.tsx:131`, `OriginChip`), which
   rule 3 has no home for.

6. **"No 'reset to default' anywhere except terminal overlay revert"** (audit #14) — also `Project
   default` (`model-access-settings.tsx:378`) and `Default reserve` (`:465`) are resets-as-values,
   and Configure's `Inherit` is a reset that clears the stored column
   (`project-appearance-settings.tsx:196`). Minor, but the finding is used to justify a change that
   never lands.

7. **"today a skill on disk is a skill in the model's index, and the only way to remove it is to
   move the directory"** (`panes-configure.tsx:113-116`) — false. `main/skills.ts:19-21` and `:103`
   read `isUserInvokeOnly` from frontmatter `metadata` precisely so a skill can keep itself out of
   the model's index. The capability exists; what is missing is a UI for it.

8. **"`main/skills.ts` and `main/prompt-templates.ts` already read those directories on every
   composer open"** (proposal, `settings-redesign.md`) — the read is on the `volli-fs` path
   (`main/volli-fs.ts:1415`) and at session creation (`session-runtime/sessions.ts:311-349`). "Every
   composer open" is stated three times and is not what the call sites show. The weaker true claim
   ("this data already loads") is enough.

9. **`ScopeBar`'s docstring says "Cursor's Customize page filters by scope in exactly this
   position"** (`kit.tsx:213-217`) — Cursor's scope filter selects *user / workspace / team*, three
   tiers, on a page listing *items*. `ScopeBar` is two tiers on a page of *settings*, and the audit
   itself (§1) describes Cursor's control as a filter over a merged list, which is a different
   object from a mode switch that swaps a pane's contents. The precedent is being cited for a
   control it does not describe.

10. **`WebPane` states a falsehood in the prototype**: `<Origin mine>In your keychain</Origin>`
    renders unconditionally (`panes-settings.tsx:516`), including when no key is stored — where
    today's pane says `"Not set"` (`web-access-settings.tsx:55-57`).

11. **The Models category advertises a control it does not contain** — `keywords: [... "reasoning"]`
    (`panes-settings.tsx:755`) against a pane with no reasoning control.

12. **"Harness Runtimes … it is a *diagnostic*"** (audit #8/#10) — half wrong. `HarnessSelector`
    lists user-installed manifest harnesses (`harness-picker.tsx:83-88`), so the pane is the only
    surface that answers "did Volli pick up the harness I registered". That is closer to an
    inventory than a diagnostic, and it is why collapsing it to a comma list loses something.

---

## 7. The three changes I would insist on before implementation

### 7.1 Add the async vocabulary to `kit.tsx`, and give `CommitField` a way to refuse

The kit cannot ship without `PrefLoading` / `PrefError` (retry-bearing, matching today's `Notice`
usage), a disabled-with-reason affordance, and a `CommitField` whose `onCommit` returns
`Promise<{ok: true} | {ok: false, error: string}>` — rendering the error **beside the field**,
holding the draft, and only then showing "Saved" (rendered conditionally, not opacity-faded, so the
live region actually announces). Retention TTL and base branch additionally get commit-on-Enter or a
confirm, because one of them deletes folders and the other silently mis-points every future
worktree. Until this exists, rules 3 and 6 govern the 20% of a settings pane that is happy-path
chrome and nothing governs the 80% that is state.

### 7.2 Redraw the boundary as scope, not as subject — and decide the six ambiguous settings in writing

"App preferences vs agent setup" puts models on both surfaces, web-search and MCP on opposite
surfaces, personal skills on the project page, and two different "Terminal"s in one rail. Either:

- **(a)** make it explicitly a scope split — Settings is *All projects*, Configure is *this project*,
  and every pane that can be scoped carries `ScopeBar` including Models, Harness, Skills and
  Commands; or
- **(b)** keep the subject split and publish a precedence table (the thing the audit correctly
  praised Claude Code for) covering: project chat model, ticket-session model, per-chat `/model`,
  harness, web search, skills tier, and appearance.

Also required before any of it: fix `ScopeBar`'s three unhandled states — **no project selected**
(`projectName` must be nullable and the bar must collapse), **non-scopeable rows shown under a
project scope** (they must be marked or moved), and **long project names** (truncate the segment).
And derive `overrides` from the pane's rows rather than passing an integer by hand.

### 7.3 Nothing gets deleted that a user can currently act on — the About collapse is re-scoped, and orphan cleanup keeps a home

Before implementation, produce a line-by-line disposition for every control that disappears. The
list I found: orphaned-worktree cleanup and its delete flow; the reasoning-level select; the
per-key terminal `RevertButton` (the app's only reset-to-default); the Ghostty-config and
per-scope-overlay reveal buttons; terminal font-family and font-size at project scope; the canvas
editor's Vibrancy, Grain and `ContrastAlert`; the web key's `Remove` and its three-state label;
Doctor's `--fix` and per-check remedies; the legacy-link path; `installSuppressed`'s reinstall
remedy; `SessionPathComparison`'s `pending`; harness command + origin; the `model-access` deep-link
key and the sign-in flow it carries; and every `data-testid` consumed by
`model-access-settings.test.tsx`, `appearance-settings.test.tsx` and
`e2e/canvas-theming-smoke.mjs`.

"Concise" is right for About. "One sentence over a four-state link, an N-check doctor report and a
tri-state PATH comparison" is not concision, it is a lossy cast. The shape that works is the one
`cli-status-model.ts` already implies: **one headline plus a list of the faults that are actually
present**, each with its own remedy button, and `Details` for the rest. That is still one sentence
on a healthy machine, which is the case the brief was written about.
