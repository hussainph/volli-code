import { PACKAGED_RENDERER_ENTRY_URL } from "../app-protocol";

/** Match the entry actually loaded by createWindow, including built unpackaged apps. */
export function isSecretRenderer(url: string, devRendererUrl?: string): boolean {
  const renderer = devRendererUrl || PACKAGED_RENDERER_ENTRY_URL;
  if (!URL.canParse(renderer) || !URL.canParse(url)) return false;
  const actual = new URL(url);
  const expected = new URL(renderer);
  actual.hash = "";
  expected.hash = "";
  return actual.href === expected.href;
}
