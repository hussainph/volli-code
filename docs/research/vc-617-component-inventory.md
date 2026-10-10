# VC-617 component and surface inventory

**Status: provisional source inventory, before production fixes.** Transparency studies are parked and excluded from the production design direction. The inventory covers production component folders and shared UI primitives, including shipped lab-backed components and explicit dormant surfaces. Review findings are hypotheses for owner correction, not a command to mechanically normalize every measured geometry.

**Visual acceptance is pending:** source-based Looks good means no concrete structural drift found. It does not mean verified in light/dark/custom canvases. A guarded, isolated live baseline was built; screenshot/state evidence is recorded separately. Native Browser Tab/terminal lifetime must remain unchanged.

## Tracking

- Foundation typography: first implementation batch applied **after** inventory publication; body and overlay boundaries declare `text-ui`, explicit prose overrides remain supported. Portal regression tests added; live after-change verification tracked below.
- Generic control/row/header/empty/loading adoption: queued by consumer tables below.
- Add Host log theming: **VC-734** tracks the isolated subsurface overhaul; provisioning flow is not being redesigned.
- Full visual walk, owner corrections and linked overhaul tickets: outstanding.

## First-batch correction record

Baseline source verdicts below are retained for owner review; they are not silently rewritten
as visual acceptance. First batch changes only typography contracts: body default; Dialog,
AlertDialog, Popover, shared menu and Command content defaults; unknown `text-ui-sm` in
Folder Claim corrected; Ticket Body read-failure prose explicitly uses `text-sm`. The token
checker now catches the nonexistent utility. No wrapper/key/lifetime restructuring included.

Baseline live evidence: `.scratch/volli-drive/vd-cb26d3/` (board, Light Appearance,
New-ticket dialog), isolated basic fixture and loopback fake model; guard doctor passed.
This establishes those paths only, **not** every state in the inventory.

After-change live evidence: `.scratch/volli-drive/vd-4caa9b/` (screenshots 001–008,
snapshots and transcript). Rebuilt guarded basic fixture; reviewed Board, Appearance,
New-ticket Dialog and Options Popover in Light and Dark on the fixture's authored warm
canvas. No evident clipping/overlay-placement regressions in those views. Options opens
and Escape returns through the two overlays; appearance was persisted as `dark` in
`app_state`. Doctor verified isolated homes/database, all 8 keychain traps, zero violations;
renderer console output was empty. Both isolated instances were stopped.

Checks: `vp check`, renderer `tsc --noEmit`, token gate (42 matcher cases),
`git diff --check`, production build (ordinary chunk-size warning) passed;
53 tests across 7 focused suites passed (known jsdom canvas/React act warnings in
existing editor/composer suites). These tests assert portal/class contracts, not browser
computed styles. Remaining overlay families, host/error variants, neutral/narrow/system
appearance paths and full-app visual acceptance remain pending.

## Second-batch correction record

- ⌘K palette and ⌘P Quick Open compose `COMMAND_RESULT_ROW` from shared menu
  layout/type/cmdk state contracts. Their stacked/single-line densities and 16px glyphs
  stay consumer-owned. Unlike ordinary menu glyphs, nested result identity marks keep
  inherited ink. This removes copied mechanics and adds `select-none` to both paths.
- Attachment tiles keep their 64px geometry while file labels use `text-label`, full
  semantic ink and an 8px inset; removal takes `Button size="icon-xs"` with the existing
  hover/focus reveal. Queued file glyphs use the same semantic fill. No upload semantics
  or Blob identity/lifetime changes. Numeric px/rem type escapes now fail the token gate;
  relative markdown em sizing stays explicitly pending.
- 56 tests across 6 focused suites passed; `vp check`, renderer typecheck, token gate
  (48 matcher cases), diff check and production build passed (ordinary chunk warning).
- Live evidence: `.scratch/volli-drive/vd-ac8aeb/` (screenshots 001–005, transcript and
  snapshots). Guarded isolated basic fixture: reviewed ⌘K and ⌘P in Light/Dark, searched
  DRV-1 and opened it by keyboard, previewed README.md from ⌘P, closed search via Escape.
  Appearance persisted as `light`; console empty, doctor zero violations; instance stopped.
  Full result categories, no-match/disabled/narrow and system paths remain pending.
- Browser component evidence only: `http://localhost:5174/lab/#attachment-tiles` with the
  actual production AttachmentStrip/ThumbRow, warm canvas in auto-resolved Dark and explicit
  Light. Reviewed clamped long labels, read-only/queued views and visible keyboard ring;
  Tab→Enter removed one editable tile while sent copies stayed intact. Screenshot cards
  in this session hold the evidence. No upload, image decoding or host persistence proof is
  claimed; fixture is local-only. Console showed no errors.

Independent review `88f85b46` checked both batches: no cascade/override regressions found.
Its one actionable finding, redundant `tracking-wide` on the attachment `text-label`, was
removed and regression-guarded. Added an explicit command-result outline merge assertion;
clarified the unknown-utility rule comment. Rechecked Light browser fixture; `vp check`,
renderer typecheck, token gate (48 cases), diff check and 18 focused tests passed afterward.
Reviewer suite count (54) differs from the earlier 56 because it ran overlay-typography (9)
instead of attachment-model (11); both recorded runs passed. Its nonblocking Tooltip portal
case and CSS-source matcher hardening suggestions remain optional follow-up coverage.

Original source verdicts remain below; these correction records qualify only named paths.

## Shared foundation and primitive contracts

Paths are relative to `apps/desktop/src/renderer/src/`, unless noted. Provisional source verdicts; live visual acceptance is pending. This is a contract/style inventory, not an exhaustive behavioral review of vendored widgets or animation helpers.

