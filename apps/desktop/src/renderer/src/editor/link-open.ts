/**
 * The "does this click follow a link?" rule for the markdown surfaces.
 *
 * It started life inside the old CodeMirror live-preview plugin, which was the
 * wrong home for it: the rule is about a MouseEvent, not about an editor
 * engine. Hoisting it here is what let that plugin be deleted without taking a
 * behavioural rule down with it — Monaco's Document Mode answers exactly the
 * same question, unchanged.
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
