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

- **No leading-`@` stripping in `resolveInputPath`.** Upstream treats `@foo` as
  `foo`. Pi's file tools do not: they hand `path` straight to `path.resolve`. A
  repository full of `@types/…` and `@scope/…` directories would therefore have
  policy inspect one file while the tool opens another, which is a soundness
  hole, not a convenience.
- **Bare `~` expands.** Upstream's `shellPathTokenToPath` expands `~/x` and
  `$HOME` but leaves a lone `~` to resolve against the working directory, so
  `rm -rf ~` produced `<cwd>/~` and missed the home root its own comment claims
  to protect. Here `~`, `$HOME`, and `${HOME}` all resolve to the home
  directory.
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

## Known limits

Inherited from upstream and not fixed here: `eval`, `base64`, command
substitution, and `xargs` all defeat the lexer, and heredocs are mangled into
two `<` operators. This layer is defence in depth beneath the Seatbelt process
sandbox, never the boundary itself.

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