| Surface | File(s) | Provisional verdict | Concrete reason / evidence |
|---|---|---|---|
| Document typography default | `globals.css` | Needs tweaks | Body declares ink and font family but no size; otherwise-unsized UI falls back to browser 16px. |
| Dialog and confirmation frames | `components/ui/dialog.tsx`, `alert-dialog.tsx` | Needs tweaks | Titles/descriptions have explicit rungs; portal content roots do not specify UI size for arbitrary children. |
| Popover frame | `components/ui/popover.tsx` | Needs tweaks | Content root has ink, border, inset, motion and wheel/ref composition, but no explicit text size. Preserve wheel/ref forwarding. |
| Root/submenu/Select surfaces | `components/ui/menu-classes.ts`, `dropdown-menu.tsx`, `context-menu.tsx`, `select.tsx` | Needs tweaks | Rows share text-ui; MENU_SURFACE omits a type default for custom content. Keep Radix-specific origin, sizing, roles and icons. |
| Command content and palette rows | `components/ui/command.tsx` | Needs tweaks | Item/input/empty recipes are shared and sized; container leaves custom content typography inherited. Product palette-shell duplication is separately inventoried. |
| Tooltip and clipped-value reveal | `components/ui/tooltip.tsx`, `value-reveal.tsx` | Looks good | Explicit text-ui, semantic inverse ink/fill, pointer-transparent labels and shared reveal contract. |
| Button, ButtonGroup and Segmented | `components/ui/button.tsx`, `button-group.tsx`, `segmented.tsx` | Looks good | Size/variant/focus contracts and compound-control seams are already shared; adopt them instead of redrawing. Insets are documented measured exceptions. |
| Input/Textarea/InputGroup/InlineRename | `components/ui/input.tsx`, `textarea.tsx`, `input-group.tsx`, `inline-rename.tsx`, `field-classes.ts` | Looks good | Explicit type/control rungs and shared invalid/rename semantics; no unauthorized change to the intentionally caret-only text-field focus policy. |
| ListRow and matching loading rows | `components/ui/list-row.tsx` | Looks good | Explicit text-ui for string slots, semantic active/inert targets and sibling actions. Node-valued content intentionally inherits its host's type. |
| Badge, section eyebrows, empty grammar | `components/ui/badge.tsx`, `section-heading.tsx`, `empty-classes.ts` | Looks good | Shared variants and explicit label/UI rungs. Generic consumer copies should adopt these. Page empty-state children own their hierarchy. |
| Accordion disclosures | `components/ui/accordion.tsx` | Needs tweaks | Generic trigger/content rely on host typography; establish root/overlay baseline before treating every disclosure as a standalone defect. |
| Collapsible plumbing | `components/ui/collapsible.tsx` | Looks good | Unstyled behavioral composition, not a visual surface requiring another default container. |
| Checkbox/Switch/Separator | `components/ui/checkbox.tsx`, `switch.tsx`, `separator.tsx` | Looks good | Semantic states, shared focus/geometry; checkbox corner is a documented token-derived exception. |
| Notice/status family | `components/ui/notice.tsx`, `status-dot.tsx`, `session-activity-status.ts` | Looks good | State vocabulary, semantic tokens and explicitly sized content are centralized. Specialized identity marks are not status-token mistakes. |
| Sidebar building blocks | `components/ui/sidebar.tsx` | Looks good | Shared shell/menu/group composition; specific product nav/tile contracts remain in inventory rather than flattened into ListRow. |
| Tab strip and focus/reorder/scroll helpers | `components/ui/tab-strip.tsx`, `tab-focus.ts`, `tab-reorder.ts`, `tab-scroll.ts` | Looks good | Shared tab variants/geometry and behavioral helpers; preserve stable live-view keys/ownership in consumers. |
| Skeleton/loading region/Spinner | `components/ui/skeleton.tsx`, `loading-region.ts`, `spinner.tsx` | Looks good | Central material and loading accessibility; caller owns placeholder geometry. Consumer handrolled copies need review. |
| Toast surface | `components/ui/sonner.tsx` | Looks good | Theme-resolved mode and semantic surface variables; filled state glyph exception is explicit. Library-owned typography needs live confirmation. |
| Thinking and title/value reveal drawings | `components/ui/thinking-orbs.tsx`, `title-reveal.tsx`, `value-reveal.tsx` | Looks good | Specialized motion/drawing helpers inherit caller semantics; not generic card/row duplication. No motion redesign included in this pass. |
| Conversation/message/prompt/reasoning primitives | `components/ui/ai-elements/conversation.tsx`, `message.tsx`, `prompt-input.tsx`, `reasoning.tsx`, `shimmer.tsx`, `scroll-chaining.ts` | Looks good | Existing chat reading/control contracts; consumer geometry/lifecycle findings are listed separately. Vendored provenance remains intact. |
| Chat markdown source/file references | `components/ui/ai-elements/chat-markdown.tsx` | Needs tweaks | Inline reference labels use relative 0.8em/0.9em sizes; review against named type-rung policy before tightening the checker. Do not confuse syntax-highlight color values with font-size escapes. |

### Initial implementation batch

- Set the document UI-size default and explicit defaults on overlay content boundaries.
- Add regression coverage for body/portal typography while preserving prose, heading and title overrides.
- Resolve concrete unknown/unsized text where review shows a true inherited-size error.
- Follow with shared-control/empty-state adoption; structural overhauls remain separately tracked.
- Never incidentally unmount resident terminals, editors or native Browser Tabs.

The full light/dark/custom-canvas audit and every consumer correction are **not complete**. Native host/provisioning/error variants unavailable in the basic test fixture remain pending visual verification. No surface is promoted to visually accepted merely because a source-based Looks good verdict appears here.

## Shell, pages and ticket surfaces — source review

**Read-only inventory: 218 production files — 142 `.tsx`, 76 `.ts`.** Read `AGENTS.md`, production design guidance in `docs/DESIGN.md`, and `CONTEXT.md`. Lab/research treatments were excluded.

Reviewed component rendering, styling, primitive usage, overlay composition, and relevant lifetime seams. Supporting models/hooks were inventoried by ownership/contracts; this is **not an exhaustive behavioral review**.

**Every verdict below is provisional. Light/dark/custom-canvas visual validation is pending for every surface. Source inspection is not visual proof.** Nothing currently warrants **Needs an overhaul** from this review alone.

Paths below are relative to `apps/desktop/src/renderer/src/components/`.

## Inventory

### Window, navigation, projects, Home

| Surface | File(s) | Provisional verdict | Concrete reason and evidence |
|---|---|---|---|
| Window shell and titlebar | `app-shell.tsx`, `chrome-bar.tsx` | Looks good | One framed content surface and stable memoized children; shell chrome is deliberately product-specific, not a duplicated generic card (`app-shell.tsx:551–554,685–720`). |
| Command palette, filters, ticket/session/automation/editor/host result groups | `command-palette.tsx` | Needs tweaks | `PALETTE_ROW` reimplements menu-like row geometry and omits `select-none`; two-line result density is deliberate, but interaction/type defaults could share the menu contract (`:99,453,526`). |
| Database boot/recovery and newer-version recovery | `boot-error-panel.tsx` | Looks good | Reading measure, explicit type, shared notices/buttons; backup rows are recovery-specific composition rather than generic list duplication (`:155–195`). |
| Dependency-install offer | `workspace-dependencies-offer.tsx` | Looks good | Shared neutral `Notice` and primitive-sized actions preserve the distinction between missing dependencies and a fault (`:139–175`). |
| Session environment fault | `session-environment-alert.tsx` | Looks good | Shared error `Notice`, explicit repair/review/dismiss actions; no locally invented alert container (`:167–208`). |
| Sidebar navigation and project identity | `sidebar/primary-sidebar.tsx`, `sidebar/nav-list.tsx` | Looks good | Shared Sidebar primitives; navigation rows are places, not preference/list-row controls (`primary-sidebar.tsx:64–79`, `nav-list.tsx:47+`). |
| Sidebar Active/Previous bands, ticket groups, filter menu, peeks/context-menu hosts | `sidebar/active-sessions.tsx`, `sidebar/session-band-row.tsx`, `sidebar/session-band-header.tsx`; `sidebar/active-session-listing.ts`, `sidebar/session-band-filter.ts`, `sidebar/session-band-keys.ts` | Needs tweaks | Active rows use `ListRow density="two-line"` while their bespoke skeleton still uses the older smaller box (`session-band-row.tsx:429–430` versus `:795–802`); menu/row composition otherwise already shared. |
| Sidebar reveal, resizing, scrolling and listing support | `sidebar/content-motion.ts`, `sidebar/edge-region.ts`, `sidebar/edge-reveal.ts`, `sidebar/listing.ts`, `sidebar/sidebar-resize-handle.tsx`, `sidebar/sidebar-scroll.tsx` | Looks good | These own geometry/gesture behavior, not repeated design objects; keep their measured seam and overlay-awareness intact (`sidebar-scroll.tsx:330+`, `edge-reveal.ts:114,422,569`). |
| Sidebar updater affordance | `sidebar/update-button.tsx` | Needs tweaks | Raw button repeats shared press/focus/motion styling; its busy-but-hoverable tooltip behavior is intentional and must survive primitive adoption (`:63–94`). |
| Project switcher, sortable project tiles, add tile, project context menus/tooltips | `rail/project-rail.tsx`, `rail/project-tile.tsx`, `rail/add-project-tile.tsx` | Needs tweaks | Both tile buttons lack an explicit shared `focus-visible` recipe; retain their deliberate 36px navigation-tile geometry and identity colors (`project-tile.tsx:68–85`, `add-project-tile.tsx:12–20`). |
| Project folder missing/relink/claim/remove flows | `board/project-folder-banner.tsx`, `rail/folder-claim-dialog.tsx`, `rail/relink-project-dialog.tsx`, `rail/remove-project-dialog.tsx` | Needs tweaks | Shared dialog/notice composition is sound; folder claim contains nonexistent `text-ui-sm` (`folder-claim-dialog.tsx:111`), and banner has undocumented `pb-3` (`project-folder-banner.tsx:41`). |
| Home workspace, tab strip and tab context menus | `home/home-surface.tsx`, `home/home-tab-strip.tsx`, `home/home-tab-descriptors.ts`, `home/home-tabs.ts` | Looks good | Shared Tab/TabStrip/Split primitives; resident terminal layer is separate from conditional chat/file/browser views (`home-surface.tsx:850–917,1000+`). |
| Home Now roster and Earlier fold | `home/home-rail.tsx`, `home/home-rail-model.ts` | Looks good | Uses the Ticket rail’s row/fold/liveness grammar; custom Earlier trigger is scope-specific, not a second fold mechanism (`home-rail.tsx:467–554`). |
| Home Files rail | `home/home-files-panel.tsx` | Looks good | Reuses shared navigator/row infrastructure instead of reproducing Ticket file navigation (`:226–270`). |
| Home checkout footer and identity popover | `home/home-rail-footer.tsx` | Needs tweaks | Correctly shares checkout targets/fold/footer; folded body retains undocumented 12px vertical spacing (`:100–104`). |
| Retired Home Session identity card — **not mounted by product source** | `home/home-session-card.tsx` | Looks good | Shared rail card/type/model-identity treatment; source-reference search found no product caller, so do not count it as another live Home surface. |

