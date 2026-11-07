// @vitest-environment jsdom
/**
 * Outline and secondary Buttons on floating writing glass, rendered through the
 * real overlay primitives. Each scoped rule is found by the token it paints and
 * matched against the DOM the primitives actually produce; contrast composites
 * the emitted tokens in paint order: press OVER face OVER the float's writing
 * veil OVER its filtered backdrop (and, for modal floats, the scrim beneath).
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_CANVAS, compositeHex, regularGlassBackdrop, wcagContrast } from "@volli/shared";
import { Button } from "@renderer/components/ui/button";
import { PaperSurface } from "@renderer/components/ui/surface";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { Dialog, DialogContent, DialogTitle } from "@renderer/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { deriveCanvasPaint, type CanvasTokenName } from "./canvas-paint";

const css = readFileSync(resolve(import.meta.dirname, "../globals.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const ruleFor = (body: RegExp) => {
  const found = new RegExp(`([^{}]+)\\{\\s*${body.source};?\\s*\\}`).exec(css);
  expect(found).not.toBeNull();
  return { selector: found![1].trim(), body: found![0], index: found!.index };
};
const writingRest = ruleFor(/background-color:\s*var\((--writing-control-face)\)/);
const writingPress = ruleFor(
  /background-image:\s*linear-gradient\(var\((--writing-control-pressed)\),\s*var\(--writing-control-pressed\)\)/,
);
const restingSelector =
  '[data-control="button"]:is([data-variant="outline"], [data-variant="secondary"])';
const sharedPressSelector = '[data-control="button"].control-material:active:not(:disabled)';
const active = (selector: string) => selector.replaceAll(":active", '[data-test-active="true"]');
const faceToken = /var\((--[\w-]+)\)/.exec(writingRest.body)![1] as CanvasTokenName;
const pressToken = /var\((--[\w-]+)\)/.exec(writingPress.body)![1] as CanvasTokenName;

function emittedOver(fill: string, backdrop: string): string {
  if (fill.startsWith("#")) return fill;
  const rgba = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(fill);
  expect(rgba).not.toBeNull();
  const hex = `#${rgba!
    .slice(1, 4)
    .map((value) => Number(value).toString(16).padStart(2, "0"))
    .join("")}`;
  return compositeHex(hex, Number(rgba![4]), backdrop);
}

const source = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");
const block = (text: string, label: string, open: string, close: string) => {
  const at = text.indexOf(label);
  expect(at).toBeGreaterThanOrEqual(0);
  const start = text.lastIndexOf(open, at);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(text.slice(start, at)).not.toContain(close);
  return text.slice(start, text.indexOf(close, at));
};

let root: Root;
let host: HTMLDivElement;
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  if (originalScroll)
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
  else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.unstubAllGlobals();
});

/** Every Button the overlay rendered, by its accessible text. */
async function rendered(ui: React.ReactNode): Promise<Map<string, HTMLElement>> {
  await act(async () => root.render(ui));
  const buttons = new Map<string, HTMLElement>();
  for (const button of document.querySelectorAll<HTMLElement>('[data-control="button"]'))
    buttons.set(button.textContent!.trim(), button);
  return buttons;
}

function expectWriting(button: HTMLElement | undefined, writing: boolean) {
  expect(button).toBeDefined();
  expect(button!.matches(writingRest.selector)).toBe(writing);
  button!.setAttribute("data-test-active", "true");
  expect(button!.matches(active(writingPress.selector))).toBe(
    writing && !button!.matches(":disabled"),
  );
}

