/**
 * The "does this click follow a link?" rule, shared by both markdown renderers.
 *
 * It started life inside the CodeMirror live-preview plugin, which is the wrong
 * home for it now: the rule is about a MouseEvent, not about an editor engine,
 * and Monaco's Document Mode has to answer exactly the same question for the
 * same reason. Keeping it here means the CodeMirror surface and the Monaco one
 * cannot drift on which clicks navigate while both exist, and PR 3 can delete
 * `components/editor/` without taking a behavioural rule down with it.
 *
 * The rule is deliberately narrow. A collapsed link only carries a target while
 * the caret is OUTSIDE it (see `markdown-projection.ts`, which nulls the href on
 * reveal), so a hit here always means "follow", never "edit" — which makes it
 * important that everything a user could plausibly mean as something OTHER than
 * "follow" falls through untouched:
 *
 *  - button 2 (right) opens the context menu.
 *  - button 1 (middle) is paste-on-X11 / autoscroll, never navigation here.
 *  - ctrl+left IS the macOS context-menu chord, so it must behave like a right
 *    click even though its `button` is 0.
 */
export function shouldOpenLink(event: { button: number; ctrlKey: boolean }): boolean {
  return event.button === 0 && !event.ctrlKey;
}