### Board and New ticket

| Surface | File(s) | Provisional verdict | Concrete reason and evidence |
|---|---|---|---|
| Board canvas, column layout, collapsed columns, drag/selection/windowing support | `board/board.tsx`, `board/board-column.tsx`, `board/collapsed-column-rail.tsx`, `board/board-boundary.tsx`; `board/board-dnd.ts`, `board/board-selection.ts`, `board/column-window.ts`, `board/drag-picker-model.ts` | Looks good | Board columns and drag ghosts are genuine product composition; shared empty/error controls and tokens already carry their drawing (`board-column.tsx:394–418`, `board.tsx:1163+`). |
| Board header, sorting/view selection and filter menus | `board/board-header.tsx`, `board/filter-bar.tsx`, `board/filter-chip.tsx`, `board/board-summary.ts` | Needs tweaks | View toggle hand-rolls a segmented control already supported by `ui/segmented.tsx`, including duplicate press/focus styling (`board-header.tsx:115–138`). |
| Board activity projection | `board/board-session-activity.ts`, `board/session-activity-context.tsx` | Looks good | Shared activity projection supplies board/list/card state; no additional styling implementation to centralize. |
| Board ticket cards, priority marks, labels and label-overflow popover | `board/ticket-card.tsx`, `board/ticket-card-labels.tsx`, `board/priority-indicator.tsx`, `board/tag-chip.tsx`, `board/label-overflow.ts` | Needs tweaks | Card title is `text-sm leading-snug` despite documented card UI typography; card inset and priority drawing are deliberate exceptions, not generic-card duplication (`ticket-card.tsx:87,107`). |
| Board list view and inline ticket creation | `board/board-list-view.tsx`, `board/use-ticket-composer.ts` | Needs tweaks | List ticket titles use `text-sm` while adjacent metadata/control rows use `text-ui`; this is a type-policy discrepancy, not a reason to replace sortable list geometry (`board-list-view.tsx:83–98`). |
| Column automation arming menu and Option-drag offered targets | `board/column-arming.tsx`, `board/column-offered-panel.tsx` | Looks good | Arming uses shared dropdowns; offered targets are measured drag landings, **not ordinary menu items**, and should retain that specialized composition (`column-offered-panel.tsx:69–78,151+`). |
| Empty board and first-model-access entry point | `board/board-empty.tsx` | Looks good | Shared `EMPTY_PAGE`; model sign-in replaces the existing empty-state action rather than adding another onboarding panel (`:50–73`). |
| Archive, permanent-delete confirmation, board ticket context menus and dialog lifetime host | `board/archive-dialog.tsx`, `board/ticket-context-menu.tsx`, `board/ticket-dialog-host.tsx` | Looks good | Shared ListRow/Dialog/AlertDialog/ContextMenu primitives, with centralized ticket dialog hosting (`archive-dialog.tsx:77,209–238`, `ticket-context-menu.tsx:205+`). |
| New-ticket dialog, writing sheet, project breadcrumb and draft | `board/new-ticket-dialog.tsx`, `board/new-ticket/new-ticket-dialog.tsx`, `board/new-ticket/composer-form.tsx`, `board/new-ticket/composer-breadcrumb.tsx`, `board/new-ticket/project-monogram.tsx`, `board/new-ticket/draft.ts` | Needs tweaks | Shared prompt/dialog treatment and bespoke writing layout are justified; form has unrecorded `pt-3`, while fixed editor heights are product geometry rather than token drift (`composer-form.tsx:489,527`). |
| New-ticket metadata, labels and Options popover | `board/new-ticket/composer-chips.tsx`, `board/new-ticket/composer-chip.ts`, `board/new-ticket/composer-labels.tsx` | Looks good | One composer-chip recipe over shared Button/dropdown primitives; Options labels explicitly size their text (`composer-chips.tsx:144–152`). |
| New-ticket checkout/base-branch menus | `board/new-ticket/composer-branch.tsx`, `board/new-ticket/branch-picker.ts` | Looks good | Shared Command/Popover/dropdown/empty primitives; branch group/read-state composition is product-specific (`composer-branch.tsx:228–251`). |
| New-ticket commit tray, automation chooser, chat model/effort and launch execution support | `board/new-ticket/composer-footer.tsx`, `board/new-ticket/composer-run.tsx`, `board/new-ticket/composer-launch.ts`, `board/new-ticket/submit.ts` | Looks good | Shared chat runtime controls and dropdown rows; welded Create/primary/caret group is an explicitly documented composition, not a generic ButtonGroup error (`composer-footer.tsx:107–178`). |

### Ticket workspace and rail

