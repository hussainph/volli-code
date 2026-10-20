Design note: worktree cleanup
=============================

Status: **accepted** · Owner: *the desktop team* · Ticket: `VC-113`

---

## Problem

A ticket's worktree is a real checkout on disk. When the ticket is done, the
checkout is dead weight: it holds a branch that has merged, a `node_modules`
that is hundreds of megabytes, and build output nobody will read again.

Leaving it costs disk. Deleting it too early costs work — a person may still
have **uncommitted changes** in it, or a pull request may still be open.

## Rules

1. A worktree is reclaimed only when its ticket is in **Done**, *and*
2. its pull request has merged, *and*
3. `git status` reports it clean.

If any of the three is unknown — the network is down, `gh` is not signed in,
the status call failed — the answer is **no**, not "probably".

***

## Edge cases

- **A ticket moved back out of Done.** The reclaim is cancelled; nothing on
  disk was touched yet.
- **The checkout was deleted by hand.** Recording it as reclaimed is fine;
  recreating it is a separate, explicit action.
- **Two tickets share a branch.** They cannot: one worktree, one branch.

> The guiding rule: *a deletion the user did not expect is worse than a
> checkout they have to delete themselves.*

___

## Keyboard

Press <kbd>⌘</kbd>+<kbd>K</kbd> to open the palette, then type the ticket's
id. Inline HTML like <kbd>Esc</kbd> stays visible as its own bytes.

<!-- An HTML comment is not structure and is never hidden. -->

## Line breaks

A hard break with two trailing spaces  
continues on the next line, and a backslash break\
does the same.

## Other scripts

作業ツリーは、チケットごとに一つの作業コピーです。**完了**したチケットの作業ツリーは、
変更がなく、プルリクエストがマージされた後にだけ削除されます。

Рабочее дерево удаляется *только* после слияния запроса на изменение.

Emoji are text too: ✅ done, ⏳ waiting, ❌ refused.

## Summary

| Condition | Reclaim? |
|-----------|----------|
| Done, merged, clean | **yes** |
| Done, merged, dirty | no |
| Done, open PR | no |
| Not done | no |
| Unknown | no |
