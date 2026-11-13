/**
 * The first paint's inputs, kept beside the database in a file of their own
 * (VC-1203), for the one window that opens before the database may be read.
 *
 * Every launch checks the database in a worker before anything reads it. On a
 * large profile that takes seconds, and the app's window opens during it with
 * a loading state. That window is the app's own: once the check answers it
 * loads the app, keeping the light/dark mode it was built with (the preload's
 * `additionalArguments` are fixed at construction). So its look cannot wait
 * for the database, and must not be the default when the person chose another:
 * that would be a flash of the wrong appearance on every long launch.
 *
 * The database rows stay the authority (`theme-repo.ts`). This file is a cache
 * of exactly what `resolveFirstPaint` reads from them, rewritten each time the
 * workbench records its first-paint hint. It can be missing (the first launch
 * of this build, a fresh profile) or stale (an older build changed the theme
 * since): either way the window falls back to a first-ever launch's look, and
 * the app's own repaint, from the database, corrects it when it boots.
 *
 * Electron-free; the caller passes the paths.
 */
import { readFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isAppearance, isHexColor, parseCanvas } from "@volli/shared";

import type { FirstPaintInput } from "./window-theme";

/** The file's name, beside the database it mirrors. */
export const FIRST_PAINT_MIRROR_FILE_NAME = "first-paint.json";

/** The stored half of a {@link FirstPaintInput}: everything but the system's answer. */
export type FirstPaintMirror = Omit<FirstPaintInput, "systemPrefersDark">;

const EMPTY: FirstPaintMirror = { hint: null, canvas: null, appearance: null };

export function firstPaintMirrorPath(dbPath: string): string {
  return join(dirname(dbPath), FIRST_PAINT_MIRROR_FILE_NAME);
}

/**
 * What the file holds, each field read on its own: an unreadable field is
 * `null`, as an unreadable row is in `theme-repo.ts`, and a missing or broken
 * file is all `null`. Never throws: it is read before any window exists.
 */
export function readFirstPaintMirror(path: string): FirstPaintMirror {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return EMPTY;
  }
  if (typeof parsed !== "object" || parsed === null) return EMPTY;
  const { hint, canvas, appearance } = parsed as Record<string, unknown>;
  return {
    hint: parseHint(hint),
    canvas: canvas === null || canvas === undefined ? null : parseCanvas(canvas),
    appearance: isAppearance(appearance) ? appearance : null,
  };
}

function parseHint(value: unknown): FirstPaintInput["hint"] {
  if (typeof value !== "object" || value === null) return null;
  const { appearance, background } = value as Record<string, unknown>;
  if (appearance !== "light" && appearance !== "dark") return null;
  if (typeof background !== "string" || !isHexColor(background)) return null;
  return { appearance, background };
}

function serialize(mirror: FirstPaintMirror): string {
  return `${JSON.stringify({
    hint:
      mirror.hint === null
        ? null
        : { appearance: mirror.hint.appearance, background: mirror.hint.background },
    canvas: mirror.canvas,
    appearance: mirror.appearance,
  })}\n`;
}

/**
 * Keeps the file in step with what it is handed, off main's thread: the
 * workbench records its first paint on every launch and every theme change,
 * and an unchanged paint writes nothing. Each write replaces the file whole
 * (write, then rename), in the order handed, so a reader never sees half of
 * one and an older paint never lands over a newer one. A failed write is
 * reported to `onError` and the next paint tries again.
 */
export function firstPaintMirrorWriter(
  path: string,
  onError: (error: unknown) => void,
): { write(mirror: FirstPaintMirror): Promise<void> } {
  let written: Promise<string | null> = readFile(path, "utf8").catch(() => null);
  return {
    write(mirror) {
      const next = serialize(mirror);
      written = written.then(async (current) => {
        if (current === next) return current;
        try {
          const temporary = `${path}.tmp`;
          await writeFile(temporary, next);
          await rename(temporary, path);
          return next;
        } catch (error) {
          onError(error);
          return null;
        }
      });
      return written.then(() => undefined);
    },
  };
}
