import { describe, expect, it, vi } from "vite-plus/test";
import { trashCapabilities, TrashUnavailableError } from "./trash";

describe("host trash port", () => {
  it("refuses headless with a typed, readable error", async () => {
    const refusal = trashCapabilities(undefined).trashItem("/not-deleted");
    await expect(refusal).rejects.toBeInstanceOf(TrashUnavailableError);
    await expect(refusal).rejects.toMatchObject({
      code: "trash-unavailable",
      name: "TrashUnavailableError",
      message:
        "Moving a file to Trash needs the Volli desktop host. This host cannot trash files; nothing was deleted.",
    });
  });

  it("uses the supplied host adapter unchanged", async () => {
    const port = { trashItem: vi.fn(async () => {}) };
    expect(trashCapabilities(port)).toBe(port);
    await trashCapabilities(port).trashItem("/file");
    expect(port.trashItem).toHaveBeenCalledWith("/file");
  });
});