| Surface | File(s) | Provisional verdict | Concrete reason and evidence |
|---|---|---|---|
| Ticket workspace, tabs, tab menus and tab identities | `ticket/ticket-detail.tsx`, `ticket/ticket-tabs.tsx`, `ticket/ticket-body-tab.ts`, `ticket/ticket-chat-tab.ts`, `ticket/ticket-file-tab.ts`, `ticket/ticket-diff-tab.ts` | Looks good | Shared tab/split primitives; Ticket Body alone receives reading layout while workbench tabs retain their plane (`ticket-detail.tsx:1420–1535`). |
| Ticket Body title/editor/loading/failure | `ticket/ticket-title.tsx`, `ticket/ticket-body-editor.tsx`, `ticket/ticket-body-panel.tsx`, `ticket/use-ticket-body.ts`, `ticket/ticket-body-ref-append.ts` | Needs tweaks | Failure paragraph has color but **no font size**, inheriting the document’s default 16px rather than the app scale (`ticket-body-panel.tsx:76–84`). |
| Ticket Activity, comments, edit/delete confirmation and comment composer | `ticket/ticket-activity-feed.tsx`, `ticket/activity.ts`, `ticket/clamped-markdown.tsx`, `ticket/clamp-policy.ts`, `ticket/markdown.tsx` | Needs tweaks | Rendered prose uses shared typesetting and prompt chrome; comment edit textarea hand-rolls field styling, and optimistic `opacity-60`/`pt-3` diverge from documented ladders (`ticket-activity-feed.tsx:243,308,361`). |
| Rail navigation, sections, read feedback, cards, folds and resizing | `ticket/ticket-rail.tsx`, `ticket/ticket-rail-model.ts`, `ticket/rail-mode-tabs.tsx`, `ticket/rail-panel-parts.tsx`, `ticket/rail-read-feedback.ts`, `ticket/rail-resize-handle.tsx` | Needs tweaks | Shared rail vocabulary is substantial and worth preserving; expanding mode tabs are deliberately custom, but their 32px height differs from the documented universal 28px tab rung (`rail-mode-tabs.tsx:175,201–203`). |
| Now Properties, removable labels and additive label picker | `ticket/ticket-properties.tsx`, `ticket/label-picker.tsx`, `ticket/label-picker-model.ts` | Needs tweaks | Rails intentionally use control-bearing property rows; additive and toggle label pickers nevertheless duplicate searchable option/create rendering (`ticket-properties.tsx:324–367`, `label-picker.tsx:99–138`). |
| Now Sessions, record fold, filter, rename/context menus | `ticket/ticket-sessions-panel.tsx`, `ticket/session-history.ts` | Looks good | Shared ListRow/skeleton/fold/read-feedback infrastructure; inert rename branch and model-resident records are already explicit (`ticket-sessions-panel.tsx:325–395,1093+`). |
| Diffs rail and change-recency ownership/watch support | `ticket/ticket-changes-panel.tsx`, `ticket/ticket-changes-model.ts`, `ticket/ticket-change-recency.ts`, `ticket/ticket-change-recency-owner.ts`, `ticket/worktree-change-watch.ts` | Looks good | Shared ListRow and read/empty primitives; counts, rename provenance and Updated marker are distinct product facts (`ticket-changes-panel.tsx:298–370`). |
| Ticket Files, references, attachments entry and file context menus | `ticket/ticket-files-panel.tsx`, `ticket/ticket-files-model.ts` | Looks good | Shared navigator/ListRow/InlineRename/ContextMenu; one-line folder listing and adjacent reference path are intentional scope differences (`ticket-files-panel.tsx:214–288`). |
| Worktree footer, identity popover, publish menu and commit gate | `ticket/ticket-repository-summary.tsx`, `ticket/worktree-done-flow-model.ts`, `ticket/worktree-glance-model.ts`, `ticket/worktree-retention-model.ts`, `ticket/remove-worktree-dialog.tsx` | Needs tweaks | Shared rail controls and footer targets are sound; commit gate uses a native checkbox instead of `ui/checkbox.tsx` (`ticket-repository-summary.tsx:257–263`). |
| PR checks row and checks-detail popover | `ticket/pr-checks-row.tsx`, `ticket/pr-checks-model.ts` | Looks good | Shared card seam/row and explicit `text-ui`; check-link rows are specialized external destinations, not missing generic ListRow adoption (`pr-checks-row.tsx:138–151,218–253`). |
| Diff workbench, presentation/wrap controls and binary stub | `ticket/diff-view.tsx`, `ticket/diff-view-plan.ts`, `ticket/diff-file-policy.ts`, `ticket/diff-fit.ts`, `ticket/diff-presentation-toggle.tsx`, `ticket/diff-stub.tsx` | Looks good | Shared Segmented/Button/empty primitives; editor policy and loading/failure drawing are explicitly sized (`diff-view.tsx:587–606`, `diff-presentation-toggle.tsx:37+`). |
| File workbench, source/document/preview and unsupported-file state | `ticket/file-view.tsx` | Looks good | Explicit reading/workbench distinction and shared empty/notice treatment; editor and preview layout are deliberate composition (`:707–751,804–888`). |
| Legacy label editor and color context menu — **no product caller found** | `ticket/label-editor-core.tsx` | Needs tweaks | Retired removable-chip implementation duplicates the live rail version and lacks shared focus/reveal treatment on raw remove/swatch buttons (`:48–59,127–135`); do not redesign it as a live surface. |

### Settings, Configure and appearance

