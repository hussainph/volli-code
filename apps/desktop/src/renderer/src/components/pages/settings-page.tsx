import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { useEffect, useState } from "react";
import {
  errorMessage,
  HARNESS_IDS,
  HARNESS_LABELS,
  type GhosttyTerminalPrefs,
} from "@volli/shared";

import {
  SettingsRow,
  SettingsSection,
  SettingsShell,
  type SettingsCategory,
} from "@renderer/components/pages/settings-shell";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { toastError } from "@renderer/lib/toast";

/**
 * App-wide preferences (the sidebar-footer gear overlay). Project-scoped
 * automation lives in the separate per-project Configure nav tab
 * (components/pages/configure-page.tsx); everything here applies across every
 * project. Grouped into categories via the shared {@link SettingsShell}.
 */
export function SettingsPage() {
  const categories: readonly SettingsCategory[] = [
    {
      key: "general",
      label: "General",
      icon: GearSixIcon,
      description: "Preferences that apply across every project.",
      content: <GeneralSettings />,
    },
    {
      key: "appearance",
      label: "Appearance",
      icon: PaletteIcon,
      description: "Terminal appearance, driven by your external Ghostty configuration.",
      content: <AppearanceSettings />,
    },
    {
      key: "harness",
      label: "Harness Runtimes",
      icon: CpuIcon,
      description: "CLI agent runtimes that boot a ticket's coding agent.",
      content: <HarnessRuntimesSettings />,
    },
  ];

  return <SettingsShell title="Settings" categories={categories} />;
}

/** General category: app-wide retention (Done-ticket archiving). */
function GeneralSettings() {
  return (
    <SettingsSection title="Retention" description="Applies to tickets in every project.">
      <DoneTtlField />
    </SettingsSection>
  );
}

/**
 * The global Done-TTL: whole days ≥ 1, or `null` when the input is blank/invalid
 * (the field toasts and skips the write). Main clamps to ≥ 1 too — this is the
 * front-line guard so an obviously-bad value never round-trips. Pure/exported
 * for unit testing (the round-trip's only branching logic).
 */
export function parseTtlDaysInput(raw: string): number | null {
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
}

/**
 * Global Done-TTL setting (issue #76, CONCEPT #16): a PR-less ticket sitting in
 * Done this many days is offered for archive & clean. App-wide (stored in
 * `app_state`, not per project), so it applies to every project regardless of
 * the current selection. Loads once via `getTtlDays`; saves via `setTtlDays`
 * and reflects the clamped stored value main returns.
 */
function DoneTtlField() {
  const [days, setDays] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.api.retention
      .getTtlDays()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setDays(String(result.days));
        else toastError(`Could not load the Done TTL: ${result.error}`);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        toastError(`Could not load the Done TTL: ${errorMessage(error)}`);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(): Promise<void> {
    if (saving) return;
    const parsed = parseTtlDaysInput(days);
    if (parsed === null) {
      toastError("The Done TTL must be a whole number of days, at least 1.");
      return;
    }
    setSaving(true);
    try {
      const result = await window.api.retention.setTtlDays(parsed);
      if (!result.ok) {
        toastError(`Could not save the Done TTL: ${result.error}`);
        return;
      }
      // Reflect the clamped, stored value main returns.
      setDays(String(result.days));
    } catch (error) {
      toastError(`Could not save the Done TTL: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsRow
      label="Archive Done tickets after"
      htmlFor="done-ttl-days"
      description="A ticket left in Done this many days with no open PR is offered for archive & clean, in every project. Defaults to 14 days."
    >
      <Input
        id="done-ttl-days"
        type="number"
        min={1}
        value={days}
        placeholder="14"
        disabled={!loaded || saving}
        onChange={(event) => setDays(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void save();
        }}
        className="w-24"
      />
      <span className="text-sm text-muted-foreground">days</span>
      <Button disabled={!loaded || saving} onClick={() => void save()}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </SettingsRow>
  );
}

type AppearanceState =
  | { status: "loading" }
  | { status: "ready"; prefs: GhosttyTerminalPrefs; hasConfig: boolean }
  | { status: "error"; error: string };

const APPEARANCE_EXPLAINER =
  "Terminal appearance is read from your external Ghostty config file (CONCEPT decision #27) — edit it there and Volli picks up the change live. These values are read-only here.";

/**
 * Appearance category: a read-only view of the terminal appearance Volli
 * resolves from the user's Ghostty config (decision #27 — the external config
 * is the single source of truth, there is no in-app editor). Best-effort: a
 * missing or unreadable config is normal (Ghostty need not be installed), so it
 * falls back to an explanatory panel rather than surfacing a failed-mutation
 * toast — nothing here writes.
 */
function AppearanceSettings() {
  const [state, setState] = useState<AppearanceState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void window.api.terminal
      .ghosttyConfig()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setState({
            status: "ready",
            prefs: result.value.prefs,
            hasConfig: result.value.configText !== null,
          });
        } else {
          setState({ status: "error", error: result.error });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ status: "error", error: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "error") {
    return (
      <SettingsSection
        title="Terminal appearance"
        icon={PaletteIcon}
        description={APPEARANCE_EXPLAINER}
      >
        <p className="text-xs leading-5 text-muted-foreground">
          Could not read your Ghostty config ({state.error}). Volli falls back to its built-in
          terminal appearance.
        </p>
      </SettingsSection>
    );
  }

  if (state.status === "loading") {
    return (
      <SettingsSection
        title="Terminal appearance"
        icon={PaletteIcon}
        description={APPEARANCE_EXPLAINER}
      >
        <p className="text-xs text-muted-foreground">Reading Ghostty config…</p>
      </SettingsSection>
    );
  }

  const { prefs, hasConfig } = state;
  return (
    <SettingsSection
      title="Terminal appearance"
      icon={PaletteIcon}
      description={APPEARANCE_EXPLAINER}
    >
      {!hasConfig ? (
        <p className="mb-1 text-xs leading-5 text-muted-foreground">
          No Ghostty config file found — Volli uses its built-in terminal defaults.
        </p>
      ) : null}
      <AppearanceValueRow label="Theme" value={prefs.themeName} />
      <AppearanceValueRow label="Font family" value={prefs.fontFamilies[0] ?? null} />
      <AppearanceValueRow
        label="Font size"
        value={prefs.fontSize !== null ? `${prefs.fontSize} pt` : null}
      />
    </SettingsSection>
  );
}

/** One read-only Ghostty appearance value; falls back to the built-in default when unset. */
function AppearanceValueRow({ label, value }: { label: string; value: string | null }) {
  return (
    <SettingsRow label={label}>
      {value !== null ? (
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
          {value}
        </code>
      ) : (
        <span className="text-xs text-muted-foreground">Built-in default</span>
      )}
    </SettingsRow>
  );
}

/**
 * Harness Runtimes category — scaffold (CONCEPT: agent-agnostic command
 * templates). Lists the first-class harness ids read-only from the same
 * `@volli/shared` catalog the new-ticket composer sources; per-runtime
 * management (custom command templates, resume flags) lands later.
 */
function HarnessRuntimesSettings() {
  return (
    <SettingsSection
      title="CLI agent runtimes"
      icon={CpuIcon}
      description="Manage CLI agent runtimes (Claude Code · Codex · Opencode · custom) — coming soon."
    >
      {HARNESS_IDS.map((id) => (
        <SettingsRow key={id} label={HARNESS_LABELS[id]}>
          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            Built-in
          </span>
        </SettingsRow>
      ))}
    </SettingsSection>
  );
}
