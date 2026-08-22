# Settings & Configure redesign — second adversarial review (VC-111)

Reviewer read: `CLAUDE.md`, `AGENTS.md`, `docs/DESIGN.md`, `docs/plans/settings-redesign.md`,
`docs/plans/settings-redesign-review.md` (the first independent review),
`apps/desktop/src/renderer/lab/settings/{kit,panes-settings,panes-configure}.tsx`,
`apps/desktop/src/main/{skills,prompt-templates,volli-fs}.ts`,
`apps/desktop/src/renderer/src/components/ui/list-row.tsx`,
`apps/desktop/src/renderer/src/components/pages/settings-shell.tsx`,
and the e2e check file.

The first review caught the big structural issues — orphan cleanup, async vocabulary, CommitField
refusing a value. Those were fixed. This review attacks what is left: the newest code (`DataTable`),
the boundary question, the plumbing gap, accessibility, and the production handoff.

---

## Blocking findings

### B1. DataTable: `tableLayout: fixed` + CSS grid track syntax in `<col>` is malformed

**File:** `kit.tsx:886-892`

```tsx
<table className="w-full border-collapse" style={{ tableLayout: "fixed" }}>
  <colgroup>
    {columns.map((column) => (
      <col key={column.key} style={{ width: column.width }} />
    ))}
  </colgroup>
```

The `Column.width` docstring says "A CSS grid track: `minmax(0,1fr)`, `8rem`, `auto`" (line 768).
Grid track syntax (`minmax()`, `fr` units) is not valid for `<col width>` under `table-layout: fixed`.
The spec for fixed layout is: the first row's column widths plus explicit `<col>` widths set the
column. `<col style="width: minmax(0,1fr)">` is not parsed as anything useful — the browser ignores
it and falls back to content-based auto-sizing, defeating the whole point of `tableLayout: fixed`.

Checked: `panes-settings.tsx:565` (`width: "minmax(0, 1fr)"`) and `panes-configure.tsx:211`
(`width: "minmax(0, 1.4fr)"`) both pass grid syntax. These columns currently size by content anyway,
but the code is promising an API it cannot deliver, and it will break the moment someone expects
`minmax(0,1fr)` to mean "grow proportionally and not overflow" — the claim the docstring makes.

**Fix:** Document that `width` must be a raw length (`8rem`, `100px`) or a percentage (`40%`). Or
switch from `tableLayout: fixed` + `<colgroup>` to CSS Grid (`display: grid`, `grid-template-columns`)
on the row — then grid track syntax is valid, but you lose native `<table>` semantics (the header
must carry `role="row"` / `role="columnheader"` explicitly). The simpler fix is to stay with the
table, disallow `fr` / `minmax`, and size proportional columns as percentages.

---

### B2. InfoHint: `onOpenAutoFocus` prevents keyboard interaction with links in the panel

**File:** `kit.tsx:192-195`

```tsx
onOpenAutoFocus={(event) => event.preventDefault()}
```

The docstring (lines 130-135) says a hint that needs a link gets `interactive`. But
`onOpenAutoFocus={(event) => event.preventDefault()}` stops focus from ever entering the popover.
A keyboard user who Tabs to the `(i)`, presses Enter/Space, and then presses Tab again will jump
*past* the panel's link to the next element on the page — the link inside is unreachable. A
screen reader in virtual-browse mode might read the link's text, but activating it (Enter) will
do nothing because the panel still has `pointer-events-none` (line 191) when `interactive=false`.

**Attempted use:** The plan doc (`settings-redesign.md`) says InfoHint can carry links. The code
disables focus entry regardless of `interactive`, so no link is ever reachable by keyboard.

**Fix:** When `interactive=true`, do not prevent `onOpenAutoFocus` — let the first focusable element
inside receive focus. Alternatively, add `onOpenAutoFocus={interactive ? undefined : (e) => e.preventDefault()}`.

---

### B3. CommitField: `aria-describedby` requires an `id`, which is optional

