import { describe, expect, it } from "vite-plus/test";

import { getHarnessAdapter } from "./core";
import { cursorHookEntry, mergeCursorHooks, renderCursorHooks } from "./cursor-hooks";
import { buildLaunchConfig } from "./launch";
import type { HarnessId } from "../ticket";

/**
 * `cursor-agent`'s own validator, transcribed from the installed bundle
 * (`~/.local/share/cursor-agent/versions/<v>/index.js`, module
 * `../hooks/dist/index.js` — the `validateHooksConfig`/`validateHookScript`
 * pair). A test that asserts our JSON against OUR idea of the schema proves
 * nothing; this asserts it against THEIRS, so the day a rendered field drifts
 * out of what cursor accepts, the failure is here and not in a silent session
 * that reports nothing.
 *
 * The one behaviour worth spelling out: a single unknown EVENT key rejects the
 * whole document, so every native name Volli writes has to be real.
 */
const CURSOR_EVENT_NAMES = new Set([
  "beforeShellExecution",
  "beforeMCPExecution",
  "afterShellExecution",
  "afterMCPExecution",
  "beforeReadFile",
  "afterFileEdit",
  "beforeTabFileRead",
  "afterTabFileEdit",
  "stop",
  "beforeSubmitPrompt",
  "afterAgentResponse",
  "afterAgentThought",
  "sessionStart",
  "sessionEnd",
  "preCompact",
  "subagentStart",
  "subagentStop",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "workspaceOpen",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAsCursorWould(document: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(document)) return ["Hooks config must be an object"];
  const version = document["version"];
  if (typeof version !== "number") errors.push("Config version must be a number");
  else if (!Number.isInteger(version) || version < 1) {
    errors.push("Config version must be a positive integer");
  }
  const hooks = document["hooks"];
  if (!isObject(hooks)) return [...errors, "Config hooks must be an object"];

  for (const [event, entries] of Object.entries(hooks)) {
    if (!CURSOR_EVENT_NAMES.has(event)) {
      errors.push(`Unknown hook type: ${event}`);
      continue;
    }
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) {
      errors.push(`${event} must be an array of hook scripts`);
      continue;
    }
    for (const [index, entry] of entries.entries()) {
      const where = `${event}[${index}]`;
      if (!isObject(entry)) {
        errors.push(`${where}: hook script must be an object`);
        continue;
      }
      const type = entry["type"];
      if (type === "prompt") {
        if (typeof entry["prompt"] !== "string" || entry["prompt"].trim() === "") {
          errors.push(`${where}: prompt hook must have a non-empty 'prompt'`);
        }
      } else if (type === "command" || type === undefined) {
        if (typeof entry["command"] !== "string") {
          errors.push(`${where}: hook script command must be a string`);
        }
      } else {
        errors.push(`${where}: invalid hook type "${String(type)}"`);
      }
      const matcher = entry["matcher"];
      if (matcher !== undefined && typeof matcher !== "string") {
        errors.push(`${where}: matcher must be a string if provided`);
      }
      const timeout = entry["timeout"];
      if (timeout !== undefined) {
        if (typeof timeout !== "number")
          errors.push(`${where}: timeout must be a number (seconds)`);
        else if (timeout <= 0) errors.push(`${where}: timeout must be positive`);
      }
      const loopLimit = entry["loop_limit"];
      if (loopLimit !== undefined && loopLimit !== null) {
        if (typeof loopLimit !== "number") errors.push(`${where}: loop_limit must be an integer`);
        else if (!Number.isInteger(loopLimit) || loopLimit <= 0) {
          errors.push(`${where}: loop_limit must be a positive integer or null`);
        }
      }
      const failClosed = entry["failClosed"];
      if (failClosed !== undefined && typeof failClosed !== "boolean") {
        errors.push(`${where}: failClosed must be a boolean`);
      }
    }
  }
  return errors;
}

const cursorAdapter = getHarnessAdapter("cursor" as HarnessId)!;

function renderedCursorFile(): { version: number; hooks: Record<string, unknown[]> } {
  const config = buildLaunchConfig(cursorAdapter, {
    socketPath: "/tmp/volli.sock",
    hookArgv: ["/vol/Application Support/Volli Code/bin/volli", "hook", "cursor"],
  });
  return JSON.parse(config.workspaceFiles[0]!.content) as {
    version: number;
    hooks: Record<string, unknown[]>;
  };
}

