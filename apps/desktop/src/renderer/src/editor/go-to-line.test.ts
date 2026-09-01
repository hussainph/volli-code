import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  canGoToLine,
  GO_TO_LINE_ACTION_ID,
  runGoToLine,
  surfaceGoToLine,
  trackGoToLineEditor,
  type GoToLineHost,
} from "./go-to-line";

/** A stand-in for one live Monaco editor, recording what was asked of it. */
function fakeEditor(options: { action?: boolean } = {}) {
  const run = vi.fn();
  const focus = vi.fn();
  const actionDispose = vi.fn();
  const focusDispose = vi.fn();
  const listeners: (() => void)[] = [];
  const editor: GoToLineHost & {
    run: typeof run;
    focus: typeof focus;
    actionDispose: typeof actionDispose;
    focusDispose: typeof focusDispose;
    registered: { id: string; label: string; keybindings?: number[]; run(): void }[];
    fireFocus(): void;
  } = {
    focus,
    run,
    actionDispose,
    focusDispose,
    registered: [],
    getAction: (id: string) =>
      id === GO_TO_LINE_ACTION_ID && options.action !== false ? { run } : null,
    addAction: (descriptor) => {
      editor.registered.push(descriptor);
      return { dispose: actionDispose };
    },
    onDidFocusEditorText: (listener: () => void) => {
      listeners.push(listener);
      return { dispose: focusDispose };
    },
    fireFocus: () => {
      for (const listener of listeners) listener();
    },
  };
  return editor;
}

// Module state is deliberate (see the module doc); each test starts from empty.
beforeEach(() => {
  trackGoToLineEditor({ focus: () => {}, getAction: () => null })();
});

describe("runGoToLine", () => {
  it("focuses the editor before opening Monaco's own quick input", () => {
    const editor = fakeEditor();

    expect(runGoToLine(editor)).toBe(true);

    expect(editor.focus).toHaveBeenCalledTimes(1);
    expect(editor.run).toHaveBeenCalledTimes(1);
    // Focus first: the quick input reads the keystrokes of the editor it hangs
    // over, so opening it over an unfocused one would swallow nothing.
    expect(editor.focus.mock.invocationCallOrder[0]!).toBeLessThan(
      editor.run.mock.invocationCallOrder[0]!,
    );
  });

  it("reports no target rather than failing silently", () => {
    expect(runGoToLine(null)).toBe(false);
  });

  it("reports a Monaco build that does not carry the action", () => {
    const editor = fakeEditor({ action: false });

    expect(runGoToLine(editor)).toBe(false);
    expect(editor.focus).not.toHaveBeenCalled();
  });
});

describe("surfaceGoToLine", () => {
  it("binds the supplied keystroke to Monaco's action and takes the target", () => {
    const editor = fakeEditor();

    const surfaced = surfaceGoToLine(editor, 0x100_25);

    expect(canGoToLine()).toBe(true);
    const registered = editor.registered[0]!;
    expect(registered).toMatchObject({ id: "volli.editor.goToLine", keybindings: [0x100_25] });
    registered.run();
    expect(editor.run).toHaveBeenCalledTimes(1);

    surfaced.dispose();
    expect(editor.actionDispose).toHaveBeenCalledTimes(1);
    expect(editor.focusDispose).toHaveBeenCalledTimes(1);
    // A disposed editor is no longer somewhere the palette may send a command.
    expect(canGoToLine()).toBe(false);
  });

  it("hands the target to whichever editor was focused last", () => {
    const first = fakeEditor();
    const second = fakeEditor();

    surfaceGoToLine(first, 1);
    surfaceGoToLine(second, 1);
    first.fireFocus();

    expect(runGoToLine()).toBe(true);
    expect(first.run).toHaveBeenCalledTimes(1);
    expect(second.run).not.toHaveBeenCalled();
  });

  it("leaves a live editor's claim alone when a stale one is disposed", () => {
    const stale = fakeEditor();
    const live = fakeEditor();

    const surfaced = surfaceGoToLine(stale, 1);
    surfaceGoToLine(live, 1);
    surfaced.dispose();

    expect(canGoToLine()).toBe(true);
    expect(runGoToLine()).toBe(true);
    expect(live.run).toHaveBeenCalledTimes(1);
  });
});
