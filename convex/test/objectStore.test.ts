import { describe, expect, test } from "vite-plus/test";

import { objectStoreConfig, parseListObjectsV2 } from "../functions/lib/objectStore";

describe("parseListObjectsV2", () => {
  test("decodes form-encoded keys and XML entities", () => {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>true</IsTruncated>` +
      `<Contents><Key>v1/p/a+b%2Bc/c%26d</Key><Size>1</Size></Contents>` +
      `<Contents><ETag>&quot;x&quot;</ETag><Key>v1/p/&amp;%2Fe&#x3D;&#43;</Key></Contents>` +
      `<NextContinuationToken>token</NextContinuationToken></ListBucketResult>`;
    expect(parseListObjectsV2(xml)).toEqual(["v1/p/a b+c/c&d", "v1/p/&/e= "]);
  });

  test("an empty page holds no keys", () => {
    expect(
      parseListObjectsV2("<ListBucketResult><KeyCount>0</KeyCount></ListBucketResult>"),
    ).toEqual([]);
  });

  test("refuses a page it cannot follow", () => {
    expect(() =>
      parseListObjectsV2(
        "<ListBucketResult><Contents><Key>%E0%A4%A</Key></Contents></ListBucketResult>",
      ),
    ).toThrow(URIError);
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
