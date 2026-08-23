import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { resolveSettingsCategory } from "@renderer/components/settings/settings-groups";
import { SettingsPage } from "./settings-page";

/**
 * These render under `renderToStaticMarkup`, where there is no `window` and no
 * preload bridge and effects never run — so what they assert is each pane's
 * RESTING shape: what it draws before it has been told anything. That is the
 * honest thing to pin, and it is also the state most likely to regress, since
 * it is the one nobody looks at while developing.
 */
describe("SettingsPage (app-wide)", () => {
  it("groups the rail rather than listing nine categories flat", () => {
    const html = renderToStaticMarkup(<SettingsPage />);

    // The group labels carry the relationship — see settings-groups.tsx.
    expect(html).toContain("Preferences");
    expect(html).toContain("Services");
    expect(html).toContain("System");
  });

  it("lists every app-wide category", () => {
    const html = renderToStaticMarkup(<SettingsPage />);

    for (const category of [
      "General",
      "Appearance",
      "Notifications",
      "Models",
      "Web Search",
      "Integrations",
      "Storage",
      "Updates",
      "About",
    ]) {
      expect(html).toContain(category);
    }
  });

  it("has retired the categories that had nothing to change", () => {
    const html = renderToStaticMarkup(<SettingsPage />);

    // "Harness Runtimes" was a category whose pane held one read-only command
    // string; the inventory is a section of About now, and the per-project
    // CHOICE is on Configure. "CLI" is likewise folded into About.
    expect(html).not.toContain("Harness Runtimes");
    expect(html).not.toContain("Model Access");
  });

  it("keeps the project-scoped fields off this surface", () => {
    const html = renderToStaticMarkup(<SettingsPage />);

    expect(html).not.toContain("Default base branch");
    expect(html).not.toContain("Setup command");
  });

  it("opens Storage on the retention window, with its trust-boundary line", () => {
    const html = renderToStaticMarkup(<SettingsPage initialCategoryKey="storage" />);

    expect(html).toContain("Keep Done worktrees for");
    expect(html).toContain('id="done-ttl-days"');
    // VC-113: the number governs an automatic deletion, so the row states what
    // the deletion takes and what survives it. This is the sanctioned
    // exception to the copy rule and must not become a hint.
    expect(html).toContain("keeps the branch, its commits, and the ticket");
  });

  it("opens Web Search in its loading state, offering no key it has not read", () => {
    const html = renderToStaticMarkup(<SettingsPage initialCategoryKey="web" />);

    expect(html).toContain("Web search");
    expect(html).toContain("Loading…");
    expect(html).not.toContain("API key");
  });

  it("keeps the file-opening preference visible while app detection loads", () => {
    const html = renderToStaticMarkup(<SettingsPage initialCategoryKey="integrations" />);

    // "Ask every time" is a real value, never a blank Select while the list
    // that supplies app options is still resolving.
    expect(html).toContain("Open files in");
    expect(html).toContain("Ask every time");
    expect(html).toContain('id="open-files-in"');
    expect(html).toContain("Loading…");
  });

  it("marks the opened category in the rail", () => {
    const html = renderToStaticMarkup(<SettingsPage initialCategoryKey="updates" />);

    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Current version");
  });

  it("says plainly that a designed-but-unplumbed pane does not work yet", () => {
    const html = renderToStaticMarkup(<SettingsPage initialCategoryKey="notifications" />);

    // The rule from kit/unavailable.tsx: the notice comes FIRST and in words.
    // Someone who reads one thing must read the one that stops them waiting.
    expect(html).toContain("aren&#x27;t available yet");
    expect(html).toContain("System Settings");
  });
});

describe("resolveSettingsCategory", () => {
  it("maps the retired model-access key onto Models", () => {
    // `chat-plane.tsx` deep-links here to open a provider sign-in and still
    // sends the old key. Without the alias, that link opens General and the
    // sign-in never starts.
    expect(resolveSettingsCategory("model-access")).toBe("models");
  });

  it("passes a current key through, and leaves absence absent", () => {
    expect(resolveSettingsCategory("storage")).toBe("storage");
    expect(resolveSettingsCategory(undefined)).toBeUndefined();
  });
});
