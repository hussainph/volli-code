import type { DirEntry, ListDirectoryResult } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";
import {
  errorListing,
  isListingError,
  shouldFetchListing,
  shouldRetryListing,
  toListing,
} from "./listing";

const entries: DirEntry[] = [{ name: "a", kind: "file" }];

describe("isListingError", () => {
  it("is false for undefined, loading, and both array shapes", () => {
    expect(isListingError(undefined)).toBe(false);
    expect(isListingError("loading")).toBe(false);
    expect(isListingError([])).toBe(false);
    expect(isListingError(entries)).toBe(false);
  });

  it("is true for an error object", () => {
    expect(isListingError({ error: "boom" })).toBe(true);
  });
});

describe("toListing", () => {
  it("returns the same entries reference on the ok path", () => {
    const result: ListDirectoryResult = { ok: true, entries };
    expect(toListing(result)).toBe(result.entries);
  });

  it("maps the error on the failure path", () => {
    const result: ListDirectoryResult = { ok: false, error: "denied" };
    expect(toListing(result)).toEqual({ error: "denied" });
  });
});

describe("errorListing", () => {
  it("wraps a thrown Error's message", () => {
    expect(errorListing(new Error("boom"))).toEqual({ error: "boom" });
  });

  it("wraps a non-Error thrown value", () => {
    expect(errorListing("boom")).toEqual({ error: "boom" });
  });
});

describe("shouldFetchListing", () => {
  it("is true when expanded and not yet fetched", () => {
    expect(shouldFetchListing(true, undefined)).toBe(true);
  });

  it("is false when not expanded, even if unfetched", () => {
    expect(shouldFetchListing(false, undefined)).toBe(false);
  });

  it("is false when expanded but already loading, loaded, or errored", () => {
    expect(shouldFetchListing(true, "loading")).toBe(false);
    expect(shouldFetchListing(true, entries)).toBe(false);
    expect(shouldFetchListing(true, { error: "boom" })).toBe(false);
  });
});

describe("shouldRetryListing", () => {
  it("is true when opening onto a cached error", () => {
    expect(shouldRetryListing(true, { error: "boom" })).toBe(true);
  });

  it("is false when closing, even onto a cached error", () => {
    expect(shouldRetryListing(false, { error: "boom" })).toBe(false);
  });

  it("is false when opening onto undefined, loading, or loaded entries", () => {
    expect(shouldRetryListing(true, undefined)).toBe(false);
    expect(shouldRetryListing(true, "loading")).toBe(false);
    expect(shouldRetryListing(true, entries)).toBe(false);
  });
});
