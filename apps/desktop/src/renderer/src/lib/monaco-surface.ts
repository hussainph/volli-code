/**
 * How the renderer recognizes "this event target sits inside a Monaco editor"
 * from a bare DOM target. Both window-level keyboard guards need the same
 * answer — the plain-"c" new-ticket shortcut (which must not fire while you
 * type code) and the Escape view-dismissal guard (which must not close the
 * ticket detail out from under a caret) — so the *identification* of Monaco
 * lives here once, while each guard keeps its own prose about why Monaco
 * matters to it.
 *
 * Monaco needs explicit entries at all because it is text entry that matches
 * NONE of the generic tokens (`input` / `textarea` / `[contenteditable]`): its
 * input surface in this build is a `div.native-edit-context`.
 *
 * Two anchors on purpose — one Monaco's, one ours — so neither alone is
 * load-bearing:
 *
 *  - `.monaco-editor` — Monaco's own editor ROOT, which wraps whichever input
 *    surface the build uses (`div.native-edit-context` today,
 *    `textarea.inputarea` before it). Matching the ROOT rather than the input
 *    element is what keeps these guards alive across an input-strategy change;
 *    matching `.native-edit-context` would just re-encode the assumption that
 *    already broke once.
 *  - `[data-monaco-status]` — OUR host attribute (components/editor/*), set by
 *    every editor surface we mount. It can't drift without us changing it, and
 *    the e2e smokes read the same attribute.
 *
 * Both entries are single compound selectors, so this stays safe to splice
 * into a larger comma-separated selector union with a template literal.
 */
export const MONACO_SURFACE_SELECTOR = ".monaco-editor, [data-monaco-status]";
