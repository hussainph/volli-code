import { HelpTag } from "@renderer/components/ui/help-tag";
import type { SVGProps } from "react";
import { providerMark } from "@renderer/components/models/model-identity";

/** Preserve optional SVG winding rules when the shared registry supplies them. */
export type ProviderArtwork = NonNullable<ReturnType<typeof providerMark>> & {
  fillRule?: SVGProps<SVGSVGElement>["fillRule"];
  clipRules?: readonly SVGProps<SVGPathElement>["clipRule"][];
};

/** The same provider artwork used by model identity and the chrome meter. */
export function ProviderGlyph({ id, label }: { id: string; label: string }) {
  return (
    <HelpTag label={label}>
      <ProviderArtworkGlyph id={id} label={label} />
    </HelpTag>
  );
}

function ProviderArtworkGlyph({ id, label }: { id: string; label: string }) {
  const mark: ProviderArtwork | null = providerMark(id);
  if (mark === null)
    return (
      <span
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center text-ui font-semibold"
      >
        {label.charAt(0)}
      </span>
    );
  return (
    <svg
      aria-hidden
      viewBox={mark.viewBox}
      fill="currentColor"
      fillRule={mark.fillRule}
      className="size-5 shrink-0 text-foreground"
    >
      {mark.paths.map((path, index) => (
        <path key={path} d={path} clipRule={mark.clipRules?.[index]} />
      ))}
    </svg>
  );
}
