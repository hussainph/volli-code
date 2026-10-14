import { constants, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { browserPictureDisk } from "./picture-disk";
import {
  BROWSER_PICTURE_CHUNK_BYTES,
  BrowserPictureStore,
  type BrowserPicturePersistence,
  type BrowserPictureRecord,
} from "./picture-store";

const io = vi.hoisted(() => ({
  fullReads: 0,
  opens: [] as number[],
  closes: 0,
  reads: [] as { length: number; position: number }[],
  shortReads: false,
  zeroRead: false,
  readThrows: false,
  statThrows: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      io.fullReads += 1;
      return actual.readFileSync(...args);
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      io.opens.push(args[1] as number);
      return actual.openSync(...args);
    },
    closeSync: (fd: number) => {
      io.closes += 1;
      actual.closeSync(fd);
    },
    fstatSync: (fd: number) => {
      if (io.statThrows) throw new Error("stat failed");
      return actual.fstatSync(fd);
    },
    readSync: (
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ) => {
      io.reads.push({ length, position });
      if (io.readThrows) throw new Error("read failed");
      if (io.zeroRead) return 0;
      return actual.readSync(
        fd,
        buffer,
        offset,
        io.shortReads ? Math.min(7, length) : length,
        position,
      );
    },
  };
});

const ID = "3f9c1a2e-5b6d-4c7e-8f90-1a2b3c4d5e6f";
const OTHER = "8a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
const UNAVAILABLE = { data: null, mimeType: null, nextOffset: null };
const record = (over: Partial<BrowserPictureRecord> = {}): BrowserPictureRecord => ({
  id: ID,
  tabId: "codemode:session",
  generation: 0,
  capturedAt: 1_000,
  ownerSessionId: "session",
  mime: "image/png",
  ...over,
});

let root: string;
function resetIo() {
  io.fullReads = 0;
  io.opens = [];
  io.closes = 0;
  io.reads = [];
  io.shortReads = false;
  io.zeroRead = false;
  io.readThrows = false;
  io.statThrows = false;
}
function store(persist?: BrowserPicturePersistence, liveLimit = 0) {
  return new BrowserPictureStore({ createId: () => ID, now: () => 1_000, persist, liveLimit });
}

