# 01 — Board: create a ticket and move it between columns

## Sub-features
- Create from the header button **New ticket** (or the bare `c` hotkey) → dialog → **Create** (⌘↵).
- Create inline from a column's **New** button (placeholder `Ticket title…`, ↵ submits and stays open, Esc closes).
- Move a ticket to another column. Mouse drag can't be driven with `act`; use dnd-kit's **keyboard drag** on the board (focus card → `Space` → `ArrowRight` → `Space`, PROVEN on the live build, VC-703), or open the ticket and use its rail **Status** control.
- Empty columns collapse into a pill with an `Empty` caption. Dropping or moving a card into one expands it.

## How to get to it (user POV)
1. Home → **Board** tab (the first tab in the `Home tabs` strip). The header shows **New ticket**.
2. Click **New ticket**, type a title, then press **Create**. The card appears in **Backlog** with id `DRV-<n>`.
3. Open the card (double-click it, or focus it and press ↵). Its ticket tab opens and the details rail shows **Properties**.
4. **Status: Backlog** → choose **Todo**. Back on the Board, the card sits at the end of Todo.

## Driving it with volli-drive
PROVEN transcript (vd-1b7e41, VC-703) — create from the header, move by keyboard drag:
```
volli-drive find vd-x "New ticket"                               # button "New ticket" [ref=f2e75]
volli-drive act vd-x --gen 1 --ref f2e75 --kind click            # dialog "New ticket"; textbox "Ticket title" [active]
volli-drive act vd-x --gen 2 --ref f2e242 --kind type --text "Drive-created: verify volli-drive"
volli-drive act vd-x --gen 3 --ref f2e272 --kind click           # button "Create ticket" (enabled once a title exists)
#   → card in Backlog: button [ref=f2e276] > article > paragraph "Drive-created: verify volli-drive"
volli-drive act vd-x --gen 4 --ref f2e276 --kind click           # card: button [active] [pressed]
volli-drive act vd-x --gen 5 --ref f2e276 --kind press --key Space   # status: "Draggable item … was moved over droppable area …"
volli-drive act vd-x --gen 6 --kind press --key ArrowRight       # over the next column (Todo)
volli-drive act vd-x --gen 7 --kind press --key Space            # status: "… was dropped over droppable area …"
volli-drive state vd-x sql "SELECT ticket_number, status FROM tickets WHERE ticket_number=5"   # → todo
```
Alternative paths, mapped from code:
```
volli-drive launch --fixture basic            # → vd-xxxx; project "Drive Project", prefix DRV
volli-drive find vd-xxxx "New ticket"         # header button (board-header.tsx:185-191)
volli-drive act vd-xxxx --gen N --ref eA --kind click
volli-drive find vd-xxxx "Ticket title"       # dialog title textbox, placeholder "Ticket title" (composer-form.tsx:452)
volli-drive act vd-xxxx --gen N --ref eB --kind type --text "Drive smoke ticket"
volli-drive act vd-xxxx --gen N --ref eB --kind press --key Meta+Enter   # = button "Create ticket" (composer-footer.tsx:121-122)
volli-drive wait vd-xxxx --text "Drive smoke ticket"
volli-drive find vd-xxxx "Drive smoke ticket" # the card: role=button, [pressed] state; name includes "DRV-<n>"
volli-drive act vd-xxxx --gen N --ref eC --kind click                    # selects and focuses the card
volli-drive act vd-xxxx --gen N --ref eC --kind press --key Enter        # opens it (ticket-card.tsx:188-193)
volli-drive find vd-xxxx "Status:"            # button "Status: Backlog" (ticket-properties.tsx:183,459)
volli-drive act vd-xxxx --gen N --ref eD --kind click
volli-drive act vd-xxxx --gen N --ref <menuitemradio "Todo"> --kind click
volli-drive find vd-xxxx "Home"               # sidebar nav button (nav-list.tsx:21), then tab "Board"
```
- The inline alternative: `find "New"` and take the button whose name is exactly `New` (board-column.tsx:540), not `New ticket`. Then type into textbox `Ticket title…` (board-column.tsx:529) and press `Enter`.
- The new-ticket dialog defaults to **Backlog** (`composer-form.tsx:82`). Its status chip (composer-chips.tsx:29-56) can pick another column before you create.

## End state that proves it
- Visible: on the Board, the **Todo** column contains a card `DRV-<n>` titled "Drive smoke ticket", and Backlog's header count dropped by one. `screenshot --name moved`.
- SQL: the row and its audit trail. Tables are from migrations.ts:79-135; the event kinds are listed in packages/shared/src/ticket-events.ts:11-14.
```
volli-drive state vd-xxxx sql "SELECT t.ticket_number, t.title, t.status, t.archived_at FROM tickets t JOIN projects p ON p.id=t.project_id WHERE p.ticket_prefix='DRV' AND t.title='Drive smoke ticket'"
# → status = 'todo', archived_at NULL
volli-drive state vd-xxxx sql "SELECT e.kind, e.actor, e.payload FROM ticket_events e JOIN tickets t ON t.id=e.ticket_id WHERE t.title='Drive smoke ticket' ORDER BY e.created_at"
# → 'created' {"kind":"created","status":"backlog",...} then 'status_changed' {"kind":"status_changed","from":"backlog","to":"todo"}, actor 'user' (verified live)
```
- CLI: `volli-drive state vd-xxxx cli board --project DRV --json`. The ticket should appear under `columns.todo` as `{id:"DRV-<n>", title, status:"todo"}` (verified live: the JSON is the raw board object `{project, columns:{backlog:[…], todo:[…], …}}`, not wrapped).

## Gotchas
- `act` has no right-click and no mouse drag. The card context menu (**Move to** → column; ticket-context-menu.tsx:197) is mouse-only from here. UNVERIFIED: whether `press Shift+F10` opens the Radix context menu.
- Space on a focused card starts a dnd-kit *keyboard drag* (ticket-card.tsx:170-187) — the proven move path. Each arrow moves one column; the live `status` region narrates over/dropped (with internal ids, not names). Escape cancels.
- While the New ticket dialog is open, everything behind it is inert: those nodes print without refs.
- The bare `c` hotkey is ignored while focus is in a text field, while Settings is open, or while a dialog is open (hooks/use-new-ticket-shortcut.ts:7-17).
- **Create & start** (⇧⌘↵) also starts a chat. That is feature 02, not plain creation.
- Ticket numbers continue from `projects.next_ticket_number`. Read the real id from the card; don't assume one.
- List view (button `List view`) persists per project in `app_state`. If you see rows instead of cards, press `Board view`.
- A card is an unnamed `button` wrapping an `article` with the `DRV-<n>` text and a `paragraph` title (verified live). `find` the title; act on the enclosing `button` ref.
