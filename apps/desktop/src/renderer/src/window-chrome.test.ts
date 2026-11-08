import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

/**
 * The window chrome is ONE surface: the canvas painted on `<html>`. The title
 * bar, the project rail and the gutters around the floating sidebar and content
 * card all show it, so none of them may paint a fill of its own. A fill on the
 * chrome's elements alone (the title bar and the rail both wear
 * `.app-region-drag`) stops at their boxes and leaves the gutters, the rail's
 * inset and the window's bottom edge as strips of a different colour.
 */
const styles = readFileSync(resolve(import.meta.dirname, "globals.css"), "utf8");

interface Rule {
  readonly selector: string;
  readonly body: string;
}

/** Every block in the sheet, nested ones included, with only its own declarations. */
function rules(css: string): Rule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: Rule[] = [];
  const open: { selector: string; body: string }[] = [];
  let buffer = "";
  for (const char of source) {
    if (char === "{") {
      open.push({ selector: buffer.trim(), body: "" });
      buffer = "";
    } else if (char === "}") {
      const rule = open.pop();
      if (rule !== undefined) found.push({ selector: rule.selector, body: rule.body + buffer });
      buffer = "";
    } else if (char === ";") {
      const rule = open.at(-1);
      if (rule !== undefined) rule.body += `${buffer};`;
      buffer = "";
    } else {
      buffer += char;
    }
  }
  return found;
}

const PAINT = /(?:^|;)\s*background(?:-color|-image)?\s*:/;

describe("window chrome", () => {
  it("leaves the title bar and the rail unpainted, in every material fallback too", () => {
    const chromeRules = rules(styles).filter(({ selector }) =>
      /\.app-region-drag(?![\w-])/.test(selector),
    );

    expect(chromeRules.length).toBeGreaterThan(0);
    for (const { selector, body } of chromeRules) {
      expect({ selector, paints: PAINT.test(body) }).toEqual({ selector, paints: false });
    }
  });

  it("paints the canvas once, on html, under the whole window", () => {
    const html = rules(styles).find(({ selector }) => selector === "html");

    expect(html?.body).toMatch(/background:\s*var\(--canvas\)/);
  });
});
