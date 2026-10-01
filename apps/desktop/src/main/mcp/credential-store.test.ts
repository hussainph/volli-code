import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { FileMcpCredentialStore, MemoryMcpCredentialStore } from "./credential-store";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volli-mcp-store-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("FileMcpCredentialStore", () => {
  it("writes one user-only file and reads it back after a relaunch", () => {
    const path = join(dir, "mcp-credentials.json");
    const store = new FileMcpCredentialStore(path);
    store.update("server-1", () => ({ secrets: { "header:authorization": "value-1" } }));

    expect(statSync(path).mode & 0o777).toBe(0o600);
    const relaunched = new FileMcpCredentialStore(path);
    expect(relaunched.read("server-1")).toEqual({ secrets: { "header:authorization": "value-1" } });
    expect(relaunched.path).toBe(path);
  });

  it("narrows a file someone widened back to user-only on read", () => {
    const path = join(dir, "mcp-credentials.json");
    writeFileSync(path, JSON.stringify({ version: 1, servers: {} }));
    chmodSync(path, 0o644);

    expect(new FileMcpCredentialStore(path).read("anything")).toBeUndefined();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("moves an unreadable file aside rather than overwriting it, and names only the file", () => {
    const path = join(dir, "mcp-credentials.json");
    writeFileSync(path, "{not json secret-looking-value", { mode: 0o600 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const store = new FileMcpCredentialStore(path);
    expect(store.read("server-1")).toBeUndefined();

    expect(existsSync(`${path}.unreadable`)).toBe(true);
    expect(readFileSync(`${path}.unreadable`, "utf8")).toContain("secret-looking-value");
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("secret-looking-value");
    store.update("server-1", () => ({ secrets: { "env:A": "b" } }));
    expect(new FileMcpCredentialStore(path).read("server-1")).toEqual({
      secrets: { "env:A": "b" },
    });
  });

  it("refuses a file of another shape the same way", () => {
    const path = join(dir, "mcp-credentials.json");
    writeFileSync(path, JSON.stringify({ version: 2, servers: {} }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(new FileMcpCredentialStore(path).read("x")).toBeUndefined();
    expect(existsSync(`${path}.unreadable`)).toBe(true);
  });
});

describe("credential records", () => {
  it("drops an emptied record, hands out copies, and moves the revision only when secrets change", () => {
    const store = new MemoryMcpCredentialStore();
    expect(store.revision("s")).toBe(0);

    store.update("s", () => ({ secrets: { "env:A": "1" } }));
    expect(store.revision("s")).toBe(1);
    const copy = store.read("s")!;
    (copy.secrets as Record<string, string>)["env:A"] = "mutated";
    expect(store.read("s")?.secrets).toEqual({ "env:A": "1" });

    // Tokens are read per request already: a refresh must not retire a client.
    store.update("s", (current) => ({
      ...current,
      oauth: { serverUrl: "https://x/", tokens: { access_token: "a", token_type: "Bearer" } },
    }));
    expect(store.revision("s")).toBe(1);

    store.update("s", (current) => ({ ...current, secrets: {} }));
    expect(store.revision("s")).toBe(2);
    store.update("s", (current) => ({ ...current, oauth: undefined }));
    expect(store.read("s")).toBeUndefined();

    store.update("t", () => ({ secrets: { "env:B": "2" } }));
    store.delete("t");
    expect(store.read("t")).toBeUndefined();
    expect(store.revision("t")).toBe(2);
  });
});