beforeEach(() => {
  root = mkdtempSync(join(process.cwd(), ".picture-chunks-"));
  resetIo();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("bounded activity picture reads", () => {
  it("reassembles a large real-disk payload after relaunch using only offset reads, not full reads", () => {
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 7);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
    const disk = browserPictureDisk(root);
    expect(
      store(disk).keepActivityImage("session", {
        data: bytes.toString("base64"),
        mimeType: "image/png",
      }),
    ).toBe(ID);
    const pictures = store(browserPictureDisk(root));
    resetIo(); // Sidecar reads at rehydration are not pixel reads.
    const chunks: string[] = [];
    let offset: number | null = 0;
    do {
      const chunk = pictures.readActivityImage("session", ID, offset);
      expect(chunk.mimeType).toBe("image/png");
      expect(chunk.data!.length).toBeLessThanOrEqual(256 * 1024);
      expect(io.fullReads).toBe(0);
      chunks.push(chunk.data!);
      offset = chunk.nextOffset;
    } while (offset !== null);
    expect(Buffer.from(chunks.join(""), "base64").equals(bytes)).toBe(true);
    expect(io.reads.map((read) => read.position)).toEqual(
      chunks.map((_, i) => i * BROWSER_PICTURE_CHUNK_BYTES),
    );
    expect(io.reads.every((read) => read.length <= BROWSER_PICTURE_CHUNK_BYTES)).toBe(true);
    expect(io.reads.reduce((total, read) => total + read.length, 0)).toBe(bytes.length);
    expect(io.closes).toBe(chunks.length);
    expect(
      io.opens.every(
        (flags) => flags === (constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
      ),
    ).toBe(true);
  });

  it("refuses other Sessions, unknown ids and malformed offsets before even opening the sink", () => {
    const disk = browserPictureDisk(root);
    disk.write(Buffer.from("pixels"), record());
    disk.write(Buffer.from("person"), record({ id: OTHER, ownerSessionId: null }));
    const pictures = store(disk);
    resetIo();
    expect(pictures.readActivityImage("other-session", ID)).toEqual(UNAVAILABLE);
    expect(pictures.readActivityImage("session", OTHER)).toEqual(UNAVAILABLE);
    for (const id of ["never", "../escape"]) {
      expect(pictures.readActivityImage("session", id)).toEqual(UNAVAILABLE);
    }
    for (const offset of [-3, 1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(pictures.readActivityImage("session", ID, offset)).toEqual(UNAVAILABLE);
      expect(disk.readChunk!(ID, offset)).toBeNull();
    }
    expect(disk.readChunk!("../escape", 0)).toBeNull();
    expect(io.opens).toEqual([]);
    expect(io.fullReads).toBe(0);
    expect(io.reads).toEqual([]);
    expect(pictures.readActivityImage("session", ID, 6)).toEqual(UNAVAILABLE);
    expect(pictures.readActivityImage("session", ID, Number.MAX_SAFE_INTEGER - 1)).toEqual(
      UNAVAILABLE,
    );
    expect(io.reads).toEqual([]); // Out-of-file offsets require stat, but never read pixels.
    rmSync(join(root, `${ID}.png`));
    expect(pictures.readActivityImage("session", ID)).toEqual(UNAVAILABLE);
    expect(io.fullReads).toBe(0);
    expect(io.reads).toEqual([]);
    expect(disk.readChunk!(OTHER, 0)?.bytes).toEqual(Buffer.from("person"));
  });

  it("reads every persisted image MIME, including padded tails and empty images", () => {
    const disk = browserPictureDisk(root);
    for (const mime of [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/bmp",
    ] as const) {
      disk.write(Buffer.from("four"), record({ mime }));
      const pictures = store(disk);
      expect(pictures.readActivityImage("session", ID, 3)).toEqual({
        data: Buffer.from("r").toString("base64"),
        mimeType: mime,
        nextOffset: null,
      });
      disk.remove(ID);
    }
    disk.write(Buffer.alloc(0), record());
    expect(store(disk).readActivityImage("session", ID)).toEqual(UNAVAILABLE);
  });

  it("keeps direct browser reads whole and live activity reads off disk", () => {
    const disk = browserPictureDisk(root);
    const pictures = store(disk, 1);
    const bytes = Buffer.from("live pixels");
    pictures.put({ ...record(), bytes, persist: true });
    resetIo();
    expect(pictures.readActivityImage("session", ID).data).toBe(bytes.toString("base64"));
    expect(pictures.dataUrl(ID)).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
    expect(pictures.copyOf(ID)?.bytes).toEqual(bytes);
    expect(io.opens).toEqual([]);
    expect(io.fullReads).toBe(0);
    const relaunched = store(disk);
    resetIo();
    expect(relaunched.dataUrl(ID)).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
    expect(relaunched.copyOf(ID)?.bytes).toEqual(bytes);
    expect(io.fullReads).toBe(2);
    expect(io.reads).toEqual([]);
  });

  it("supports older injected sinks but authorizes before their full read, including missing bytes", () => {
    const read = vi.fn((): ReturnType<BrowserPicturePersistence["read"]> => ({
      bytes: Buffer.from("pixels"),
      mime: "image/png",
    }));
    const pictures = store({ write: vi.fn(), read, list: () => [record()], remove: vi.fn() });
    expect(pictures.readActivityImage("other-session", ID)).toEqual(UNAVAILABLE);
    expect(pictures.readActivityImage("session", ID, 1)).toEqual(UNAVAILABLE);
    expect(read).not.toHaveBeenCalled();
    expect(pictures.readActivityImage("session", ID, 3).data).toBe(
      Buffer.from("els").toString("base64"),
    );
    expect(pictures.readActivityImage("session", ID, 6)).toEqual(UNAVAILABLE);
    read.mockReturnValue(null);
    expect(pictures.readActivityImage("session", ID)).toEqual(UNAVAILABLE);
    const liveOnly = store(undefined, 1);
    liveOnly.put({ ...record(), bytes: Buffer.from("live"), persist: false });
    expect(liveOnly.readActivityImage("session", ID).data).toBe(
      Buffer.from("live").toString("base64"),
    );
  });

  it("never falls back to a full read when a chunk-capable sink reports missing bytes", () => {
    const read = vi.fn();
    const readChunk = vi.fn(() => null);
    const pictures = store({
      write: vi.fn(),
      read,
      readChunk,
      list: () => [record()],
      remove: vi.fn(),
    });
    expect(pictures.readActivityImage("session", ID)).toEqual(UNAVAILABLE);
    expect(readChunk).toHaveBeenCalledWith(ID, 0);
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses leaf symlinks and directories without reading their contents", () => {
    const disk = browserPictureDisk(root);
    disk.write(Buffer.from("outside"), record({ id: OTHER }));
    symlinkSync(join(root, `${OTHER}.png`), join(root, `${ID}.png`));
    expect(disk.readChunk!(ID, 0)).toBeNull();
    expect(io.reads).toEqual([]);
    rmSync(join(root, `${ID}.png`));
    mkdirSync(join(root, `${ID}.png`));
    expect(disk.readChunk!(ID, 0)).toBeNull();
    expect(io.reads).toEqual([]);
    expect(io.closes).toBe(1);
  });

  it("completes short reads and closes descriptors on EOF, stat failures and read failures", () => {
    const disk = browserPictureDisk(root);
    const bytes = Buffer.from("a short but complete picture");
    disk.write(bytes, record());
    io.shortReads = true;
    expect(disk.readChunk!(ID, 0)).toEqual({ bytes, byteLength: bytes.length });
    expect(io.reads.length).toBeGreaterThan(1);
    expect(io.closes).toBe(1);
    resetIo();
    io.zeroRead = true;
    expect(disk.readChunk!(ID, 0)).toBeNull();
    expect(io.closes).toBe(1);
    resetIo();
    io.statThrows = true;
    expect(disk.readChunk!(ID, 0)).toBeNull();
    expect(io.closes).toBe(1);
    expect(io.reads).toEqual([]);
    resetIo();
    io.readThrows = true;
    expect(disk.readChunk!(ID, 0)).toBeNull();
    expect(io.closes).toBe(1);
  });
});