| Surface | File(s) | Provisional verdict | Concrete reason and evidence |
|---|---|---|---|
| Main page dispatch and first-project/no-project states | `pages/main-content.tsx` | Looks good | Shared empty-state grammar and always-mounted Home seam; first-run content is deliberate product composition (`:30–55,98–113`). |
| Settings/Configure shell, grouped category navigation and project identity | `pages/settings-page.tsx`, `pages/configure-page.tsx`, `settings/settings-groups.tsx`, `settings/configure-groups.tsx`, `settings/hosts-category.tsx`, `settings/kit/pref-shell.tsx` | Needs tweaks | Shared shell/header/workbench measure already centralize layout; category no-results still hand-rolls `py-6` instead of shared inline empty geometry (`pref-shell.tsx:207+`). |
| Preference sections, rows, actions, save fields, inheritance and hints | `settings/kit/pref-section.tsx`, `settings/kit/pref-row.tsx`, `settings/kit/commit-field.tsx`, `settings/kit/control-width.ts`, `settings/kit/override.tsx`, `settings/kit/info-hint.tsx`, `settings/kit/row-action.tsx`, `settings/kit/index.ts` | Looks good | Real shared vocabulary; preference rows, section headers and navigation are semantically distinct from list rows/eyebrows, so forcing them into one universal row would regress the system. |
| Settings tables, async loading/error/empty, health and status | `settings/kit/data-table.tsx`, `settings/kit/async-section.tsx`, `settings/kit/health-panel.tsx`, `settings/kit/status.tsx`, `settings/kit/use-roving-rows.ts` | Needs tweaks | `Empty` duplicates `EMPTY_INLINE` with different padding; table cells use 14px and hover/focus `/40`–`/60` outside documented ladders (`async-section.tsx:54–55`, `data-table.tsx:260,266`). |
| Unavailable preview kit — **no current product caller** | `settings/kit/unavailable.tsx` | Looks good | Shared Notice and truly inert preview; not a hidden live settings category (`:54–124`). |
| Settings General | `settings/panes/general-pane.tsx` | Looks good | PrefSection/PrefRow/Switch composition, without locally restated row/header styling (`:27–40`). |
| Settings Appearance and Display | `pages/appearance-settings.tsx`, `settings/panes/display-section.tsx` | Looks good | Shared preference controls and appearance editor; remaining custom font/size controls are specialized terminal settings (`appearance-settings.tsx:279–368`). |
| Settings Notifications | `settings/panes/notifications-pane.tsx` | Looks good | Shared preference sections/rows and controls (`:161–183`). |
| Settings Models, defaults, compaction, accounts and sign-in choice menus | `pages/model-access-settings.tsx`, `pages/model-access-accounts.tsx`, `pages/model-access-accounts-model.ts`, `pages/model-access-refresh-model.ts` | Looks good | Shared preference sections, selects/dropdowns, fields and model identity; inline sign-in prompts are runtime content, not duplicate alert/dialog primitives (`model-access-accounts.tsx:407–645`). |
| Settings Models → Code Mode | `pages/code-mode-settings.tsx` | Needs tweaks | Shared rows/controls, but Advanced section retains undocumented 12px spacing (`:205,225`). |
| Settings Models → Decision Model, cloud opt-in and automatic-choice confirmations | `pages/decision-model-settings.tsx`, `pages/decision-model-model.ts` | Needs tweaks | Shared Segmented/Select/AlertDialog and explicit type; repeated `gap-3` connection/control clusters are ordinary spacing drift (`:422,458,565`). |
| Settings Web Search | `pages/web-access-settings.tsx`, `pages/web-access-model.ts` | Needs tweaks | Shared row/field/status primitives; ad-hoc `w-80` control columns and `gap-3` bypass settings width/spacing ladders (`:174,192,218`). |
| Settings Telemetry | `pages/agent-observability-settings.tsx`, `pages/agent-observability-model.ts` | Needs tweaks | Same width/spacing drift as Web Search, despite shared PrefRow/Input/Notice composition (`:164,180`). |
| Settings Integrations | `settings/panes/integrations-pane.tsx` | Looks good | Shared async section, preference selector and ItemRow actions (`:81–121`). |
| Settings Experimental | `pages/experimental-settings.tsx` | Looks good | Shared sections/rows/switches and explicit loading/fault treatment (`:86–113`). |
| Settings Hosts, detail/facts, rename/menu, forget confirmation and paired devices | `settings/panes/hosts-pane.tsx`, `settings/panes/hosts-pane-model.ts` | Needs tweaks | Paired-device `ItemRow` supplies an unsized React-node name, bypassing ListRow’s string typography and inheriting default 16px (`hosts-pane.tsx:682–693`). |
| Settings Storage, retention, artifact trimming, orphan logs/worktrees, database export and confirmations | `settings/panes/storage-pane.tsx`, `settings/panes/storage-orphans-model.ts`, `settings/panes/processes-section.tsx`, `settings/panes/processes-model.ts` | Looks good | Extensive shared AsyncSection/ItemRow/PrefRow/AlertDialog composition; destructive confirmations deliberately enumerate affected data rather than inventing another card system. |
| Settings Updates and install/restart confirmation | `settings/panes/updates-pane.tsx`, `update/update-install-dialog.tsx`, `update/live-work-copy.ts` | Looks good | Shared preference and confirmation primitives; explicit live-work warning is safety content, not excess explanatory copy (`update-install-dialog.tsx:90–134`). |
| Settings About, health and Copy report dialog | `settings/panes/about-pane.tsx`, `settings/panes/about-health-model.ts`, `settings/panes/about-report.ts`, `settings/panes/copy-report-dialog.tsx`, `pages/cli-status-model.ts`, `pages/harness-catalog.ts`, `pages/harness-picker.tsx` | Looks good | Shared HealthPanel/report dialog, explicit report type, diagnosis separated from main pane (`about-pane.tsx:299+`, `copy-report-dialog.tsx:51–69,175+`). |
| Legacy detailed PATH comparison — **no product caller found** | `pages/session-path-comparison.tsx` | Needs tweaks | Diagnostic panel still hand-rolls uppercase headings instead of SectionHeading; not another currently visible About page (`:263–284`). |
| Configure Skills and Commands, shared index, new-command dialog | `settings/configure/skills-pane.tsx`, `settings/configure/skills-budget.ts`, `settings/configure/commands-pane.tsx`, `settings/configure/new-command-dialog.tsx`, `settings/use-agent-index.ts` | Looks good | Shared DataTable/async/preferences/fields and prompt shell; any table-wide type/empty fixes belong centrally, not in these consumers (`commands-pane.tsx:26,56`, `new-command-dialog.tsx:114–212`). |
| Configure MCP server table/activity/menu/remove confirmation and connection/tool dialogs | `settings/configure/mcp-pane.tsx`, `settings/configure/mcp-server-dialog.tsx`, `settings/configure/mcp-credentials-editor.tsx`, `settings/configure/mcp-tool-picker.tsx`, `settings/configure/mcp-tools-model.ts` | Needs tweaks | Connection/tool headings bypass SectionHeading; tool picker uses `/40` hover and custom empty drawing (`mcp-server-dialog.tsx:572,632`, `mcp-tool-picker.tsx:247,387`). Checkbox/description rows themselves are justified specialized composition. |
| Configure Secrets and reset/revoke/replace actions | `settings/configure/secrets-pane.tsx` | Looks good | Shared preference/dialog/field controls; secret records need their own safety/action grouping (`:53,135–173,216–244`). |
| Configure Sessions | `settings/configure/sessions-pane.tsx` | Looks good | Shared PrefRows, model identity/selects and inheritance controls (`:142–241`). |
| Configure Worktrees | `settings/configure/worktrees-pane.tsx` | Looks good | Shared preference rows/save fields/ItemRows; no independent settings geometry (`:35–88`). |
| Configure project Appearance | `pages/project-appearance-settings.tsx`, `theme/project-appearance-model.ts` | Looks good | Reuses global appearance editor and shared override idiom instead of reproducing controls (`project-appearance-settings.tsx:162–264`). |
| Appearance canvas editor and terminal font picker popover | `theme/canvas-editor.tsx`, `theme/canvas-editor-model.ts`, `theme/slider-squiggle.ts`, `theme/theme-combo-box.tsx`, `theme/appearance-rows.ts`, `theme/terminal-settings-model.ts` | Needs tweaks | ThemeComboBox hand-rolls cmdk rows at `text-sm`/`rounded-sm` rather than shared menu row defaults (`theme-combo-box.tsx:114–144`); canvas pad’s specialized geometry/two-tone orb contrast is intentional, but `/60` and 12px/half-step layout values need recorded decisions (`canvas-editor.tsx:434,564,953`). |

### Shared layout and split workspaces

| Surface | File(s) | Provisional verdict | Concrete reason and evidence |
|---|---|---|---|
| Reading/workbench columns and page headers | `layout/content-column.tsx`, `layout/page-header.tsx` | Looks good | Canonical measures/gutter/header tiers are genuinely centralized; no replacement needed (`page-header.tsx:20–24,77+`). |
| Empty split-pane action menu | `split/pane-empty-state.tsx` | Looks good | Its 32px verb rows are explicitly documented empty-pane grammar; do **not** replace with ordinary 28px menu rows (`:98–126`). |
| Split drag/drop previews, divider, grid and divided tab bar | `split/split-dnd.tsx`, `split/split-drag-source.ts`, `split/split-drop-zones.tsx`, `split/split-drop.ts`, `split/split-surface-drop.ts`, `split/split-tab-partition.ts`, `split/split-view-divider.tsx`, `split/split-view-grid.tsx`, `split/split-view-tab-bar.tsx` | Looks good | Shared split geometry and keyboard/pointer behavior; preview `/40` ring is a documented exception (`split-drop-zones.tsx:161–165`). |
| Resident terminal placement seam | `split/terminal-pane-anchor.tsx`, `split/terminal-viewport-registry.ts` | Looks good | Anchor cleanup removes placement only, not terminal lifetime; registry identity/owner constraints are load-bearing (`terminal-pane-anchor.tsx:26–35`, `terminal-viewport-registry.ts:55–70`). |

