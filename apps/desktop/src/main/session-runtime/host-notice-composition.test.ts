/**
 * Desktop's background-shell notices pair ordinary exact redaction with the
 * unfinished-credential preview, built through the real `BackgroundShellHost`
 * constructor over desktop's own keychain codec and `SecretService`.
 *
 * The runtime edge this file also proved — the RPC binding only from the
 * recovered proof, and desktop's quit leaving the database open — is the
 * runner composition's now, proved through its interface in host-core's
 * `session-runtime/runner.test.ts`. Exhaustive ordering of the shell notices
 * stays with `shell/background-shell-notices.test.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  BackgroundShellHost,
  type BackgroundShellNotice,
  type BackgroundShellOwner,
} from "@volli/host-core/session-runtime";
import { SecretStore, SecretService } from "@volli/host-core/secrets";
import { keychainSecretCodec } from "../secrets/codec";

const dirs: string[] = [];
const shells: BackgroundShellHost[] = [];
afterEach(async () => {
  for (const shell of shells.splice(0)) await shell.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("desktop background-shell notice redaction", () => {
  const owner: BackgroundShellOwner = {
    sessionId: "session-1",
    attachmentId: "attachment-1",
    projectId: "project-1",
    ticketId: null,
  };
  /** Desktop's secret service: its keychain codec over its sealed session store. */
  function desktopSecrets(value: string): SecretService {
    const dir = tempDir("volli-desktop-secrets-");
    const secrets = new SecretService(
      new SecretStore(
        join(dir, "session-secrets.enc"),
        keychainSecretCodec({
          // Session-scope values never need the keychain.
          isEncryptionAvailable: () => false,
          encryptString: () => {
            throw new Error("unused");
          },
          decryptString: () => {
            throw new Error("unused");
          },
        }),
      ),
    );
    secrets.store.put({ name: "TOKEN", value, scope: "session", sessionId: owner.sessionId });
    return secrets;
  }
  /** The real constructor, with desktop's deps; only the test's timing knobs differ. */
  function backgroundShells(secrets: SecretService, options: { preview: boolean }) {
    const notices: BackgroundShellNotice[] = [];
    const shellHost = new BackgroundShellHost({
      redactOutput: (text) => secrets.store.redact(text),
      ...(options.preview
        ? { redactNoticeOutput: (text: string) => secrets.store.redactPartial(text) }
        : {}),
      onNotice: (notice) => notices.push(notice),
      publishState: () => {},
      publishRemoved: () => {},
      createId: () => "sh-1",
      settleMs: 150,
      killGraceMs: 200,
      exitNoticeGraceMs: 40,
    });
    shells.push(shellHost);
    return { shellHost, notices };
  }
  /** A stored two-line credential whose first line arrives one chunk before the second. */
  async function splitCredentialRun(options: { preview: boolean }) {
    const secrets = desktopSecrets("Ready ALMOND123\nWALNUT456");
    const { shellHost, notices } = backgroundShells(secrets, options);
    await shellHost.start(owner, {
      command:
        "sleep 0.3; printf 'Ready ALMOND123\\n'; sleep 0.2; printf 'WALNUT456\\nsafe\\n'; sleep 30",
      cwd: tempDir("volli-desktop-shell-"),
      title: null,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      notifyOn: { pattern: "Ready", regex: false },
    });
    await vi.waitFor(() => expect(shellHost.tailOf("sh-1")?.output).toContain("safe"), {
      timeout: 4_000,
      interval: 20,
    });
    return { shellHost, notices };
  }

  it("pairs exact output redaction with the unfinished-credential preview", async () => {
    const { shellHost, notices } = await splitCredentialRun({ preview: true });
    // The live match never quotes the half of the credential that arrived first.
    expect(notices).toEqual([]);
    expect(shellHost.tailOf("sh-1")?.output).toContain("‹secret:TOKEN›");
    expect(shellHost.tailOf("sh-1")?.output).not.toContain("ALMOND123");
  });

  it("without the preview, exact redaction alone would quote the fragment", async () => {
    // The reason desktop wires both: this is the leak the pairing closes.
    const { notices } = await splitCredentialRun({ preview: false });
    expect(notices).toEqual([
      expect.objectContaining({ kind: "matched", line: expect.stringContaining("ALMOND123") }),
    ]);
  });
});
