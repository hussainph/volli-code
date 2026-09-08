/**
 * The small, allowlisted catalogue behind Files' “Open in…” menu. Bundle ids
 * stay in main: the renderer receives only a stable id, label, and category,
 * never a user-machine application path.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExternalApp, ExternalAppId, Result } from "../ipc/contract";
import { errorMessage } from "@volli/shared";

export type { ExternalApp, ExternalAppId, ExternalAppKind } from "../ipc/contract";

const execFileAsync = promisify(execFile);

interface ExternalAppDefinition extends ExternalApp {
  bundleId: string;
}

const EXTERNAL_APPS: readonly ExternalAppDefinition[] = [
  { id: "vscode", label: "VS Code", kind: "editor", bundleId: "com.microsoft.VSCode" },
  { id: "cursor", label: "Cursor", kind: "editor", bundleId: "com.todesktop.230313mzl4w4u92" },
  { id: "zed", label: "Zed", kind: "editor", bundleId: "dev.zed.Zed" },
  { id: "xcode", label: "Xcode", kind: "editor", bundleId: "com.apple.dt.Xcode" },
  {
    id: "android-studio",
    label: "Android Studio",
    kind: "editor",
    bundleId: "com.google.android.studio",
  },
  { id: "terminal", label: "Terminal", kind: "terminal", bundleId: "com.apple.Terminal" },
  { id: "iterm2", label: "iTerm2", kind: "terminal", bundleId: "com.googlecode.iterm2" },
  { id: "ghostty", label: "Ghostty", kind: "terminal", bundleId: "com.mitchellh.ghostty" },
  { id: "warp", label: "Warp", kind: "terminal", bundleId: "dev.warp.Warp-Stable" },
];

export function isExternalAppId(value: unknown): value is ExternalAppId {
  return typeof value === "string" && EXTERNAL_APPS.some((app) => app.id === value);
}

export interface ExternalAppRuntime {
  platform: string;
  findBundle(bundleId: string): Promise<boolean>;
  openBundle(bundleId: string, path: string): Promise<void>;
}

export type NativeAppCommand = (
  command: string,
  args: readonly string[],
) => Promise<{ stdout: string }>;

/**
 * macOS Launch Services is the bundle-id authority: it finds apps wherever the
 * user installed them, unlike a hand-maintained scan of /Applications. The id
 * is JSON-encoded before it enters JXA; production calls only pass catalogue
 * values, but this keeps the native-script boundary closed as well.
 *
 * The path leaves as the program's COMPLETION VALUE, never through
 * `console.log`: under `osascript -l JavaScript`, `console.log` writes to
 * stderr, so the version that used it put every app path on the stream this
 * runtime does not read and reported every Mac as having no supported apps
 * (VC-287). stderr stays free for real diagnostics.
 *
 * `typeof path === "string"` is the absent case, and it is not defensive
 * padding: a nil `NSURL` comes back as a TRUTHY JXA object whose `.path`
 * unwraps to `undefined`, so an `if (url)` test alone answers "installed" for
 * every bundle id on earth.
 */
function launchServicesLookupScript(bundleId: string): string {
  return [
    "ObjC['import']('AppKit');",
    `const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(${JSON.stringify(bundleId)});`,
    "const path = url ? ObjC.unwrap(url.path) : null;",
    "typeof path === 'string' ? path : '';",
  ].join("\n");
}

/** The macOS command adapter, injected in tests and bound to real executables at app startup. */
export function createMacOSExternalAppRuntime(run: NativeAppCommand): ExternalAppRuntime {
  return {
    platform: "darwin",
    async findBundle(bundleId: string): Promise<boolean> {
      const { stdout } = await run("/usr/bin/osascript", [
        "-l",
        "JavaScript",
        "-e",
        launchServicesLookupScript(bundleId),
      ]);
      return stdout.trim().length > 0;
    },
    async openBundle(bundleId: string, path: string): Promise<void> {
      await run("/usr/bin/open", ["-b", bundleId, path]);
    },
  };
}

export type ExternalAppOpenResult = Result;

/**
 * What a scan that could not run says. It is deliberately a claim about the
 * INSPECTION, not about the Mac: "no supported apps" is a finding, and a
 * lookup that failed has no findings. The renderer shows this beside its one
 * Try again; the underlying osascript failure (a full command line with the
 * script inlined) rides along as `cause` for the log, not onto the surface.
 */
export const EXTERNAL_APP_DISCOVERY_FAILED = "Couldn't check which apps are installed on this Mac.";

export interface ExternalAppGateway {
  list(): Promise<ExternalApp[]>;
  open(appId: ExternalAppId, path: string): Promise<ExternalAppOpenResult>;
}

/**
 * Builds the one native-app seam Files needs. A non-macOS host has no Finder
 * menu contract, so it truthfully reports no matching external apps.
 */
export function createExternalAppGateway(finder: ExternalAppRuntime): ExternalAppGateway {
  return {
    /**
     * Every allowlisted bundle, or nothing. A per-app lookup that could not run
     * used to become `null` — indistinguishable from "not installed" — so one
     * broken Launch Services call quietly shortened the menu and a wholly
     * broken one produced a confident empty list. The whole scan now fails
     * instead, and `volli:external-app-list` turns that into `{ ok: false }`
     * through the shared IPC envelope.
     */
    async list(): Promise<ExternalApp[]> {
      if (finder.platform !== "darwin") return [];
      const inspected = await Promise.all(
        EXTERNAL_APPS.map(async ({ bundleId, ...app }) => {
          try {
            return { app, installed: await finder.findBundle(bundleId), failure: null };
          } catch (error: unknown) {
            return { app, installed: false, failure: error };
          }
        }),
      );
      // Every bundle is inspected before the verdict, so the log names every
      // failed lookup rather than only whichever one lost the race.
      const failures = inspected.filter((entry) => entry.failure !== null);
      if (failures.length > 0) {
        console.error(
          `[volli] external-app lookup failed for ${failures.map((entry) => entry.app.id).join(", ")}:`,
          errorMessage(failures[0]?.failure),
        );
        throw new Error(EXTERNAL_APP_DISCOVERY_FAILED, { cause: failures[0]?.failure });
      }
      return inspected.filter((entry) => entry.installed).map((entry) => entry.app);
    },

    async open(appId: ExternalAppId, path: string): Promise<ExternalAppOpenResult> {
      const app = EXTERNAL_APPS.find((candidate) => candidate.id === appId);
      if (app === undefined) return { ok: false, error: "Unknown external app" };
      if (finder.platform !== "darwin") {
        return { ok: false, error: "External apps are available on macOS only" };
      }
      try {
        await finder.openBundle(app.bundleId, path);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  };
}

const nativeAppCommand: NativeAppCommand = async (command, args) => {
  const { stdout } = await execFileAsync(command, [...args]);
  return { stdout: stdout.toString() };
};

function systemExternalAppRuntime(): ExternalAppRuntime {
  if (process.platform === "darwin") return createMacOSExternalAppRuntime(nativeAppCommand);
  return {
    platform: process.platform,
    async findBundle() {
      return false;
    },
    async openBundle() {
      throw new Error("External apps are available on macOS only");
    },
  };
}

/** The production gateway; tests inject a smaller gateway at the file-IPC seam. */
export const systemExternalAppGateway = createExternalAppGateway(systemExternalAppRuntime());