describe("the rendered cursor hooks file", () => {
  it("passes cursor's own validator", () => {
    expect(validateAsCursorWould(renderedCursorFile())).toEqual([]);
  });

  it("names only events cursor-agent actually has", () => {
    for (const event of Object.keys(renderedCursorFile().hooks)) {
      expect(CURSOR_EVENT_NAMES.has(event)).toBe(true);
    }
  });

  it("declares loop_limit null, because an absent one means five on stop", () => {
    // `shouldSkipHookDueToLoopLimit` treats `undefined` as 5, not as "no
    // limit" — an observer that stops observing after five turns is exactly
    // the kind of silent decay this whole file exists to prevent.
    const stop = renderedCursorFile().hooks["stop"]?.[0] as { loop_limit: unknown };
    expect(stop.loop_limit).toBeNull();
  });

  it("is rejected by that validator when an event name is invented", () => {
    const bogus = renderCursorHooks({ inputNeeded: [cursorHookEntry("noop", 5000)] });
    expect(validateAsCursorWould(JSON.parse(bogus))).toEqual(["Unknown hook type: inputNeeded"]);
  });

  it("never rounds a sub-second timeout down to zero, which cursor refuses", () => {
    expect(cursorHookEntry("noop", 1).timeout).toBe(1);
    expect(cursorHookEntry("noop", 5000).timeout).toBe(5);
    expect(cursorHookEntry("noop", 5001).timeout).toBe(6);
  });
});

describe("mergeCursorHooks", () => {
  const ours = renderCursorHooks({ stop: [cursorHookEntry("volli-hook", 5000)] });

  it("writes ours outright when nothing is there", () => {
    expect(mergeCursorHooks(null, ours)).toEqual({ ok: true, content: ours });
    expect(mergeCursorHooks("   \n", ours)).toEqual({ ok: true, content: ours });
  });

  it("keeps every hook the user wrote, and their other top-level keys", () => {
    const theirs = JSON.stringify({
      version: 1,
      stop_hook_loop_limit: 3,
      hooks: {
        stop: [{ command: "make lint" }],
        beforeShellExecution: [{ command: "guard.sh", matcher: "rm .*" }],
      },
    });
    const merged = mergeCursorHooks(theirs, ours);
    expect(merged.ok).toBe(true);
    const document = JSON.parse((merged as { content: string }).content) as {
      stop_hook_loop_limit: number;
      hooks: Record<string, { command: string }[]>;
    };
    expect(document.stop_hook_loop_limit).toBe(3);
    expect(document.hooks["beforeShellExecution"]?.[0]?.command).toBe("guard.sh");
    // Theirs first, ours appended — and both survive.
    expect(document.hooks["stop"]?.map((entry) => entry.command)).toEqual([
      "make lint",
      "volli-hook",
    ]);
    expect(validateAsCursorWould(document)).toEqual([]);
  });

  it("replaces its own previous entry instead of stacking one per boot", () => {
    // The socket path moves between app launches, so the command string is not
    // stable; only the marker key is. Merging twice must not leave two.
    const first = mergeCursorHooks(null, ours) as { content: string };
    const stale = renderCursorHooks({ stop: [cursorHookEntry("volli-hook-old-socket", 5000)] });
    const second = mergeCursorHooks(first.content, stale) as { content: string };
    const third = mergeCursorHooks(second.content, ours) as { content: string };
    const hooks = (JSON.parse(third.content) as { hooks: Record<string, { command: string }[]> })
      .hooks;
    expect(hooks["stop"]?.map((entry) => entry.command)).toEqual(["volli-hook"]);
  });

  it("leaves an event the user bound and Volli does not exactly as it was", () => {
    const theirs = JSON.stringify({ version: 2, hooks: { afterFileEdit: [{ command: "fmt" }] } });
    const merged = mergeCursorHooks(theirs, ours) as { content: string };
    const document = JSON.parse(merged.content) as {
      version: number;
      hooks: Record<string, { command: string }[]>;
    };
    expect(document.hooks["afterFileEdit"]).toEqual([{ command: "fmt" }]);
    expect(document.version).toBe(1);
  });

  it("refuses a file it cannot parse rather than replacing it", () => {
    // Cursor strips comments before parsing; JSON.parse does not. A commented
    // file is a WORKING cursor config, so rewriting it would delete hooks that
    // currently run.
    expect(mergeCursorHooks('{\n // mine\n "version": 1, "hooks": {} }', ours)).toEqual({
      ok: false,
      reason: "existing .cursor/hooks.json is not valid JSON",
    });
    expect(mergeCursorHooks("[]", ours)).toEqual({
      ok: false,
      reason: "existing .cursor/hooks.json is not an object",
    });
    expect(mergeCursorHooks('{"version":1}', ours)).toEqual({
      ok: false,
      reason: "existing .cursor/hooks.json has no hooks object",
    });
  });

  it("leaves a non-array event value alone rather than guessing at it", () => {
    const theirs = JSON.stringify({ version: 1, hooks: { stop: "nonsense" } });
    const merged = mergeCursorHooks(theirs, ours) as { content: string };
    const hooks = (JSON.parse(merged.content) as { hooks: Record<string, unknown> }).hooks;
    // Ours still lands; theirs is not silently reshaped into an array.
    expect(hooks["stop"]).toEqual([{ ...JSON.parse(ours).hooks.stop[0] }]);
  });
});
