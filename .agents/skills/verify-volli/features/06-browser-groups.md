# 06 — Browser tab groups and Activity Island

## Setup

Serve two distinct titled pages on loopback, for example `/login` and `/settings`.
Create a fake-provider reply sequence (replace the port with the fixture server's):

```json
[
  {"toolCalls":[
    {"name":"browser_navigate","arguments":{"url":"http://127.0.0.1:5173/login"}},
    {"name":"browser_navigate","arguments":{"url":"http://127.0.0.1:5173/settings"}}
  ]},
  {"text":"Browser pages ready."}
]
```

Launch `volli-drive launch --fixture basic --model fake --fake-script replies.json`.
The fake provider is the only mocked boundary; Browser tools, page loading,
workspace state and the UI run normally. Do not seed group state or call
renderer setters to make the behavior happen. A Session can currently own six
live tabs; keep that safety cap intact when testing many pages.

## Drive

1. Home → New chat → send a message. Wait for `Browser pages ready.`
2. Open the Activity Island's browser cluster. Verify title-first rows and
   host:port/path beneath each title, with no preview thumbnail.
3. Press a page row's **Open beside chat**. Verify ONE group chip on the top
   strip (segments: the chat and the page), two named panes side by side with
   one resize separator, and a strip of its own on top of each pane.
4. Select Board on the top strip: it occupies the whole plane, no separator,
   no pane strips. Select either segment of the chip: the two panes, their
   ratio and divider return exactly.
5. With the group shown, press **Open beside chat** on the second page: the
   chat's pane splits again — three panes, still one chip.
6. Focus the chat's pane, then New chat (⌘T or the strip's New chat): the
   Draft opens in FRONT of that pane's stack (its pane strip shows both tabs),
   never as a full-width tab. Do the same with New terminal. Type into the
   Draft: it stays in that pane.
7. ⌘\ splits the focused pane; its empty pane offers the menu. Close pane
   from that menu: no tab closes.
8. Right-click the chip: every tab of the group is listed by pane, each pane's
   front checked. Choose a non-front tab: it comes to the front of its pane.
   Choose **Ungroup**: the chip goes, every tab stays on the top strip, and the
   selected one fills the plane. Reveal a page from the Island with **Show tab**:
   it is SELECTED full width, never pulled into a group.
9. From the Island, press **Close tab**, then **Undo** within five seconds.
   The row returns with the same page identity and owner. Close a second tab
   without Undo and verify it disappears from both the list and the strips.
10. Repeat from a Ticket chat. Selecting the Ticket Body must not show an
    unrelated chat/browser group, and a new untouched Chat Draft opened while a
    group is shown lands in the focused pane.
11. Switch Appearance between Light and Dark through Settings and repeat the
    reveal/list checks. Capture screenshots of the group chip, its menu, the
    pane strips, browser chrome, and the descriptive list in both appearances.

For the five-second Undo window, a short local script may parse the generation
and Undo ref returned by the Close action and immediately invoke one fresh
`volli-drive act`. It must never guess refs or bypass the semantic driver.

## Durable proof and cleanup

Read the UI's persisted group intent, not just its pixels:

```sh
volli-drive state vd-xxxx sql "SELECT value FROM app_state WHERE key='volli:workspace'"
volli-drive state vd-xxxx cli session list --project DRV --json
volli-drive console vd-xxxx --tail 30
volli-drive doctor vd-xxxx
volli-drive stop vd-xxxx
```

The workspace record carries the groups in `homeSplitView.pairs` (or the
Ticket's `splitView.pairs` — the field kept its first name): one split tree per
group, each pane a `tabIds` stack with its `activeTabId` front, no pane ever
named `root`. An untouched Draft never appears there. Ungrouping the final
group writes no split. The browser registry itself is live, not a SQLite row;
prove close/Undo with fresh UI snapshots and the native page identity, not an
invented durable browser table. Keep screenshots and the transcript outside
tracked repository files and attach them to the PR.

The pointer-only gestures — tab-edge grouping on the top strip, centre and
edge drops on panes, dragging a pane tab up to the top strip to leave its
group — are covered by `split-view-smoke.mjs`; `volli-drive` has no drag verb.
Do not claim a gesture was manually driven when only the keyboard split, the
chip menu or **Open beside chat** was exercised.