describe("floating writing-glass outline and secondary controls", () => {
  it("binds the production callers to outline Buttons on floating writing glass", () => {
    const retry = block(
      source("../components/sidebar/update-button.tsx"),
      "Retry update check",
      "<PopoverContent",
      "</PopoverContent>",
    );
    expect(retry).toContain('variant="outline"');
    // Retry sits in an error Notice: its backing is that notice's tint.
    expect(retry).toContain('tone="error"');
    expect(source("../components/ui/notice.tsx")).toContain(
      'error: "border-destructive/30 bg-destructive/10 text-destructive"',
    );
    expect(
      block(
        source("../components/rail/cloud-rail.tsx"),
        "Sign out to open them",
        "<PopoverContent",
        "</PopoverContent>",
      ),
    ).toContain('variant="outline"');
    // Every confirmation's Cancel is an outline Button by default.
    expect(
      block(
        source("../components/ui/alert-dialog.tsx"),
        "function AlertDialogCancel",
        "function",
        "}: React",
      ),
    ).toContain('variant = "outline"');
  });

  it("paints the writing pair unlayered, after the shared face and press", () => {
    const depth = (index: number) => {
      let level = 0;
      for (let i = 0; i < index; i++) {
        if (css[i] === "{") level++;
        else if (css[i] === "}") level--;
      }
      return level;
    };
    for (const rule of [writingRest, writingPress]) {
      expect(depth(rule.index)).toBe(0);
      expect(rule.index).toBeGreaterThan(css.indexOf(`${restingSelector} {`));
      expect(rule.index).toBeGreaterThan(css.indexOf(`${sharedPressSelector} {`));
      expect(rule.selector).not.toContain(":hover");
    }
    expect(faceToken).toBe("--writing-control-face");
    expect(pressToken).toBe("--writing-control-pressed");
  });

  it("reaches outline/secondary on untinted popovers only, never paper, tint or other variants", async () => {
    const buttons = await rendered(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>
          <Button variant="outline">Outline</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline" disabled>
            Disabled
          </Button>
          <Button variant="inspector">Inspector</Button>
          <Button variant="toolbar">Toolbar</Button>
          <PaperSurface>
            <Button variant="outline">On paper</Button>
          </PaperSurface>
        </PopoverContent>
      </Popover>,
    );
    const popover = document.querySelector('[data-slot="popover-content"]')!;
    expect(popover.classList.contains("material-floating")).toBe(true);
    expect(popover.getAttribute("data-tint")).not.toBe("true");
    expectWriting(buttons.get("Outline"), true);
    expectWriting(buttons.get("Secondary"), true);
    expectWriting(buttons.get("Disabled"), true);
    for (const name of ["Inspector", "Toolbar", "On paper"])
      expectWriting(buttons.get(name), false);
  });

  // DOM-nested materials inside a real popover: the nearest material decides.
  it("keeps the shared face wherever the nearest material is not floating writing glass", async () => {
    const buttons = await rendered(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>
          <Button variant="outline">Direct</Button>
          <div className="material-floating" data-tint="true">
            <Button variant="outline">Tinted inside untinted</Button>
          </div>
          <div className="material-floating">
            <Button variant="outline">Untinted inside untinted</Button>
          </div>
          <div className="material-floating" data-tint="true">
            <div className="material-floating">
              <Button variant="outline">Untinted inside tinted</Button>
            </div>
          </div>
          <div className="material-solid">
            <Button variant="secondary">Solid</Button>
          </div>
          <div className="material-thick">
            <Button variant="secondary">Thick</Button>
          </div>
          <div data-volli-surface="">
            <Button variant="outline">Surface</Button>
          </div>
        </PopoverContent>
      </Popover>,
    );
    expectWriting(buttons.get("Direct"), true);
    for (const name of [
      "Tinted inside untinted",
      "Untinted inside untinted",
      "Untinted inside tinted",
      "Solid",
      "Thick",
      "Surface",
    ])
      expectWriting(buttons.get(name), false);
  });

  it("leaves a canvas-sampling (tint) popover on the shared face", async () => {
    const buttons = await rendered(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent tint>
          <Button variant="outline">Outline</Button>
        </PopoverContent>
      </Popover>,
    );
    expect(document.querySelector('[data-slot="popover-content"]')!.getAttribute("data-tint")).toBe(
      "true",
    );
    expectWriting(buttons.get("Outline"), false);
  });

  it("reaches floating dialogs and confirmations, not a material=none dialog", async () => {
    let buttons = await rendered(
      <Dialog open>
        <DialogContent aria-describedby={undefined} showCloseButton={false}>
          <DialogTitle>Details</DialogTitle>
          <Button variant="outline">Dialog outline</Button>
        </DialogContent>
      </Dialog>,
    );
    const dialog = document.querySelector('[data-slot="dialog-content"]')!;
    expect(dialog.classList.contains("material-floating")).toBe(true);
    expectWriting(buttons.get("Dialog outline"), true);
    // The scrim is a sibling painted first in the same layer, so the dialog's
    // backdrop filter samples the page under the scrim.
    const scrim = document.querySelector('[data-slot="dialog-overlay"]')!;
    expect(scrim.classList.contains("bg-scrim")).toBe(true);
    expect(scrim.parentElement).toBe(dialog.parentElement);
    expect(scrim.compareDocumentPosition(dialog) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    buttons = await rendered(
      <Dialog open>
        <DialogContent aria-describedby={undefined} showCloseButton={false} material="none">
          <DialogTitle>Plain</DialogTitle>
          <Button variant="outline">Plain outline</Button>
        </DialogContent>
      </Dialog>,
    );
    expect(
      document
        .querySelector('[data-slot="dialog-content"]')!
        .classList.contains("material-floating"),
    ).toBe(false);
    expectWriting(buttons.get("Plain outline"), false);

    buttons = await rendered(
      <AlertDialog open>
        <AlertDialogContent aria-describedby={undefined}>
          <AlertDialogTitle>Confirm</AlertDialogTitle>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction>Continue</AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>,
    );
    expectWriting(buttons.get("Cancel"), true);
    expectWriting(buttons.get("Continue"), false);
    const alert = document.querySelector('[data-slot="alert-dialog-content"]')!;
    const alertScrim = document.querySelector('[data-slot="alert-dialog-overlay"]')!;
    expect(alertScrim.classList.contains("bg-scrim")).toBe(true);
    expect(alertScrim.parentElement).toBe(alert.parentElement);
    expect(
      alertScrim.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps body ink at AA on resting and pressed faces over every floating backing", () => {
    const corners = [
      "#000000",
      "#ffffff",
      "#ff0000",
      "#00ff00",
      "#0000ff",
      "#ffff00",
      "#00ffff",
      "#ff00ff",
    ];
    for (const mode of ["light", "dark"] as const) {
      for (const seed of [
        "#e8652a",
        "#18b6a4",
        "#4653a2",
        "#a020f0",
        "#00ff00",
        "#80817f",
        "#ffffff",
        "#000000",
      ]) {
        for (const vibrancy of [0, 0.6, 1]) {
          const canvas = { ...DEFAULT_CANVAS, vibrancy, stops: [{ hex: seed, x: 0.5, y: 0.5 }] };
          const { tokens: t, canvasTokens: c } = deriveCanvasPaint(canvas, mode);
          for (const corner of corners) {
            // A popover samples the page; a modal float samples the page under
            // its scrim, which paints first in the same overlay layer.
            const popover = emittedOver(c["--glass-veil"], regularGlassBackdrop(corner, mode));
            const modal = emittedOver(
              c["--glass-veil"],
              regularGlassBackdrop(emittedOver(c["--scrim"], corner), mode),
            );
            for (const [caller, backing] of [
              ["sign-out", popover],
              ["retry-in-error-notice", compositeHex(t["--destructive"], 0.1, popover)],
              ["dialog-or-confirmation", modal],
            ] as const) {
              const rest = emittedOver(c[faceToken], backing);
              for (const [state, face] of [
                ["rest", rest],
                ["pressed", emittedOver(c[pressToken], rest)],
              ] as const) {
                expect(
                  wcagContrast(t["--foreground"], face),
                  `${mode}/${seed}/v${vibrancy}/corner${corner}/${caller}/${state}/face${face}/ink${t["--foreground"]}`,
                ).toBeGreaterThanOrEqual(4.5);
              }
            }
          }
        }
      }
    }
  });
});
