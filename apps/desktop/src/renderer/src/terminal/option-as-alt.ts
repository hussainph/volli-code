/**
 * ghostty `macos-option-as-alt` (issue #18): with it set, the chosen Option
 * key emits ESC-prefixed input (Alt semantics for readline/emacs/tmux users)
 * instead of macOS composed characters (Option+b → "∫").
 *
 * Two facts force this to live in front of the renderer's own key handling:
 *  1. restty 0.2.0 encodes Alt chords as ESC + event.key — but on macOS
 *     `event.key` is already the COMPOSED character, so it emits ESC+∫ where
 *     ghostty emits ESC+b. The base character must be re-derived from
 *     `event.code`.
 *  2. `KeyboardEvent.location` distinguishes left/right ONLY on the Alt
 *     keydown itself, never on the chorded key — so sided config ("left" /
 *     "right") needs a tracker that remembers which Option keys are held.
 *     (cmux shipped a sided-modifier bug on exactly this key.)
 *
 * The `event.code` → character table is the US physical layout. Non-US
 * layouts fall through (return null) for punctuation that moved, which
 * leaves restty's default behavior — imperfect but never worse than today.
 */

export type MacosOptionAsAlt = "left" | "right" | boolean;

/** The KeyboardEvent subset the encoder reads — structural for testability. */
export interface AltChordKeyEvent {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  code: string;
  key: string;
}

/** US-layout base/shifted characters for non-letter, non-digit codes. */
const PUNCTUATION_BY_CODE: Record<string, readonly [base: string, shifted: string]> = {
  Backquote: ["`", "~"],
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Backslash: ["\\", "|"],
  Semicolon: [";", ":"],
  Quote: ["'", '"'],
  Comma: [",", "<"],
  Period: [".", ">"],
  Slash: ["/", "?"],
};

const SHIFTED_DIGITS: Record<string, string> = {
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
  "0": ")",
};

/** The character this physical key produces WITHOUT Option (US layout). */
function baseCharacter(code: string, shifted: boolean): string | null {
  if (/^Key[A-Z]$/.test(code)) {
    const letter = code.slice(3);
    return shifted ? letter : letter.toLowerCase();
  }
  const digitMatch = /^Digit([0-9])$/.exec(code);
  if (digitMatch !== null) {
    const digit = digitMatch[1]!;
    // The regex makes the lookup total — every digit has a shifted symbol.
    return shifted ? SHIFTED_DIGITS[digit]! : digit;
  }
  const punctuation = PUNCTUATION_BY_CODE[code];
  if (punctuation !== undefined) {
    return shifted ? punctuation[1] : punctuation[0];
  }
  return null;
}

/**
 * The ESC-prefixed sequence for an Option chord under `mode`, or null when
 * the event must fall through to the renderer's own encoding (mode off,
 * wrong Option side, other modifiers involved, or an unmapped key).
 *
 * Side rule: "left"/"right" require that side to be tracked as held; when
 * NEITHER side was observed (focus arrived with Option already down, so the
 * tracker missed the keydown) a sided mode falls through rather than guess.
 * `true` trusts `event.altKey` alone.
 */
export function optionAsAltSequence(
  event: AltChordKeyEvent,
  mode: MacosOptionAsAlt | null,
  leftAltDown: boolean,
  rightAltDown: boolean,
): string | null {
  if (mode === null || mode === false) return null;
  // Ctrl/Cmd chords have their own encodings; only a pure Option chord remaps.
  if (!event.altKey || event.ctrlKey || event.metaKey) return null;
  if (mode === "left" && !leftAltDown) return null;
  if (mode === "right" && !rightAltDown) return null;
  const character = baseCharacter(event.code, event.shiftKey);
  if (character === null) return null;
  return `\x1b${character}`;
}

// ---- Held-Option-side tracker ----------------------------------------------

const DOM_KEY_LOCATION_LEFT = 1;
const DOM_KEY_LOCATION_RIGHT = 2;

let leftAltHeld = false;
let rightAltHeld = false;
let trackerInstalled = false;

/** Which Option keys are currently held, per the window-level tracker. */
export function heldAltSides(): { left: boolean; right: boolean } {
  return { left: leftAltHeld, right: rightAltHeld };
}

/**
 * Window-capture listeners recording which Option side is held. Installed
 * once, app-wide (modifier state is global, not per-terminal); `blur` clears
 * both sides because keyup never fires for keys released outside the window.
 */
export function installAltSideTracker(target: Window): void {
  if (trackerInstalled) return;
  trackerInstalled = true;
  const record = (event: KeyboardEvent, held: boolean): void => {
    if (event.key !== "Alt") return;
    if (event.location === DOM_KEY_LOCATION_LEFT) leftAltHeld = held;
    else if (event.location === DOM_KEY_LOCATION_RIGHT) rightAltHeld = held;
  };
  target.addEventListener("keydown", (event) => record(event, true), true);
  target.addEventListener("keyup", (event) => record(event, false), true);
  target.addEventListener("blur", () => {
    leftAltHeld = false;
    rightAltHeld = false;
  });
}

/** Test-only: reset the module-level tracker state between cases. */
export function resetAltSideTrackerForTests(): void {
  leftAltHeld = false;
  rightAltHeld = false;
  trackerInstalled = false;
}
