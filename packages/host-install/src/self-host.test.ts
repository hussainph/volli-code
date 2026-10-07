import { constants } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const files = vi.hoisted(() => ({
  readdir: vi.fn(),
  fstat: vi.fn(),
  read: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readdirSync: files.readdir,
  fstatSync: files.fstat,
  readFileSync: files.read,
  openSync: files.open,
  closeSync: files.close,
}));
vi.mock("node:os", () => ({ hostname: () => "My-Mac.local" }));

import { isSelfHost } from "./probe";

const target = (destination: string) => ({ destination, port: 2222, label: "a custom label" });
const local = { hostname: "My-Mac.local", sshHostKeys: ["ssh-ed25519 AAAA this Mac"] };

beforeEach(() => {
  vi.resetAllMocks();
  files.readdir.mockReturnValue([]);
  files.fstat.mockReturnValue({ isFile: () => true });
  files.read.mockReturnValue("ssh-ed25519 AAAA this Mac");
  files.open.mockReturnValue(12);
});

describe("self-add detection without commands or private keys", () => {
  it.each(["localhost", "127.0.0.1", "[::1]", "::1", "My-Mac.local", "MY-MAC.LOCAL."])(
    "recognizes %s including user and explicit port",
    (name) => {
      expect(isSelfHost(target(`me@${name}`), [], local)).toBe(true);
      expect(files.read).not.toHaveBeenCalled();
    },
  );

  it("does not read local keys when the remote probe supplied none", () => {
    expect(isSelfHost(target("remote-alias"), [])).toBe(false);
    expect(files.readdir).not.toHaveBeenCalled();
  });

  it("uses the real hostname default without reading keys on a name match", () => {
    expect(isSelfHost(target("My-Mac.local"), [])).toBe(true);
    expect(files.readdir).not.toHaveBeenCalled();
  });

  it("matches key type and bytes, ignoring comments, not malformed or different keys", () => {
    expect(isSelfHost(target("remote-alias"), ["ssh-ed25519 AAAA remote comment"], local)).toBe(
      true,
    );
    expect(
      isSelfHost(
        target("remote-alias"),
        ["ssh-rsa AAAA", "ssh-ed25519 BBBB", "", "garbage AAAA", "ssh-ed25519"],
        local,
      ),
    ).toBe(false);
    expect(
      isSelfHost(target("remote-alias"), ["ecdsa-sha2-nistp256 CCCC"], {
        hostname: "local",
        sshHostKeys: ["", "garbage", "ecdsa-sha2-nistp256 CCCC"],
      }),
    ).toBe(true);
    expect(files.read).not.toHaveBeenCalled();
  });

  it("reads regular .pub files under /etc/ssh only, never symlinks, directories or private keys", () => {
    files.readdir.mockReturnValue([
      "ssh_host_ed25519_key",
      "ssh_host_ed25519_key.pub",
      "linked.pub",
      "directory.pub",
      "../outside.pub",
      "unreadable.pub",
    ]);
    files.open.mockImplementation((path: string) => {
      if (path.endsWith("linked.pub")) throw new Error("ELOOP");
      if (path.endsWith("unreadable.pub")) throw new Error("EACCES");
      return path.endsWith("directory.pub") ? 13 : 12;
    });
    files.fstat.mockImplementation((fd: number) => ({ isFile: () => fd === 12 }));
    expect(isSelfHost(target("remote-alias"), ["ssh-ed25519 AAAA"])).toBe(true);
    expect(files.readdir).toHaveBeenCalledExactlyOnceWith("/etc/ssh");
    expect(files.open).toHaveBeenCalledWith(
      "/etc/ssh/ssh_host_ed25519_key.pub",
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    expect(files.read).toHaveBeenCalledExactlyOnceWith(12, "utf8");
    expect(files.close.mock.calls).toEqual([[12], [13]]);
    expect(files.open.mock.calls.map(([path]) => path)).toEqual([
      "/etc/ssh/ssh_host_ed25519_key.pub",
      "/etc/ssh/linked.pub",
      "/etc/ssh/directory.pub",
      "/etc/ssh/unreadable.pub",
    ]);
    expect(files.fstat.mock.calls).toEqual([[12], [13]]);
  });

  it("closes an opened public key even when reading fails", () => {
    files.readdir.mockReturnValue(["ssh_host_ed25519_key.pub"]);
    files.read.mockImplementation(() => {
      throw new Error("EIO");
    });
    expect(isSelfHost(target("remote-alias"), ["ssh-ed25519 AAAA"])).toBe(false);
    expect(files.close).toHaveBeenCalledExactlyOnceWith(12);
  });

  it("does not claim a key match when local public keys are unavailable", () => {
    files.readdir.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(isSelfHost(target("remote-alias"), ["ssh-ed25519 AAAA"])).toBe(false);
    expect(files.read).not.toHaveBeenCalled();
  });

  it("ignores a public key removed before opening", () => {
    files.readdir.mockReturnValue(["gone.pub"]);
    files.open.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(isSelfHost(target("remote-alias"), ["ssh-ed25519 AAAA"])).toBe(false);
    expect(files.fstat).not.toHaveBeenCalled();
    expect(files.close).not.toHaveBeenCalled();
  });

  it("checks the opened descriptor and refuses a non-regular replacement without reading or waiting", () => {
    files.readdir.mockReturnValue(["changed.pub"]);
    files.open.mockImplementation(() => {
      files.fstat.mockReturnValue({ isFile: () => false });
      return 42;
    });
    expect(isSelfHost(target("remote-alias"), ["ssh-ed25519 AAAA"])).toBe(false);
    expect(files.open).toHaveBeenCalledExactlyOnceWith(
      "/etc/ssh/changed.pub",
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    expect(files.fstat).toHaveBeenCalledExactlyOnceWith(42);
    expect(files.read).not.toHaveBeenCalled();
    expect(files.close).toHaveBeenCalledExactlyOnceWith(42);
  });

  it("closes the descriptor if its metadata cannot be read", () => {
    files.readdir.mockReturnValue(["stat-fails.pub"]);
    files.fstat.mockImplementation(() => {
      throw new Error("EIO");
    });
    expect(isSelfHost(target("remote-alias"), ["ssh-ed25519 AAAA"])).toBe(false);
    expect(files.read).not.toHaveBeenCalled();
    expect(files.close).toHaveBeenCalledExactlyOnceWith(12);
  });
});
