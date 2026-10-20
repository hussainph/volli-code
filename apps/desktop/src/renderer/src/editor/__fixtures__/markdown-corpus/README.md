# Markdown corpus fixture

Representative repository Markdown for `document-view-policy.test.ts`. The
sweep there checks, for every file Document view agrees to open, that every
span the projection hides or replaces comes back when the caret is put inside
it — so these files deliberately cover every construct the projection has a
rule for: ATX and Setext headings, nested emphasis, inline code, escapes,
inline/reference/auto links, images and badges, bullet/ordered/nested/loose and
task lists, nested blockquotes, backtick/tilde/long/indented fences, tables,
thematic breaks, inline HTML, hard breaks and non-Latin text. `changelog.md`
adds the densest shape repository Markdown takes: list item after list item,
each with bold, code and a link.

`frontmatter.md` and `html-block.md` are the two constructs that refuse the
whole file; the test expects exactly those refusals from this folder.

The folder is excluded from `vp fmt`, because a formatter would normalise the
very variants (`*` vs `_`, Setext underlines, tilde fences) it exists to keep.
