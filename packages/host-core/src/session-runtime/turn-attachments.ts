import type { RuntimeImageInput } from "@volli/shared";

export interface TurnAttachments {
  /**
   * A line per attached file naming where it landed, appended to the prompt.
   * Empty when the turn carried no files.
   */
  note: string;
  /** Images to hand the model as content for this turn only. */
  images: RuntimeImageInput[];
}
