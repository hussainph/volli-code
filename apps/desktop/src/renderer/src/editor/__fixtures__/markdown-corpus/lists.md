# Lists

## Bullets

- One bullet with `-`.
- Another with **bold** and a [link](https://example.com).
- A third with `code`.

* Bullets with `*` start a new list.
* They render the same way.

+ And with `+`.
+ Also the same.

## Ordered

1. Create the ticket.
2. Start a Session on it.
3. Review the diff.
4. Commit, push, and open the pull request.
5. Move the ticket to **Done** once it merges.

1) Parenthesis delimiters work.
2) They are less common.

7. A list can start at any number.
8. Numbering continues from there.

## Nested

- Board
  - Columns
    - Backlog
    - In progress
    - Done
  - Filters
    - By label
    - By priority
- Ticket
  1. Body
  2. Comments
  3. Events
     - Status moves
     - Signals
- Session
  - Transcript
  - Tool calls
    - `read`
    - `bash`
    - `edit`

## Loose lists

- A loose list item has a blank line after it.

- Each item becomes its own paragraph, with *emphasis*, `code` and
  [links](https://example.com) inside it.

- A continuation paragraph belongs to the item above it:

  indented to the item's content column, it stays in the list.

## Lists with code

1. Install the dependencies:

   ```sh
   pnpm install
   ```

2. Run the checks:

   ```sh
   pnpm check
   pnpm typecheck
   ```

3. Start the app:

   ```sh
   pnpm dev
   ```

## Task lists

- [x] Prune the stale docs
- [x] Fix the references
- [ ] Re-run the checks
  - [x] typecheck
  - [x] lint
  - [ ] tests
- [ ] Open the pull request
- [ ] Wait for review

## Long list

- Alpha: the first pass, which only reads.
- Bravo: the second pass, which writes to a scratch copy.
- Charlie: the third pass, which **commits** the scratch copy.
- Delta: rollback, if the third pass fails.
- Echo: the audit record.
- Foxtrot: *optional* cleanup.
- Golf: `fsync` before rename.
- Hotel: rename into place.
- India: fsync the directory.
- Juliet: report success.
- Kilo: or report the failure, with the path.
- Lima: never both.
