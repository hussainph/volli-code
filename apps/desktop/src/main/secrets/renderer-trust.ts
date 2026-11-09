import { PACKAGED_RENDERER_ENTRY_URL } from "../app-protocol";

/** Match the entry actually loaded by createWindow, including built unpackaged apps. */
export function isSecretRenderer(
  url: string,
  devRendererUrl?: string,
  role?: "main" | "settings",
): boolean {
  const renderer = devRendererUrl || PACKAGED_RENDERER_ENTRY_URL;
  if (!URL.canParse(renderer) || !URL.canParse(url)) return false;
  const actual = new URL(url);
  const expected = new URL(renderer);
  // Only the two explicitly owned entries may touch renderer credentials.
  // A matching bundle origin (or an arbitrary hash on it) is not sufficient.
  if (role === "main" && actual.hash !== "") return false;
  if (role === "settings" && actual.hash !== "#settings") return false;
  if (role === undefined && actual.hash !== "" && actual.hash !== "#settings") return false;
  actual.hash = "";
  expected.hash = "";
  return actual.href === expected.href;
}
