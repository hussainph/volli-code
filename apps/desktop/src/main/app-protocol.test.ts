import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  PACKAGED_RENDERER_HOST,
  PACKAGED_RENDERER_ORIGIN,
  resolvePackagedRendererAsset,
} from "./app-protocol";

const rendererRoot = resolve("/Applications/Volli Code.app/Contents/Resources/app/dist");

describe("resolvePackagedRendererAsset", () => {
  it("resolves the exact packaged host beneath the renderer root", () => {
    expect(
      resolvePackagedRendererAsset(`${PACKAGED_RENDERER_ORIGIN}/index.html`, rendererRoot),
    ).toBe(resolve(rendererRoot, "index.html"));
    expect(
      resolvePackagedRendererAsset(
        `${PACKAGED_RENDERER_ORIGIN}/assets/editor.worker.js?worker=1#ignored`,
        rendererRoot,
      ),
    ).toBe(resolve(rendererRoot, "assets/editor.worker.js"));
  });

  it("maps the packaged origin root to the renderer entry", () => {
    expect(resolvePackagedRendererAsset(`${PACKAGED_RENDERER_ORIGIN}/`, rendererRoot)).toBe(
      resolve(rendererRoot, "index.html"),
    );
  });

  it("rejects a different scheme, host, port, or credentialed URL", () => {
    expect(
      resolvePackagedRendererAsset(`https://${PACKAGED_RENDERER_HOST}/index.html`, rendererRoot),
    ).toBeNull();
    expect(resolvePackagedRendererAsset("volli-app://other/index.html", rendererRoot)).toBeNull();
    expect(
      resolvePackagedRendererAsset(
        `volli-app://${PACKAGED_RENDERER_HOST}:99/index.html`,
        rendererRoot,
      ),
    ).toBeNull();
    expect(
      resolvePackagedRendererAsset(
        `volli-app://user@${PACKAGED_RENDERER_HOST}/index.html`,
        rendererRoot,
      ),
    ).toBeNull();
  });

  it("rejects malformed paths and every encoded renderer-root escape", () => {
    expect(resolvePackagedRendererAsset("not a url", rendererRoot)).toBeNull();
    expect(
      resolvePackagedRendererAsset(
        `${PACKAGED_RENDERER_ORIGIN}/assets/%2F..%2Fsecret.txt`,
        rendererRoot,
      ),
    ).toBeNull();
    expect(
      resolvePackagedRendererAsset(
        `${PACKAGED_RENDERER_ORIGIN}/assets/%5C..%5Csecret.txt`,
        rendererRoot,
      ),
    ).toBeNull();
    expect(
      resolvePackagedRendererAsset(`${PACKAGED_RENDERER_ORIGIN}//tmp/secret.txt`, rendererRoot),
    ).toBeNull();
    expect(
      resolvePackagedRendererAsset(`${PACKAGED_RENDERER_ORIGIN}/bad%00name.js`, rendererRoot),
    ).toBeNull();
    expect(
      resolvePackagedRendererAsset(`${PACKAGED_RENDERER_ORIGIN}/bad%ZZname.js`, rendererRoot),
    ).toBeNull();
  });
});
