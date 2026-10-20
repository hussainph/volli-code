# Blockquotes

> A quote is one or more lines each starting with `>`.
> It can hold **bold**, *italic*, `code` and [links](https://example.com).

> A lazy continuation line
belongs to the quote above it even without its marker.

> Nested quotes:
>
> > The inner quote is a quote inside a quote.
> >
> > > And a third level, which is where most renderers stop being readable.

> ## A heading inside a quote
>
> - A list inside a quote
> - With two items
>   - And a nested one
>
> 1. An ordered list inside a quote
> 2. With its second item
>
> ```ts
> const quoted = "code inside a quote";
> ```
>
> ---
>
> A rule inside a quote, then a closing paragraph.

> **Note:** callout-style quotes are ordinary quotes whose first word is bold.

> **Warning:** the projection hides the `>` and the space after it, and must
> put both back when the caret lands on the line.

- A list item holding a quote:

  > quoted inside the item
  > on two lines

- And another item after it.
