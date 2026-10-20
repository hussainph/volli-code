# Board and Ticket vocabulary

## What a Ticket is

A **Ticket** is one unit of work on the board. It has a _title_, a *body*, a
status column, and zero or more **Sessions** working on it. The body is
ordinary Markdown, which is why this file exists: it is the shape of the prose
people actually write into one.

### Status columns

The default columns are **Backlog**, **Todo**, **In progress**, **In review**
and **Done**. A column is ***data***, not a hard-coded enum — a project can
rename or reorder them, and `ticket move` takes the column's name.

#### Priority

Priority is one of `low`, `medium` or `high`. It sorts the column and nothing
else: a __high__ ticket is not scheduled ahead of a *low* one by anything but a
person reading the board.

##### Labels

Labels are free text. `bug`, `perf` and `docs` are conventions, not ~~rules~~
reserved words.

###### Archival

An archived ticket keeps its history. **Archiving is _not_ deletion** — the
ticket, its comments and its events stay readable, and _un-archiving puts it
back **exactly** where it was_.

## Closing hashes are allowed ##

A heading may end in its own run of hashes, and the projection should hide
both ends without eating the words between them.

### Emphasis inside emphasis ###

Nested spans reveal independently: **bold with *italic* inside**, *italic with
**bold** inside*, `code that is never emphasised **here**`, and a
~~struck phrase with **bold** in it~~.

Underscores inside words do not start emphasis: snake_case_name,
`another_snake_case`, and file_name_v2.md stay literal. Stars inside words do:
un*frigging*believable.

Setext level one
================

Setext headings are rarer, but they appear in older READMEs and in text pasted
from other tools.

Setext level two
----------------

The underline is part of the heading, not a thematic break, and the line above
it is the heading's text.

## Inline code

Use `volli ticket show VC-12` to read one ticket, ``a `backtick` inside`` when
the code itself holds a backtick, and ` padded ` code when leading spaces
matter. A span can hold `**stars**`, `_underscores_` and `[brackets](nowhere)`
without any of them turning into markup.

## Escapes and entities

Literal \*stars\*, literal \_underscores\_, a literal \# at the start, a
literal \[bracket\], a backslash before a letter \q stays, and entities like
&amp;, &lt;tag&gt;, &copy; and &#169; render as their characters.

## Long paragraph

A Session is a running conversation between a person, an agent and a
workspace. It starts on a ticket or on its own, it can be stopped and resumed,
and its transcript is durable: **every message**, *every tool call* and
`every result` is kept in the ledger so a later reader can see not only what the
agent did but why it thought that was the right thing to do. When a Session
ends, its ticket does not: the ticket is the unit a person tracks, and a
Session is one attempt at moving it forward. Several Sessions can work one
ticket over its life, and **none of them owns it**.
