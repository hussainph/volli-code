import { describe, expect, test } from "vite-plus/test";

import { objectStoreConfig, parseListObjectsV2 } from "../functions/lib/objectStore";

describe("parseListObjectsV2", () => {
  test("decodes url-encoded keys, XML entities and the next token", () => {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>true</IsTruncated>` +
      `<Contents><Key>v1/p/a%20b/c%26d</Key><Size>1</Size></Contents>` +
      `<Contents><ETag>&quot;x&quot;</ETag><Key>v1/p/&amp;%2Fe</Key></Contents>` +
      `<NextContinuationToken>1/abc&#43;&#x3D;</NextContinuationToken></ListBucketResult>`;
    expect(parseListObjectsV2(xml)).toEqual({
      keys: ["v1/p/a b/c&d", "v1/p/&/e"],
      nextContinuationToken: "1/abc+=",
    });
  });

  test("an untruncated page ends the list; an empty one holds no keys", () => {
    expect(
      parseListObjectsV2(
        "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>k</Key></Contents></ListBucketResult>",
      ),
    ).toEqual({ keys: ["k"], nextContinuationToken: null });
    expect(
      parseListObjectsV2("<ListBucketResult><KeyCount>0</KeyCount></ListBucketResult>"),
    ).toEqual({ keys: [], nextContinuationToken: null });
  });

  test("refuses a page it cannot follow", () => {
    expect(() =>
      parseListObjectsV2("<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>"),
    ).toThrow(/continuation token/u);
    expect(() =>
      parseListObjectsV2(
        "<ListBucketResult><Contents><Size>1</Size></Contents></ListBucketResult>",
      ),
    ).toThrow(/no key/u);
  });
});

test("objectStoreConfig needs every variable", () => {
  const env = {
    VOLLI_S3_ENDPOINT: "https://store.example",
    VOLLI_S3_BUCKET: "b",
    VOLLI_S3_ACCESS_KEY_ID: "id",
    VOLLI_S3_SECRET_ACCESS_KEY: "secret",
  };
  expect(objectStoreConfig(env)).toMatchObject({ bucket: "b", region: "auto" });
  expect(objectStoreConfig({ ...env, VOLLI_S3_BUCKET: "" })).toBeNull();
});