## Working and floating surfaces — source review

Read-only inventory complete: **296 files enumerated — 164 non-test source files, 132 tests/support files** across all 15 assigned folders. Read `AGENTS.md`, `docs/DESIGN.md`, and `CONTEXT.md`; inspected source styling, primitive usage, state branches, and live-view lifecycle seams.

**Every verdict is provisional and source-based. Light/dark, custom-canvas, narrow-layout, and visual-fidelity verification remain pending.** “Looks good” means no concrete structural drift found, not visually verified.

Paths below are relative to `apps/desktop/src/renderer/src/components/`. Helpers are grouped under their actual product surface. Surface experiments were excluded.

## Surface inventory

| Surface | File(s) | Provisional verdict | Concrete reason / code evidence |
|---|---|---|---|
| Chat transcript and loading | `chat/chat-plane.tsx`, `transcript-skeleton.tsx`, `chat-plane-model.ts`, `transcript-window.ts` | Needs tweaks | Reading measure and loading geometry already share `ContentColumn`/`MESSAGE_GAP`; remaining local spacing includes `gap-1.5` in the skill receipt (`chat-plane.tsx:2631`) and `top-3` for venue chrome (`:1535`). |
| Transcript activity/tool details | `chat/activity-ui.tsx`, `tool-output-highlight.tsx` | Looks good | Explicit `text-ui` row/detail recipes (`activity-ui.tsx:179–180,624`), bounded output and on-screen highlighting; expandable transcript rows are specialized disclosure, not generic list-row duplication. |
| Transcript Markdown degradation | `chat/markdown-boundary.tsx` | Looks good | Per-block boundary preserves readable prose/code (`:90–115`); paragraphs inherit the transcript’s explicit `text-sm leading-prose` from `ui/ai-elements/message.tsx:62`, not the unsized body. |
| Host-authored transcript receipts | `chat/host-notice-ui.tsx`, `reasoning-drop-notice-ui.tsx` | Looks good | Receipt rows explicitly declare `text-ui`, semantic state ink and shared separators (`host-notice-ui.tsx:75,109,128,154,173`). |
| Context compaction progress/boundary | `chat/compaction-boundary-ui.tsx` | Needs tweaks | Durable boundary is appropriately distinct from live progress, but the temporary card uses `gap-3 px-3 border-primary/20 bg-primary/5` (`:53`), outside documented spacing/alpha recipes. |
| Chat composer and queued-message controls | `chat/composer-ui.tsx`, `composer-chrome.ts`, `composer-caret.ts` | Needs tweaks | Shared writing-sheet/tray/button rungs are present; model popover still locally introduces `py-3` (`composer-ui.tsx:1978`) rather than a documented shared inset. |
| Composer Add menu | `chat/composer-add-menu.tsx` | Looks good | Shared DropdownMenu/Button, canonical composer control sizes, caret insertion and reduced-motion gating (`:88–112`). |
| Composer command/skill/file picker | `chat/composer-picker-ui.tsx` | Looks good | Uses shared prompt-command primitives and `COMPOSER_STACK_SHELL` (`:143–185`); not an independently drawn generic menu. |
| Composer effort control/popover | `chat/composer-effort-ui.tsx` | Needs tweaks | Slider’s specialized geometry and live-token-derived ramp are intentional (`:257–270`); generic popover/label insets still use `p-3` and `px-3` (`:150,551`). |
| Context usage control/popover | `chat/context-usage-ui.tsx` | Needs tweaks | Heat-cell radius is recorded/allowlisted data geometry; surrounding `p-3`, `mt-2.5`, and `gap-0.5` (`:95,163,182`) are separate layout exceptions not documented with that radius. |
| Activity Island and its agents/tabs/plan/shell popovers | `chat/activity-island-ui.tsx`, `agent-model-ui.tsx`, `island-shells.ts`, `island-shells-model.ts` | Needs tweaks | Real shared Popover/ListRow/Button composition (`activity-island-ui.tsx:543,696–703`) is sound; card eyebrow duplicates `SectionHeading` (`:645–648`) and local identity palette remains authored hex (`:161`). |
| Credential request card | `chat/secret-card.tsx` | Needs tweaks | Shared stack shell, Input and Button are present; scope selector is a locally dressed native `<select>` (`:131–147`) instead of the shared Select family. Preserve this card’s trust/redaction boundary. |
| Conversation/subagent peek dialogs | `chat/session-peek-dialog.tsx`, `subagent-peek-dialog.tsx` | Looks good | Shared Dialog, bounded reading width and explicit UI type (`session-peek-dialog.tsx:60–61,79–104`); compact title is workbench chrome above a transcript, not automatically a heading-rung error. |
| Chat empty canvas, loading venue placeholder | `chat/empty/chat-empty-state.tsx`, `empty/board-visual.tsx`, `empty/streak-visual.tsx`, `empty/venue-chips.tsx`, `empty/venue-visual.tsx`, `empty-visual.ts` | Needs tweaks | These are shipped visualizations, not disposable lab work; surrounding `gap-3`/`gap-x-3` (`chat-empty-state.tsx:109`, `venue-visual.tsx:64,111`) drift, while plotted bar/cell geometry is specialized. Streak hover bubble is handrolled (`streak-visual.tsx:85`). |
| New chat/terminal/browser creation control and menus | `sessions/new-session-control.tsx`, `session-create.ts` | Looks good | Shared Button and context/dropdown menus, one menu-row implementation, placement-specific sizes and explicit focus handoff (`new-session-control.tsx:72,109,211,257–313`). |
| First-run Model Access state/menu | `sessions/model-access-first-run.tsx` | Looks good | Explicit prose size, shared controls and bounded provider menu (`:106–132`); pending catalog is kept distinct from genuinely missing access. |
| Session detail dialog, pending/unknown/failure states | `sessions/session-detail-dialog.tsx`, `session-detail-panel.tsx` | Looks good | Shared Dialog and explicit heading/UI hierarchy (`panel:75–76`); pending, unknown and failed-with-Retry are separate (`:128–152`). |
| Session identity/provenance marks | `sessions/session-glyph.tsx`, `session-provenance-mark.tsx` | Looks good | Provider/state composition is explicit and semantic; provenance remains the fixed 12px bold bolt (`provenance-mark:62–67`), not a repeated title or state pill. |
| Resident terminal plane, split/focus chrome, exited-pane recovery | `sessions/sessions-layer.tsx`, `session-split-layout.tsx`, `terminal-view.tsx`, `terminal-viewport-box.tsx`, `ticket-terminal-host.tsx`, `terminal-tab-state.ts` | Looks good | Always-mounted, stable-keyed terminal hosts and CSS visibility preserve engines (`sessions-layer:348–409`); split rings and measured divider geometry are intentional live-view composition. |
| Terminal close confirmation and Session toasts | `sessions/confirm-close-dialog.tsx`, `interrupt-toast.ts`, `session-start-toast.ts` | Looks good | Confirmation uses shared AlertDialog; toast helpers project lifecycle facts rather than inventing another surface container. |
| Sidebar/Rail Session peek card, summary/loading/error/answer states | `session-peek/session-peek-card.tsx`, `sidebar-peek.tsx`, `use-session-peek.tsx`, `peek-content-cache.ts`, `peek-geometry.ts`, `peek-machine.ts`, `peek-subject.ts`, `use-peek-content.ts` | Looks good | `PEEK_FRAME` explicitly supplies `text-ui` (`card:77–78`); measured inset/lead-column exceptions are centralized and recorded (`:84–99`), with bounded skeletons and failure/retry strips. |
| Ticket folder peek and drill rows | `session-peek/ticket-peek-card.tsx` | Looks good | Reuses Session card frame/header/type; drill `py-1.5` is a documented two-line footprint (`:132–154`), not accidental generic list drift. |
| Peek expanded conversation | `session-peek/peek-conversation.tsx` | Looks good | Reuses product conversation dialog and Session semantics; peek reads remain distinct from adopting/opening a live Session. |
| Browser chrome/address/error/holder controls | `browser/browser-chrome.tsx`, `browser-holder-pill.tsx`, `browser-holder-dot.tsx`, `browser-tab-mark.tsx` | Needs tweaks | Shared Input/Button and explicit `text-ui` are present; holder pill locally specifies `pl-2.5` (`holder-pill:52`) instead of a documented/shared compound-control recipe. Identity color is not a status-token error. |
| Native Browser Tab plane and overlay freezing | `browser/browser-pane.tsx`, `browser-plane.ts`, `browser-plane-freeze.ts`, `browser-api.ts`, `open-browser-tab.ts` | Looks good | Native-view bounds/show/hide/frozen-frame ordering is specialized and deliberate (`pane:128–212`, `plane:82–125`); replacing this with an ordinary DOM surface would be incorrect. |
| Pinned live browser preview | `browser/browser-preview.tsx` | Needs tweaks | Fixed-height non-scrolling native plane is intentional (`:36,109–116`); generic frame uses off-ladder `border-border/60` and pane elevation `shadow-raised` (`:65`), worth aligning by role. |
| Transcript Browser Tab card, loading/error/gone/image states | `browser/browser-tab-card.tsx` | Needs tweaks | Bounded semantic card/type are present (`:186`), but loading uses a raw animated icon and pulse div (`:297,317`) rather than shared Spinner/Skeleton. |
| Browser replay dialog and frame/scrubber states | `browser/browser-trace-dialog.tsx`, `browser-trace-model.ts` | Needs tweaks | Replay layout is legitimately specialized; generic frame badge uses `/80`, `px-1.5 py-0.5` (`dialog:345`), and loading is handrolled pulse geometry (`:223,328`). |
| Browser Session cursor | `browser/session-cursor.tsx`, `session-cursor.css` | Looks good | Dedicated native-overlay drawing, identity color and pointer-scale dimensions are documented exceptions; it must not become ordinary in-page or React-pane chrome. |
| File Source/Document/Diff editor planes, loading/failure fallback | `editor/monaco-file-editor.tsx`, `monaco-document-editor.tsx`, `monaco-diff-editor.tsx` | Looks good | Monaco lifecycle, model leases and theme/style hooks are specialized; first-frame loading attributes and explicit readable fallback are present (`file-editor:735,755–763`, `document-editor:506,528`). |
| Editor disk reconciliation/conflict recovery | `editor/live-reconciliation-affordance.tsx` | Looks good | Already composes shared Notice and Button (`:1–2,23,38`), rather than handrolled conflict banners. |
| Markdown file preview, image-unavailable and omitted-HTML states | `editor/markdown-preview.tsx` | Needs tweaks | Explicit `text-sm leading-prose` (`:104`) and bounded media are sound; omitted-HTML block locally uses `bg-muted/40 px-3` (`:251`) instead of shared notice/layout treatment. |
| Markdown view switch and word-wrap menu | `editor/markdown-view-toggle.tsx`, `word-wrap-menu-item.tsx` | Looks good | Shared Segmented, gutter rhythm, UI type and shared ContextMenuCheckboxItem (`toggle:69–85`, `word-wrap:11–23`). |
| Files navigator header and remembered navigation/mutations | `files/navigator-header.tsx`, `navigator-mutations.ts`, `navigator-scope-state.ts`, `use-navigator-mutations.ts` | Needs tweaks | Rail inset and Input/Button are shared, but header retains local `gap-1.5` (`header:87`) without a recorded header-specific exception. |
| Rail file search, idle/pending/empty/error/results | `files/search-panel.tsx`, `search-model.ts` | Needs tweaks | Shared Input/ListRow/empty treatment exists (`panel:394–430`); match highlight uses `/25` (`:500`) and heading spacing uses `gap-1.5` (`:292`). |
| Quick Open palette, no-project/no-match/truncated states | `files/quick-open.tsx`, `quick-open-model.ts` | Needs tweaks | `QUICK_OPEN_ROW` copies menu geometry while importing only state (`:50`), omitting shared `select-none`; `Command.Dialog` also repeats palette container geometry (`:175–185`). |
| Attachment inspection popover | `files/attachment-menu.tsx` | Needs tweaks | Shared ListRow/Popover/EMPTY_INLINE are present; full-width action overrides pill silhouette with `rounded-lg` (`:147`). |
| External-app discovery/open-with menus and copy-path actions | `files/external-app-discovery.tsx`, `external-app-discovery-model.ts`, `external-app-menu.tsx`, `copy-path-menu.tsx` | Looks good | Shared menus, context-menu actions, ButtonGroup and controls; async discovery and action logic do not introduce another generic surface. |
| File save/discard/cancel guard and file workspace ownership | `files/save-guard-dialog.tsx`, `close-guard.ts`, `use-project-file-workspace.ts`, `file-tab-labels.ts` | Looks good | Shared AlertDialog and explicit close outcomes preserve shared drafts; helpers belong to file-tab/workspace behavior, not standalone UI. |
| Composer/transcript attachment thumbnails and strip | `attachments/attachment-strip.tsx`, `attachment-model.ts` | Needs tweaks | Generic file thumbs introduce **10px arbitrary type**, `leading-tight`, `/40`, `/80`, `p-1.5`, and manually sized removal control (`strip:58–81`). |
| File attach door and drag/paste behavior | `attachments/composer-attach-button.tsx`, `file-drop.ts` | Looks good | Shared Button and centralized hidden file picker; drag/paste behavior remains a helper beneath attachment surfaces. |
| Markdown attachment image/unavailable placeholder | `attachments/markdown-image.tsx` | Looks good | Semantic image frame, bounded sizing and explicit `text-ui` unavailable placeholder (`:79–105`). |
| Host switcher popover, current/offline/updating/error rows | `hosts/host-chip.tsx`, `host-surface-model.ts`, `use-hosts.ts` | Needs tweaks | Custom `HostRow`/`MenuAction` duplicate selectable-row/action mechanics (`chip:288–321`), with no authored keyboard focus treatment and `/60` hover fills. |
| Host health island and running-on mark | `hosts/host-island.tsx`, `running-on-label.tsx` | Needs tweaks | Collision-aware placement is intentional; generic island shell locally uses `pr-1.5` (`island:79`). Running-on label itself uses shared StatusDot and explicit UI type (`label:42–49`). |
| Host identity, progress, checklist and provider marks | `hosts/host-parts.tsx` | Needs tweaks | Checklist/progress drawings are specialized, but `ProviderMark`/`PROVIDER_TINT` (`:252–273`) duplicate the sign-in version, including hardcoded provider tint pairs. |
| Add Host sheet: entry, progress, trust/password questions, stopped/retry/ready/cancel states | `hosts/add-host-sheet.tsx`, `add-host-model.ts`, `use-add-host-flow.ts`, `use-restart-session-count.ts` | Needs tweaks | Real shared Dialog/Input/Button underneath; repeats top-anchored sheet recipe (`sheet:96–100`) and uses 36px fields (`:201,530`) plus handrolled copy action (`:812`). |
| Add Host diagnostic details log | `hosts/add-host-sheet.tsx` (`LogView`) | Needs an overhaul | Hardcoded dark surface, white ink and warning/error hex (`:854–880`) bypass theme engine entirely; replace this **subsurface**, not the provisioning flow. |
| Remote Open/New Project sheet: loading, list, notices, clone/folder/sudo failures | `hosts/open-project-sheet.tsx`, `open-project-model.ts` | Needs tweaks | Duplicates Add Host sheet recipe (`:87–91`), handrolls project rows (`:324–334`) and places recovery controls inside `role="status"` (`:402–426`). |
| Host Model sheet and unreachable/update-required states | `hosts/host-model-sheet.tsx` | Looks good | Shared Dialog/Button with explicit `text-ui` status blocks and bounded scroll region (`:28,64,79,106`). |
| Host sign-in sheet/rows, device code, paste/key flows, confirmation | `hosts/sign-ins/host-sign-in-sheet.tsx`, `host-sign-in-rows.tsx`, `host-sign-in-controller.ts`, `host-sign-in-model.ts`, `remote-host-sign-in-source.ts`, `fake-host-sign-in-source.ts` | Needs tweaks | Real shared Dialog/AlertDialog/Input/Segmented underneath; duplicate ProviderMark (`rows:526–545`) and raw 36px copy-code control (`:406`) remain. Fake source is fixture support, not a shipped surface. |
| Host chrome mounting, read-only and local-only unavailable states | `hosts/hosts-chrome.tsx`, `host-entry.ts`, `local-only.tsx`, `read-only-note.tsx`, `use-remote-project.ts` | Needs tweaks | Read-only text explicitly uses UI rung; full local-only unavailable canvas handrolls centering/inset (`local-only:57`) rather than composing `EMPTY_PAGE`. |
| Automations page/navigation/sidebar, no-project/empty/history states | `automations/automations-page.tsx`, `automations-page-model.ts` | Needs tweaks | Local `ViewChoice` duplicates Segmented (`page:140–175`), page header duplicates PageHeader (`:382–410`), and sidebar eyebrow/empty states bypass shared heading/empty recipes (`:566,577`). |
| Automation editor, schedule/column/runtime controls and validation | `automations/automation-editor.tsx`, `editor-draft.ts` | Needs tweaks | Local `SectionLabel`, trigger rows and checkbox picker duplicate shared recipes (`editor:195–284`); fixed `20rem` aside (`:750`) needs narrow verification before layout correction. |
| Automation instructions composer | `automations/automation-editor.tsx` (`InstructionsTextarea`) | Needs tweaks | Correctly reuses `PROMPT_SURFACE` and Add door (`:975`), but footer locally uses `px-3 pb-3` (`:1003`); retain deliberate no-tinted-tray composition. |
| Automation time-zone picker | `automations/time-zone-picker.tsx` | Looks good | Shared Button/Popover/Command with explicit selected mark and bounded list (`:77–104`). |
| Automation lanes and empty offered/unassigned lists | `automations/automation-lanes.tsx` | Needs tweaks | Drag lane composition is specialized, not ordinary ListRow territory; empty copy locally uses `px-1 py-1` (`:216,322`) rather than shared empty-state grammar. |
| Ticket Automation rail list, reading/fault/empty states and Run inspection | `automations/ticket-rail-automations.tsx`, `ticket-rail-automations-model.ts` | Needs tweaks | Shared ListRow/Skeleton/read-feedback is present; empty report uses `text-label` (`:227`), and inspection prose uses `text-label`, `p-3`, `/40`, `/90`, half-step gaps/insets (`:663–738`). |
| Automation context menus and launch helpers | `automations/automation-run-menu.tsx`, `run-automation.ts`, `run-automation-model.ts` | Looks good | Shared ContextMenu and EMPTY_INLINE, explicit read certainty and launch outcomes (`menu:298–329`); no second launch-card primitive. |
| Armed arrival countdown/retry/cancel window | `automations/armed-run-window.tsx`, `armed-run.ts`, `armed-move-model.ts` | Looks good | Explicit UI type and shared Button (`window:112–148`); countdown geometry is specialized temporal feedback, not generic container drift. |
| Automation authoring action | `automations/automation-authoring-button.tsx`, `automation-authoring.ts` | Looks good | Shared Button/Tooltip; launch helper belongs to the authoring door rather than another surface. |
| Model identity/name/reveal | `models/model-identity.tsx`, `resolved-model-name.tsx` | Looks good | Centralized provider/model naming, marks and clipped reveal (`identity:398–506`); intentionally inherits host typography, so standalone hosts must supply a rung. |
| Terminal harness trust dialog and manifest states | `harness/harness-trust-dialog.tsx`, `trust-prompt-model.ts` | Looks good | Shared AlertDialog/Badge, explicit UI-sized command/path, and trust-specific detail (`dialog:92–106`). |
| Log Viewer/LogStream, sources, filters, trace/detail/empty/failure states | `logs/log-viewer.tsx`, `log-viewer-model.ts`, `log-sources.ts`, `remote-log-sources.ts` | Needs tweaks | Structured log layout is specialized; generic row actions are raw buttons (`viewer:211–237`) and local `gap-3 py-0.5 bg-muted/40` (`:201`) escape shared action/spacing recipes. |
| Background shell output dialog, initial/gone/read-failure states | `shell/shell-output-dialog.tsx`, `shell-output-view.tsx` | Needs tweaks | Read-only shell plane is specialized; header/body use `px-3 py-1.5` (`view:90,100`), initial output is blank (`:108`), and read exceptions toast without an in-view retry state (`:62`). |
| Home/Ticket usage rail footers and folds | `usage/home-usage-block.tsx`, `ticket-usage-block.tsx`, `usage-rail.tsx`, `usage-rail-model.ts` | Looks good | Shared rail footer/fold grammar and explicit UI-sized facts (`home:144–223`, `ticket:132–178`); helpers preserve attribution and rank semantics. |
| Usage inspection cards/popovers, ranking and no-calls state | `usage/usage-card.tsx`, `usage-model-catalogue.ts` | Needs tweaks | Shared Popover/SectionHeading/ValueReveal and cost qualifiers; empty face locally uses `px-4 py-4` (`card:492–495`) instead of EMPTY_INLINE. Card/hero APIs remain lab-backed and are included, not assumed to be current rail mounting. |
| Usage class bar/legend | `usage/usage-bar.tsx` | Looks good | Semantic class fills, proportional geometry and explicit UI-sized legend (`:72–82,105–118`); not generic progress-bar duplication. |
| Usage Limits popover: loading/error/empty/accounts | `usage-limits/usage-limits-popover.tsx`, `accounts.ts`, `usage-pin.ts` | Needs tweaks | Shared Popover/Accordion/Spinner/EMPTY_INLINE are present; account-header `gap-1.5` (`:308`) is local spacing drift. |
| Account allowance windows and pin controls | `usage-limits/account-usage.tsx` | Needs tweaks | Accessible meter drawing and shared pin Button are sound; window name uses body `text-sm` for a UI label (`:163`) beside `text-ui` reset/remaining data. |
| Usage Limits chrome glyph and reading projection | `usage-limits/usage-limits-icon.tsx`, `icon-reading.ts` | Looks good | 26px glyph geometry is a specialized meter drawing with derived reading/state; do not flatten its SVG dimensions into generic control geometry. |
