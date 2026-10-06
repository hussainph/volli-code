/**
 * index.ts's harness wiring, read from the source (VC-703).
 *
 * `keychain-guard.test.ts` proves the guard; nothing there fails if index.ts
 * stops calling it first, or grows a new keychain path that ignores the
 * harness ports. Importing index.ts is impractical (Electron, boot side
 * effects), so this pins the wiring textually: every place index.ts can reach
 * the keychain is named here, and a new one fails until it is accounted for.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const SOURCE = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

/** Top-level statements after the import block, by their first line. */
function topLevelStatements(): string[] {
  const lines = SOURCE.split("\n");
  const out: string[] = [];
  let inImport = false;
  for (const line of lines) {
    if (inImport) {
      if (line.startsWith("} from ") || /from "[^"]+";$/.test(line)) inImport = false;
      continue;
    }
    if (line.startsWith("import ")) {
      inImport = !/from "[^"]+";$/.test(line) && !/^import "[^"]+";$/.test(line);
      continue;
    }
    if (/^[A-Za-z]/.test(line)) out.push(line);
  }
  return out;
}

describe("index.ts harness wiring", () => {
  it("installs the guard as the first statement after the imports", () => {
    const [first] = topLevelStatements();
    expect(first).toBe(
      "const harnessGuard = installHarnessGuard({ env: process.env, app, safeStorage, shell });",
    );
    expect(SOURCE.match(/installHarnessGuard\(/g)).toHaveLength(1);
  });

  it("reaches safeStorage only where harness mode is accounted for", () => {
    const uses = SOURCE.split("\n")
      .map((line) => line.trim())
      .filter((line) => /\bsafeStorage\b/.test(line) && !line.startsWith("//"));
    expect(uses).toEqual([
      // The named import.
      "safeStorage,",
      // The guard itself, which traps it.
      "const harnessGuard = installHarnessGuard({ env: process.env, app, safeStorage, shell });",
      // A forwarding wrapper: reads no keychain until a codec calls it, and
      // in harness mode no codec is built over it.
      "const keychainUse = observeKeychainUse(safeStorage);",
      // The keyring fallback, behind `harnessPorts?.keyring ??`.
      "keychain: safeStorage,",
    ]);
    expect(SOURCE).toMatch(/harnessPorts\?\.keyring \?\?\s+keychainCredentialKeyring\(\{/);
  });

  it("builds every keychain codec only as the fallback to the harness port", () => {
    const codecs = SOURCE.match(/[^\n]*keychainSecretCodec\(/g) ?? [];
    expect(codecs.length).toBeGreaterThan(0);
    for (const line of codecs)
      expect(line).toMatch(/harnessPorts\?\.secretKey \?\? keychainSecretCodec\($/);
    expect(SOURCE.match(/keychainCredentialKeyring\(/g)).toHaveLength(1);
  });

  it("skips the legacy safeStorage migration in harness mode", () => {
    expect(SOURCE).toMatch(
      /if \(dbHandle\.ok && harnessPorts === null\) \{\n\s+const moved = migrateLegacySafeStorageSecrets\(/,
    );
    expect(SOURCE.match(/migrateLegacySafeStorageSecrets\(/g)).toHaveLength(1);
  });
});

describe("shell recorder coverage", () => {
  const MAIN = new URL("../", import.meta.url);
  const files = ["index.ts", "client-capabilities.ts", "ipc.ts", "data-ipc.ts"].map((name) => ({
    name,
    text: readFileSync(new URL(name, MAIN), "utf8"),
  }));

  it("every caller reaches the OS-launching shell methods through the shell object at call time", () => {
    for (const { name, text } of files) {
      // A destructured or bound method would keep the real one past the
      // recorder's install; a call through `shell.` reads the recorder.
      expect(text, name).not.toMatch(
        /\{[^}]*\b(openExternal|openPath|showItemInFolder|trashItem)\b[^}]*\}\s*=\s*shell\b/,
      );
      expect(text, name).not.toMatch(
        /shell\.(openExternal|openPath|showItemInFolder|trashItem)\.bind\(/,
      );
    }
  });

  it("window.open and external navigation in the main window go through openExternal", () => {
    const index = files[0]!.text;
    expect(index).toMatch(
      /setWindowOpenHandler\(\(\{ url \}\) => \{\n\s+openExternal\(url\);\n\s+return \{ action: "deny" \};/,
    );
    expect(index).toMatch(/event\.preventDefault\(\);\n\s+openExternal\(target\);/);
    expect(index).toMatch(/void shell\.openExternal\(target\);/);
  });
});
