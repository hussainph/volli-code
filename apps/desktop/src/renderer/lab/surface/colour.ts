/** DialKit accepts CSS colours; the production canvas stores opaque sRGB hex. */
export function studyColourHex(value: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  if (!CSS.supports("color", value)) throw new Error("Use a valid CSS colour.");
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("Colour sampling is unavailable; use six-digit hex.");
  // Alpha in an authored stop is flattened over the study's neutral seed.
  context.fillStyle = "#808080";
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  return `#${[...context.getImageData(0, 0, 1, 1).data]
    .slice(0, 3)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
