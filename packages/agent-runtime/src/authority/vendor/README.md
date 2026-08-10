# Upstream: pi-automode

The deterministic layer beneath the Authority Snapshot — path canonicalization
and shell lexing — is ported from `pi-automode` rather than written fresh. Both
are the kind of code where the bugs are the cases nobody thought of, and the
upstream ones have been thought of already.

- Repository: https://github.com/czottmann/pi-automode
- Pinned revision: `bd82e29`, tag `v1.11.0`
- Ported by hand, not vendored by a tool. There is no sync script and no
  submodule: an upstream change is read, judged, and applied deliberately, or
  it is not applied. Nothing here auto-merges.

## Files taken

From `extensions/auto-mode/`, into this directory:

| Upstream                                   | Here       |
| ------------------------------------------ | ---------- |
| `paths.ts` — path resolution               | `paths.ts` |
| `hard-deny.ts` — the shell lexer within it | `shell.ts` |
| `constants.ts` — `HOME` only               | `paths.ts` |

## What was left behind, and why

**`hard-deny.ts`'s rule body (`segmentHardDeny`, `deterministicHardDeny`,
`isRootHomeOrSystemPath`).** Those are a rule table, and Volli already has one:
`AUTHORITY_RULE_IDS` in `@volli/shared`, evaluated by `authority-policy.ts`
against a `PolicyToolCall`. Porting the upstream table too would give the
product two tables that can disagree, with no way to say which one refused. The
rules were reimplemented in `@volli/shared` as pure functions over resolved
data; what stayed here is only the part that cannot be pure, because it needs a
filesystem or a lexer.

**`permissions.ts` in full** (`parseToolPattern`, `matchesToolPattern`,
`matchesDeniedPath`, `getPrimaryArgument`). It matches configured permission
strings such as `bash(git push *)` against a call. Volli has no such
configuration: the rule pack is code, pinned by
`BUILTIN_RULE_PACK_ID`/`BUILTIN_RULE_PACK_HASH`, and a Session's authority is
recorded rather than pattern-matched. Every function in that file answers a
question this product does not ask, so vendoring it would have added dead code
under a 100% coverage gate. Its dependency on `ToolPattern` from `types.ts` —
which imports `@earendil-works`, and so cannot be reached from here at all —
is moot as a result.

**`constants.ts` beyond `HOME`.** The protected-path lists, classifier prompts,
and settings-file locations all belong to upstream's configurable policy, not
to path resolution.

## Divergences from upstream

- **No path normalization inside `resolveInputPath`.** Upstream strips a leading
  `@` here, as a guess at what its host does. Guessing is the bug: Pi's file
  tools really do strip `@`, and they also collapse five Unicode spaces, and an
  approximation of someone else's normalization is a hole waiting to reopen —
  `write { path: "@.git/hooks/pre-commit" }` reads as `<ws>/@.git/…` to a rule
  and lands on `<ws>/.git/hooks/…` on disk. So this function stays a plain
  resolve and `../pi-tool-path.ts` reproduces Pi's `normalizeToolPath` exactly,
  pinned to the Pi version and held to it by a differential test.
- **Bare `~` expands, and the expansions nobody can perform are reported as
  such.** Upstream's `shellPathTokenToPath` expands `~/x` and `$HOME` but leaves
  a lone `~` to resolve against the working directory, so `rm -rf ~` produced
  `<cwd>/~` and missed the home root its own comment claims to protect. It
  resolves `~someone` and `$TMPDIR` the same way, to a literal inside the
  workspace, where no rule fires. Here `~`, `$HOME` and `${HOME}` expand, and
  the function returns a tagged result instead of a bare string: a token that
  denotes no location and one whose location cannot be computed are different
  facts, and only the caller knows whether the second is fatal. `../normalize.ts`
  refuses it in the positions a rule reads and drops it everywhere else.
- **`resolvePathForPolicy` refuses instead of falling back.** Upstream callers
  write `resolvePathForPolicy(p) ?? p`, so an unresolvable path is checked in
  its raw form. Here undefined propagates and the call is blocked: the
  normalizer treats "cannot say what file this is" as a refusal.
- **The resolver walks with `readlinkSync`, not `lstatSync` + `readlinkSync`.**
  Same semantics, one syscall, and no branch that only a hypothetical
  filesystem could reach.
- **Input and output redirects are separated.** Upstream collects `<` targets
  into the same `redirectTargets` list as `>`, which would report a read as a
  write. Here `>`/`>>`/`2>`/`>&file` become writes, `<` becomes a read, and a
  descriptor duplication such as `2>&1` becomes neither.
- **No attached-redirect regex.** Upstream re-parses tokens like `>out` as
  redirects after tokenizing. The tokenizer already splits an unquoted `>` from
  its target, so the only token that could reach that regex is a _quoted_
  `">out"` — a literal argument being misread as a redirect.
- **Dead operator branches removed.** Upstream's segment splitter tests
  `char === "|" && next === "|"` after `char === "|"` has already matched;
  `&>` appears in a redirect regex its own tokenizer cannot produce.
- **A single `&` separates commands.** Upstream splits on `;`, `|`, `&&` and
  `||` but not on `&`, so `true & rm -rf ~` lexed as one command whose program
  was `true` and whose `rm` was an argument no rule inspects. The three redirect
  spellings that contain the character — `2>&1`, `&>log`, `>&log` — are held
  together explicitly rather than by leaving `&` alone.
- **`>|` is a redirect operator.** POSIX noclobber-override. Upstream split on
  the `|` first, leaving `echo x >` with its target on the far side, and then
  discarded the operator as having no target — so the write vanished and the
  command was allowed. Splitting is suppressed after `<`/`>`.
- **A redirect with no target throws.** Upstream skips it. Reporting a command
  as writing nowhere is the answer that gets it allowed, which is the one
  outcome this layer must never produce by accident.
- **Grouping punctuation is stripped.** `( rm -rf ~ )` gave the program `"("`,
  `(rm -rf ~)` gave `"(rm"`, and `{ rm -rf ~; }` gave `"{"` — all of which miss
  every program rule. Unbalanced leading `(`/`{` and trailing `)`/`}` are
  removed per token, counted so `${HOME}` and `$(date)` keep their own braces.

## Known limits

Considered and accepted, not overlooked.

**The eval family.** `eval`, `base64 -d | sh`, command substitution, `xargs`,
and every interpreter that takes a program on its command line — `python3 -c`,
`node -e`, `perl -e`, `ruby -e` — hand the real command to a parser this lexer
is not. `sh -c` and `env -S` are unwrapped because their argument is a _shell_
script this lexer can re-read; a Python string is not, and pretending to
understand one would be worse than declining to. The Seatbelt sandbox beneath
does not care which interpreter asked.

**Function definitions.** `f() { rm -rf ~; }; f` defines a body that nothing
executes at definition time, then calls it under a name no rule knows. The same
limit as `eval`, reached a different way.

**Wrapper flags.** Transparent-prefix unwrapping (`../normalize.ts`) steps over
each wrapper's known value-taking flags. One added upstream after that table was
written would again hide the program behind its value.

**Heredocs** are mangled into two `<` operators.

This layer is defence in depth beneath the Seatbelt process sandbox, never the
boundary itself.

## License

pi-automode is MIT licensed.

```text
MIT License

Copyright (c) 2026 Carlo Zottmann

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
