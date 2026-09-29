# Links and images

## Inline links

Read the [contributing guide](CONTRIBUTING.md) before opening a pull request,
and the [security policy](SECURITY.md "How to report a vulnerability") before
filing anything that looks like one. A link can carry
[**bold text**](https://example.com/bold), [*italic text*](https://example.com/italic),
[`inline code`](https://example.com/code) or
[a mix of **all** of `them`](https://example.com/mix).

Relative links resolve against the file: [the design notes](./DESIGN.md),
[a sibling folder](../licensing/notice-inputs.md), [a heading](#reference-links)
and [a heading in another file](BOUNDARIES.md#rule-1).

Links with parentheses in the destination need angle brackets or escaping:
[Wikipedia](<https://en.wikipedia.org/wiki/Markdown_(disambiguation)>) and
[escaped](https://en.wikipedia.org/wiki/Link_\(disambiguation\)).

An empty label still parses: [](https://example.com/empty). So does a label
with an [escaped \] bracket](https://example.com/escaped).

## Reference links

The [board][board] reads from the same ledger as the [CLI][cli-ref]. Reference
labels are case-insensitive, so [Board][BOARD] resolves too, and a collapsed
reference like [board][] or a shortcut reference like [cli-ref] works as well.

[board]: https://example.com/board "The board"
[cli-ref]: https://example.com/cli
[BOARD]: <https://example.com/board-upper>

## Autolinks

Angle-bracket autolinks: <https://example.com/autolink> and
<mailto:security@example.com>. Bare URLs such as https://example.com/bare are
text to the parser unless the GFM autolink extension is on.

## Images

![The board with three columns](assets/board.png)

![A ticket's rail, narrow](./assets/rail-narrow.webp "The rail at 240px")

An image can sit inside a paragraph, ![inline icon](icons/dot.svg), and an
image can be the label of a link, which is how badges are written:
[![Build status](https://example.com/badge.svg)](https://example.com/ci).

A reference image: ![logo][logo-ref].

[logo-ref]: assets/logo.png "Logo"

## Links in lists

- [Board](https://example.com/board): columns, cards and filters.
- [Tickets](https://example.com/tickets): the unit of work.
- [Sessions](https://example.com/sessions): the conversations working them.
- [Automations](https://example.com/automations): rules that start Sessions.
- [Worktrees](https://example.com/worktrees): one checkout per ticket.
- [Files](https://example.com/files): the navigator and the editor.
- [Search](https://example.com/search): find across files.
- [Settings](https://example.com/settings): providers, models and keys.