**File:** `kit.tsx:1071-1077`

```tsx
<Input
  id={id}
  ...
  aria-describedby={error && id ? `${id}-error` : undefined}
/>
...
{error ? (
  <p id={id ? `${id}-error` : undefined} ...>
```

If a caller passes `error` without passing `id`, the error paragraph has no `id` attribute, and the
input has no `aria-describedby`. The error is shown visually but never announced to screen readers.

**Callers that omit `id`:** `panes-settings.tsx:119` (the retention field) passes `id="ttl"` — ok.
But a future caller who forgets will fail silently.

**Fix:** Make `id` required on `CommitField`, since a refusable field always needs error association.
Or generate a stable id via `React.useId()` when `id` is undefined.

---

## High-severity findings (not blocking but need work before production)

### H1. DataTable: no keyboard traversal within the table

**File:** `kit.tsx:803-938`

The `<tbody>` rows have no `tabIndex`, no arrow-key handler, and no focus ring. A table's cells are
not naturally focusable unless they contain interactive elements. For tables that contain only text
(none in this prototype, but `Cell` can render plain strings), a keyboard user cannot reach that row
at all.

For tables with controls in every row (the model catalogue's `Switch`, the skills table's `Switch`),
the controls themselves are reachable — Tab lands on the first Switch in the first visible row, then
on the next, etc. This works, but it is O(N) Tab stops for N rows × M controls per row. At 100 rows
× 2 controls, that is 200 Tab stops with no shortcut.

**Not blocking:** The controls are individually reachable, which satisfies WCAG 2.1 SC 2.1.1
(keyboard). A roving tabindex or arrow-key navigation is better UX but not a compliance failure.

**Improvement:** Add `tabIndex={0}` to rows, arrow-key listeners for up/down, and Enter to activate
the row's primary action (or the first control). This is standard practice for data tables with
in-row actions.

---

### H2. The Settings/Configure boundary: Web Search vs MCP

The plan doc (`settings-redesign.md`) says:

> **Scope is the surface.** Settings is app-wide, always. Configure is this project, always.

Web Search lives in Settings → Web Search. MCP servers live in Configure → MCP Servers. Both are
"tools and data the agent can reach" (quoting `panes-configure.tsx:427`). The boundary:

- Web Search is app-wide and has no per-project override. If a user wants different providers or keys
  per project, they cannot.
