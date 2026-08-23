/**
 * Roving tabindex over a table's rows.
 *
 * Every in-row control is individually reachable without this, so a table
 * already meets SC 2.1.1 — but a hundred rows with two controls each is two
 * hundred Tab stops and no way past them. This is the standard remedy: the
 * table holds ONE tab stop, arrows move between rows, and Tab from a row goes
 * to whatever follows the table.
 *
 * Enter/Space steps INTO a row — focus moves to its first control — and Escape
 * comes back out. So the controls stay reachable without every one of them
 * sitting on the Tab path.
 */
import * as React from "react";

/** What counts as a control a row can hand focus to. */
const ROW_CONTROLS = 'button, [role="switch"], [role="combobox"], input, a[href]';

export function useRovingRows(count: number) {
  const [active, setActive] = React.useState(0);
  const bodyRef = React.useRef<HTMLTableSectionElement>(null);

  // A filter that shortens the list must not strand the cursor past the end.
  React.useEffect(() => {
    setActive((current) => (current >= count ? Math.max(0, count - 1) : current));
  }, [count]);

  const focusRow = React.useCallback((index: number) => {
    setActive(index);
    bodyRef.current?.querySelectorAll<HTMLTableRowElement>("tr")[index]?.focus();
  }, []);

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLTableRowElement>, index: number) => {
      const row = event.currentTarget;

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          focusRow(Math.min(index + 1, count - 1));
          break;
        case "ArrowUp":
          event.preventDefault();
          focusRow(Math.max(index - 1, 0));
          break;
        case "Home":
          event.preventDefault();
          focusRow(0);
          break;
        case "End":
          event.preventDefault();
          focusRow(count - 1);
          break;
        case "Enter":
        case " ": {
          // Only when the ROW ITSELF has focus. Otherwise this swallows the
          // space that toggles a switch the user has already stepped into.
          if (event.target !== row) break;
          const controls = row.querySelectorAll<HTMLElement>(ROW_CONTROLS);
          if (controls.length === 0) break;
          event.preventDefault();
          controls[0]?.focus();
          break;
        }
        case "Escape":
          if (event.target !== row) {
            event.preventDefault();
            row.focus();
          }
          break;
        default:
          break;
      }
    },
    [count, focusRow],
  );

  return { active, setActive, bodyRef, onKeyDown, focusRow };
}
