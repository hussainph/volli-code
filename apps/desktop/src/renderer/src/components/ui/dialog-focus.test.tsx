// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useDialogFocusReturn } from "@renderer/hooks/use-dialog-focus-return";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./dialog";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
function Fixture({
  trigger = false,
  override = false,
  skip = false,
}: {
  trigger?: boolean;
  override?: boolean;
  skip?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const { restoreFocus, skipFocusReturn } = useDialogFocusReturn(open);
  return (
    <>
      <button id="destination">Destination</button>
      <Dialog open={open} onOpenChange={setOpen}>
        {trigger ? (
          <DialogTrigger id="invoker">Open</DialogTrigger>
        ) : (
          <button id="invoker" onClick={() => setOpen(true)}>
            Open
          </button>
        )}
        <DialogContent
          onCloseAutoFocus={
            override
              ? (event) => {
                  event.preventDefault();
                  document.getElementById("destination")?.focus();
                  restoreFocus(event);
                }
              : restoreFocus
          }
        >
          <DialogTitle>Fixture</DialogTitle>
          <input autoFocus aria-label="Inside" />
          <button
            id="dismiss"
            onClick={() => {
              if (skip) skipFocusReturn();
              setOpen(false);
            }}
          >
            Dismiss
          </button>
        </DialogContent>
      </Dialog>
    </>
  );
}
for (const trigger of [false, true])
  it(`restores keyboard invoker after dismissal (Radix trigger ${trigger})`, async () => {
    await act(async () => root.render(<Fixture trigger={trigger} />));
    const invoker = document.getElementById("invoker")!;
    await act(async () => {
      invoker.focus();
      invoker.click();
    });
    await settle();
    expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull();
    await act(async () => document.getElementById("dismiss")!.click());
    await settle();
    expect(document.activeElement).toBe(invoker);
  });
it("leaves default close focus alone when no HTML invoker exists", async () => {
  const close = new Event("closeAutoFocus", { cancelable: true });
  function NoInvoker() {
    const { restoreFocus } = useDialogFocusReturn(true);
    React.useLayoutEffect(() => restoreFocus(close), [restoreFocus]);
    return null;
  }
  const active = vi.spyOn(document, "activeElement", "get").mockReturnValue(null);
  try {
    await act(async () => root.render(<NoInvoker />));
    expect(close.defaultPrevented).toBe(false);
  } finally {
    active.mockRestore();
  }
});
it("honours a caller's explicit focus handoff", async () => {
  await act(async () => root.render(<Fixture override />));
  await act(async () => {
    document.getElementById("invoker")!.focus();
    document.getElementById("invoker")!.click();
  });
  await settle();
  await act(async () => document.getElementById("dismiss")!.click());
  await settle();
  expect(document.activeElement).toBe(document.getElementById("destination"));
});
it("does not pull focus back after a navigation selection", async () => {
  await act(async () => root.render(<Fixture skip />));
  const invoker = document.getElementById("invoker")!;
  await act(async () => {
    invoker.focus();
    invoker.click();
  });
  await settle();
  const focus = vi.spyOn(invoker, "focus");
  await act(async () => document.getElementById("dismiss")!.click());
  await settle();
  expect(focus).not.toHaveBeenCalled();
});
it("ignores an invoker removed while the dialog is open", async () => {
  await act(async () => root.render(<Fixture />));
  const invoker = document.getElementById("invoker")!;
  await act(async () => {
    invoker.focus();
    invoker.click();
  });
  await settle();
  invoker.remove();
  const focus = vi.spyOn(invoker, "focus");
  await act(async () => document.getElementById("dismiss")!.click());
  await settle();
  expect(focus).not.toHaveBeenCalled();
  // Restore React's host node before teardown.
  host.append(invoker);
});
