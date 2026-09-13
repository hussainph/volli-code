/**
 * How many label chips fit on ONE line of a board card, and how many are left
 * over for the `+n` chip to stand for.
 *
 * A card's height is the board's scanning unit: a ticket wearing nine labels
 * used to draw a tile several times the height of its neighbours, so the
 * column stopped being a list of comparable things. Capping the labels at one
 * line puts every card back on the same rhythm.
 *
 * Pure, and separated from the card for the reason `tab-scroll.ts` gives: the
 * measuring is a DOM concern with no logic in it, and the packing is logic
 * with no DOM in it. Only the second one is worth testing, and it cannot be
 * tested at all through a jsdom render, where every width is zero.
 */

export interface LabelRowMetrics {
  /** Each chip's rendered width in px, in the order the card draws them. */
  readonly widths: readonly number[];
  /** The row's inner width in px. */
  readonly available: number;
  /** The flex gap between two chips, in px. */
  readonly gap: number;
  /** The `+n` chip's width in px — reserved only when it will actually be drawn. */
  readonly overflow: number;
}

export interface LabelRowSplit {
  /** How many leading chips are drawn. */
  readonly visible: number;
  /** How many the `+n` chip stands for; `0` means no `+n` chip. */
  readonly hidden: number;
}

/**
 * The width of the first `count` chips laid out in a row, gaps included.
 *
 * Written without a guard on `count` or a fallback on a missing width, because
 * neither case can arise: every caller below passes a count between 1 and
 * `widths.length`. A branch that cannot be taken is not free — it is an
 * untestable line in a module held at 100%, and the honest way to keep it out
 * is to not write it. `slice` and `Math.max` cover the degenerate counts by
 * arithmetic rather than by asking.
 */
function rowWidth(widths: readonly number[], count: number, gap: number): number {
  const chips = widths.slice(0, count);
  const chipsWidth = chips.reduce((total, width) => total + width, 0);
  return chipsWidth + gap * Math.max(chips.length - 1, 0);
}

/**
 * The one-line split for a row of chips.
 *
 * The subtlety is that reserving room for `+n` can push out the very chip that
 * made it necessary, so the two questions are not independent: "do they all
 * fit" has to be answered WITHOUT the `+n` chip, and only once the answer is
 * no does its width start competing for the same line. Deciding in that order
 * is what keeps a row that exactly fits from being truncated to make space for
 * a `+n` standing for nothing.
 */
export function labelRowSplit({
  widths,
  available,
  gap,
  overflow,
}: LabelRowMetrics): LabelRowSplit {
  const total = widths.length;
  if (total === 0) return { visible: 0, hidden: 0 };
  if (rowWidth(widths, total, gap) <= available) return { visible: total, hidden: 0 };

  // Every chip below competes with the `+n` chip, which is now certain to be
  // drawn: there is at least one label it must account for.
  for (let count = total - 1; count >= 1; count--) {
    if (rowWidth(widths, count, gap) + gap + overflow <= available) {
      return { visible: count, hidden: total - count };
    }
  }
  // Not even one chip plus the `+n` fits. The `+n` alone still says there is
  // something here, which is the honest answer for a card this narrow.
  return { visible: 0, hidden: total };
}
