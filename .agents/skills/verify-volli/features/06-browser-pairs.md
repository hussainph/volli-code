# 06 — Browser pairs and Activity Island

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
workspace state and the UI run normally. Do not seed pair state or call renderer
setters to make the behavior happen. A Session can currently own six live tabs;
keep that safety cap intact when testing many pages.

## Drive

1. Home → New chat → send a message. Wait for `Browser pages ready.`
2. Open the Activity Island's browser cluster. Verify title-first rows and
   host:port/path beneath each title, with no preview thumbnail.
3. Press a page row's **Open beside chat**. Verify one joined strip chip, two
   named planes, and one resize separator. Both member tabs remain selectable.
4. Select Board: it must occupy the whole plane, without a separator. Select
   either member of the saved chip: the two planes and divider return.
5. Press **Unpair tabs**. Both tabs stay in the strip; the focused one fills
   the plane. Reveal the page from the Island again to re-form its pair.
6. From the Island, press **Close tab**, then **Undo** within five seconds.
   The row returns with the same page identity and owner. Close a second tab
   without Undo and verify it disappears from both the list and strip.
7. Repeat from a Ticket chat. Selecting the Ticket Body must not retain an
   unrelated chat/browser split. A new untouched Chat Draft must be ordinary
   unless it is filling an explicitly opened empty partner.
8. Switch Appearance between Light and Dark through Settings and repeat the
   reveal/list checks. Capture screenshots of the joined chip, browser chrome,
   and the descriptive list in both appearances.

For the five-second Undo window, a short local script may parse the generation
and Undo ref returned by the Close action and immediately invoke one fresh
`volli-drive act`. It must never guess refs or bypass the semantic driver.

## Durable proof and cleanup

Read the UI's persisted pair intent, not just its pixels:

```sh
volli-drive state vd-xxxx sql "SELECT value FROM app_state WHERE key='volli:workspace'"
volli-drive state vd-xxxx cli session list --project DRV --json
volli-drive console vd-xxxx --tail 30
volli-drive doctor vd-xxxx
volli-drive stop vd-xxxx
```

The workspace record carries `homeSplitView.pairs` or the Ticket's `splitView.pairs`.
Unpairing the final group writes no split. The browser registry itself is live,
not a SQLite row; prove close/Undo with fresh UI snapshots and the native page
identity, not an invented durable browser table. Keep screenshots and the
transcript outside tracked repository files and attach them to the PR.

The pointer-only left/right tab-edge drag is covered by `split-view-smoke.mjs`;
`volli-drive` has no drag verb. Do not claim that gesture was manually driven
when only the keyboard split or **Unpair tabs** was exercised.
