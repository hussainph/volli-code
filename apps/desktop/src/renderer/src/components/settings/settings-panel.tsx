/** Nonmodal, in-app preferences: the workspace remains live behind this panel. */
import * as React from "react";
import { SettingsPage } from "@renderer/components/pages/settings-page";
import { Button } from "@renderer/components/ui/button";
import { CloseIcon } from "@renderer/components/ui/icon";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@renderer/components/ui/dialog";
import { useUiStore } from "@renderer/stores/ui";

/** Window-level shortcut, including while an input in Settings has focus. */
export function useSettingsShortcut() {
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key !== ","
      )
        return;
      event.preventDefault();
      const state = useUiStore.getState();
      state.setSettingsOpen(!state.settingsOpen);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function SettingsPanel() {
  const open = useUiStore((state) => state.settingsOpen);
  const category = useUiStore((state) => state.settingsCategory);
  const provider = useUiStore((state) => state.settingsSignInProviderId);
  const setOpen = useUiStore((state) => state.setSettingsOpen);
  // This component mounts with the opening command, before Radix moves focus.
  const opener = React.useRef(typeof document === "undefined" ? null : document.activeElement);
  const outside = React.useRef(false);
  return (
    <Dialog modal={false} open={open} onOpenChange={setOpen}>
      <DialogContent
        material="none"
        showCloseButton={false}
        className="settings-window"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document
            .querySelector<HTMLInputElement>('[data-settings-panel] input[type="search"]')
            ?.focus();
        }}
        onPointerDownOutside={() => {
          outside.current = true;
        }}
        onInteractOutside={(event) => {
          // Nested menus/popovers portal beside the panel, not inside its DOM.
          const target = event.target;
          if (
            target instanceof Element &&
            target.closest("[data-overlay-layer]") &&
            !target.closest("[data-settings-panel]")
          ) {
            outside.current = false;
            event.preventDefault();
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // Outside clicks keep their own focus and perform their normal action.
          if (
            !outside.current &&
            opener.current instanceof HTMLElement &&
            opener.current.isConnected
          )
            opener.current.focus();
        }}
      >
        <div data-settings-panel className="flex h-full min-h-0 flex-col">
          <div className="settings-window-toolbar">
            <DialogClose asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Close Settings">
                <CloseIcon />
              </Button>
            </DialogClose>
            <DialogTitle className="text-ui">Settings</DialogTitle>
          </div>
          <SettingsPage
            initialCategoryKey={category ?? undefined}
            initialSignInProviderId={provider ?? undefined}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
