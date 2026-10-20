# Upstream: pi-automode shell lexer

`lexer.ts` is the small lexer ported from
https://github.com/czottmann/pi-automode at `bd82e29` (tag `v1.11.0`),
from the lexer in `extensions/auto-mode/hard-deny.ts`.

VC-504 removed the authority rules, judge and path resolver. Only this lexer
remains: `refuseDaemonizingExecute` uses it to recognize background-lifetime
syntax at the waited-process door and point callers to `shell_start`. It is a
lifecycle guardrail, not a security or process-containment boundary. Generated
commands, interpreters and deeply nested shell text can evade inspection.

The retained divergences separate input/output redirects, preserve quoted
redirect-like arguments, split a single `&` without splitting descriptor
redirects, recognize `>|`, reject redirects without targets, remove dead operator
branches, and strip grouping punctuation/leading shell keywords. The port is
covered by `lexer.test.ts` and `refusal.test.ts`.

Its MIT licence remains in `../../notices/pi-automode.LICENSE.txt`; the package
notice manifest covers only `src/shell/lexer.ts`. There is no automatic sync.