- MCP is per-project (and the plan doc's "still open" admits it has no backing store yet).

This is a defensible product decision — web search is cheap and global, MCP involves process spawning
and config files and is inherently project-scoped. But the user looking for "agent tooling" will not
find it all in one place. The first review (§1.1) called this out for the earlier prototype; the new
split is cleaner but the MCP/web asymmetry remains.

**Not blocking:** The split is documented and deliberate. A user can learn it. But the plan doc
should call out this exception explicitly, and the About or Sessions pane could show "Web search:
Brave" as a reminder that the tool is on.

---

### H3. Skills pane: the switch writes to no scope

**File:** `panes-configure.tsx:235-243`

```tsx
<Switch
  defaultChecked={skill.enabled}
  disabled={skill.shadowed}
  // The switch names its own scope, because a personal skill
  // toggled from a project page is otherwise ambiguous: off
  // here, or off everywhere? This one writes to the project.
  aria-label={`Enable ${skill.slug} in this project`}
  data-testid={`skill-${skill.slug}`}
/>
```

The `aria-label` says "in this project", but the prototype is a static fixture. The first review
(§1.1) asked: "off here, or off everywhere?" The prototype now answers in its label: off here only.
But `main/skills.ts` has no project-scoped disable list. The plan doc's "still open" says
"Skill enable/disable per project has no store."

This is not a prototype bug — it is a deliberate placeholder. The cost is documented. But the
implementation will need:

1. A new table or column in SQLite (or a JSON file in `.volli/` per project).
2. IPC to read/write it.
3. The skills loader to merge the project's disable list with the global `isUserInvokeOnly`.

Estimate: 3–5 hours, plus tests.

---

### H4. MCP servers: zero backing store, highest plumbing cost

**File:** `panes-configure.tsx:499-571` (AddServerDialog), `main/*.ts` (grep finds no MCP code)

The MCP pane shows a table of servers and an "Add server" dialog. The dialog asks for transport,
command (or URL), environment, and name. None of it writes anywhere. `grep -rn "mcp" apps/desktop/src/main/`
finds only test fixture strings mentioning `"VC-12-mcp-server"` (a branch name).

What the production path needs:

1. A config file reader (`.volli/mcp.json` or similar) per project, plus an optional global one.
2. A process spawner for stdio servers, an HTTP client for http servers.
3. A tools-list cache per server (the "12 tools" badge).
4. Health monitoring (the "Connected"/"Failed" state dot).
5. IPC channels for list/add/remove/start/stop.
6. The Agent Runtime must inject the MCP tools into the model's tool set.

This is the largest plumbing gap in the prototype. The plan doc ("still open") says "MCP has no
backing store yet and is the largest piece of new plumbing in the plan." Agreed. Estimate: 2–3 days
for a minimal spawn-and-connect flow; a week for robust lifecycle and the runtime integration.

---

### H5. New command dialog: write path exists but not wired

**File:** `panes-configure.tsx:261-358` (NewCommandDialog)

The dialog collects name, description, body, and scope ("This project" or "Personal"). The plan doc
says the write path exists: `main/prompt-templates.ts` already reads both command folders.

What is missing:

1. IPC to `volli-fs.ts` or a new channel to write `<project>/.volli/commands/<name>.md` or
   `<userData>/commands/<name>.md`.
2. Validation that the file does not already exist (a name collision).
3. Refresh of the commands list after write.

Estimate: 2–3 hours. The dialog itself is well-designed; only the save action is not wired.

---

## Medium-severity findings

### M1. No deep-link migration for `settingsCategory`

**File:** `stores/ui.ts:221,355`

The UI store uses `settingsCategory: string | null` to open Settings on a specific pane (e.g.,
`"model-access"` to sign in). The prototype pane key is `"models"`. The plan doc ("still open")
notes this: "Deep-link migration: … the new key is `models`. Needs an alias."

Without the alias, the existing auto-sign-in flow (`chat-plane.tsx:906`) will open Settings on
a category that does not match, and the shell will fall back to the first category (General).

**Fix:** In the production settings shell, accept both `"model-access"` and `"models"` as aliases
for the same pane. Or migrate all callers to `"models"`.

---

### M2. DataTable: 500 rows is not tested

The doc says Virtuoso is deliberately not added because "the largest real collection here is a
skills folder at a couple of hundred" (`kit.tsx:795`). But `MAX_SKILLS_PER_DIR` is 200
(`main/skills.ts:47`), and a user with both project and personal skills hits 400. A model catalogue
with many providers could hit higher.

The 8-row cap (`rows={8}`) means only 8 rows render in the visible scroll area, but *all* rows are
in the DOM and the browser must lay out all of them to produce the scroll height. At 500 rows × 6
columns × a few DOM nodes per cell, the DOM tree is ~15k–20k nodes in one table. React's
reconciliation on filter/search will touch all of them.

**Not blocking:** A couple hundred rows is fine. If a list genuinely reaches 1,000, the doc says to
reach for Virtuoso. The prototype's comment is honest about the threshold.

**Suggested improvement:** Add a `maxItems` cap to the `DataTable` API that truncates the list and
shows a "Showing 500 of 1,234" footer. This is a simple guard against unexpected growth.

---

### M3. Plan doc: kill list vs build list contradiction

**File:** `settings-redesign.md` "Kill list" and build order

The kill list says:

> The second, unused `HarnessPicker` consumer in `harness-picker.tsx`.

But the build order step 6 says:

> **Configure → Skills + Commands** — surfacing data that already loads.

And `panes-configure.tsx:786-796` adds a per-project Harness select — which is exactly the
"Configure gained a Runtime category" caller that `harness-picker.tsx:5-8` describes. The kill list
and the build order are describing the same thing from opposite directions: one deletes the
abstraction, the other ships the concrete instance. They are consistent in result (the abstraction
is inlined), but the text is confusing.

**Fix:** Update the kill list to say "inline HarnessPicker into SessionsPane" rather than "delete
the unused consumer".

---

### M4. `keywords` still hand-maintained

**File:** `panes-settings.tsx:755` (Models category keywords include `"reasoning"`)

The plan doc ("still open") says "keywords is hand-maintained and will rot." The prototype includes
`"reasoning"` in the Models keywords. After the first review, the reasoning control was restored
(`panes-settings.tsx:488–490`). So this keyword is now correct. But the rot risk remains:

- Add a row, forget the keyword, unfindable.
- Rename a row, forget to update the keyword, stale.

**Not blocking:** The e2e check walks every category and reads every hint (lines 260–280), which
exercises the surface, but does not assert keywords against labels. A test that derives keywords
from rendered labels would close the drift.

---

## Low-severity / non-issues

### L1. DataTable sticky header: works correctly

Checked in the lab. The `<thead>` with `sticky top-0 z-10 bg-card` inside an `overflow-y-auto`
container behaves as expected: the header stays pinned while the body scrolls. The `maxBodyHeight`
calculation (line 848: `rows * 36 + 32`) includes the header height, so 8 visible rows plus the
header fit in the box. Correct.

---

### L2. Rail attention suffix: fixed

The first review (§4.4) complained that `aria-hidden` on the status dot made the state invisible to
screen readers. The prototype now adds an `sr-only` span with the attention label after the dot
(`kit.tsx:272-275`):

```tsx
{category.attention ? (
  <>
    <StatusDot state={category.attention.state} />
    <span className="sr-only">{category.attention.label}</span>
  </>
) : null}
```

The e2e check confirms: "About 2 problems" is in the button's accessible name. Good.

---

### L3. OverrideControl: works correctly

The first review (§1.2) asked for the revert button to name the app-wide value. It does:

```tsx
aria-label={`Reset ${label} to the app-wide value, ${inheritedValue}`}
```

The e2e check confirms the label is readable. Good.

---

### L4. CommitField confirm gate: works correctly

The first review (§1.5) asked for a confirm before destructive writes. The retention field in
`panes-settings.tsx:131-141` passes a `confirm` callback:

```tsx
confirm={(next) =>
  Number.parseInt(next, 10) >= 7 ||
  window.confirm(
    `Keep Done worktrees for only ${next} day(s)? Folders will be removed sooner.`,
  )
}
```

And CommitField respects it (line 1056-1061): if `confirm` returns false, the draft reverts and the
commit is abandoned. Good.

---

## Summary

| Severity | Count | What |
|---|---|---|
| **Blocking** | 3 | B1 (grid syntax in table), B2 (keyboard unreachable links), B3 (aria-describedby requires id) |
| **High** | 5 | H1 (table keyboard nav), H2 (web/mcp boundary), H3 (skill disable store), H4 (MCP store), H5 (command write) |
| **Medium** | 4 | M1 (deep-link alias), M2 (500 rows), M3 (kill list wording), M4 (keywords rot) |
| **Low/ok** | 4 | Sticky header, rail attention, OverrideControl, confirm gate |

**Recommended next steps:**

1. Fix **B1** before anyone copies `DataTable`. Either ban `fr`/`minmax` in the docstring and use
   percentages, or switch to CSS Grid layout with ARIA roles.
2. Fix **B2** and **B3** before merging — both are one-line changes.
3. Accept **H2–H5** as documented plumbing gaps; the plan already calls them out.
4. Add the `settingsCategory` alias (**M1**) in the same PR that lands the production shell.
5. Rename the kill list entry for HarnessPicker (**M3**) to avoid confusion during implementation.
