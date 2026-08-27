/**
 * Word Wrap, as a file tab's context-menu item (plan §4.1).
 *
 * The diff pane has a band to hang this on; a file tab does not, and the rule
 * for this slice is that a control joins the one existing band or a context
 * menu — never a new strip of chrome above every file. So the file tab's own
 * menu is where it lives, and it is the same app-wide switch the band flips.
 */
import { ArrowElbowDownLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowElbowDownLeft";

import { ContextMenuCheckboxItem } from "@renderer/components/ui/context-menu";
import { useUiStore } from "@renderer/stores/ui";

export function WordWrapContextMenuItem() {
  const wordWrap = useUiStore((state) => state.wordWrap);
  const setWordWrap = useUiStore((state) => state.setWordWrap);
  return (
    <ContextMenuCheckboxItem checked={wordWrap} onCheckedChange={setWordWrap}>
      <ArrowElbowDownLeftIcon aria-hidden />
      Word Wrap
    </ContextMenuCheckboxItem>
  );
}
