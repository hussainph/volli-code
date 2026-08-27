/**
 * Go to Line, surfaced (plan §4.1).
 *
 * Monaco has always had this: `editor.action.gotoLine` ships in the standalone
 * bundle, quick-input provider and all, already bound to ⌃G on macOS. What it
 * did not have was a way in from anywhere except that keystroke — no menu entry,
 * no palette row, nothing on screen that says the command exists. Everything
 * here is that surfacing and nothing more; the action itself stays Monaco's.
 *
 * Two things live here because they are one decision. The binding is registered
 * on our own action id so it is a product fact rather than an inherited default
 * (Monaco's binding is `EditorContrib` weight and would answer either way — this
 * just makes it OURS, and testable). And the editor a palette row would land in
 * is remembered here, because by the time that row runs, the palette has closed
 * and focus is on the body: a command invoked from outside Monaco has to be told
 * which editor it meant.
 */

/** Monaco's own Go to Line action id (`standaloneGotoLineQuickAccess`). */
export const GO_TO_LINE_ACTION_ID = "editor.action.gotoLine";

/** The slice of a live Monaco editor running Go to Line needs. */
export interface GoToLineEditor {
  focus(): void;
  getAction(id: string): { run(): unknown } | null;
}

/** …plus what registering the binding on it needs. */
export interface GoToLineHost extends GoToLineEditor {
  addAction(descriptor: { id: string; label: string; keybindings?: number[]; run(): void }): {
    dispose(): void;
  };
  onDidFocusEditorText(listener: () => void): { dispose(): void };
}

/**
 * The editor an outside-Monaco Go to Line lands in: the one focused most
 * recently, else the one most recently mounted. Module state rather than a
 * store because nothing renders from it — it is answered at the moment a
 * command runs, and a re-render in between would say nothing new.
 */
let tracked: GoToLineEditor | null = null;

/** Remember `editor` as that target; the returned call forgets it again. */
export function trackGoToLineEditor(editor: GoToLineEditor): () => void {
  tracked = editor;
  return () => {
    if (tracked === editor) tracked = null;
  };
}

/** Whether anything on screen can answer Go to Line right now. */
export function canGoToLine(): boolean {
  return tracked !== null;
}

/**
 * Open Monaco's Go to Line quick input.
 *
 * Focus first: the quick input is an overlay widget of the editor that owns it
 * and reads its keystrokes, so opening it over an editor the user is not in
 * would put a caret prompt on screen that swallows nothing. `false` means there
 * was nothing to open it on — no editor, or a Monaco build without the action —
 * which is the caller's cue to say so rather than to fail silently.
 */
export function runGoToLine(editor: GoToLineEditor | null = tracked): boolean {
  if (editor === null) return false;
  const action = editor.getAction(GO_TO_LINE_ACTION_ID);
  if (action === null) return false;
  editor.focus();
  void action.run();
  return true;
}

/**
 * Bind Go to Line on one editor and make it the palette's target.
 *
 * `keybinding` is the caller's `monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyG` —
 * passed in rather than imported so this module never drags the Monaco chunk
 * into a bundle that only wanted to ask whether a command is available.
 *
 * Dispose it when the editor goes: the action belongs to that editor, and a
 * tracked editor that has been torn down would send the palette's row to a
 * disposed widget.
 */
export function surfaceGoToLine(editor: GoToLineHost, keybinding: number): { dispose(): void } {
  const action = editor.addAction({
    id: "volli.editor.goToLine",
    label: "Go to Line…",
    keybindings: [keybinding],
    run: () => {
      runGoToLine(editor);
    },
  });
  const focus = editor.onDidFocusEditorText(() => {
    tracked = editor;
  });
  const untrack = trackGoToLineEditor(editor);
  return {
    dispose() {
      action.dispose();
      focus.dispose();
      untrack();
    },
  };
}
