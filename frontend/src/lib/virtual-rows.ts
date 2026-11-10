import { useVirtualizer } from "@tanstack/react-virtual";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Virtual scrolling for a `<table>` inside a scrolling element: only the
 * items in view plus `overscan` above and below are rendered, after and
 * before two spacers that keep the scroll height of every item. Items are
 * measured as they render (they are mostly, not always, the estimated
 * height). Without a `scrollRef` every item renders (short grids: the home
 * page, a portal card).
 *
 * Put `startRef` on the top spacer (always rendered, `padTop` tall),
 * `measure` and `data-index` on each item's element (a row, or a `<tbody>`
 * per item), and `padBottom` on the bottom spacer. `onRange` hears the
 * first and last rendered index, for fetching their pages.
 */
export function useVirtualRows({
  count,
  scrollRef,
  estimateSize,
  overscan,
  onRange,
}: {
  count: number;
  scrollRef?: RefObject<HTMLElement | null>;
  estimateSize: (index: number) => number;
  overscan: number;
  onRange?: (start: number, end: number) => void;
}) {
  const startRef = useRef<HTMLTableRowElement & HTMLTableSectionElement>(null);
  const enabled = !!scrollRef;
  // Where the items start inside the scroller (the header and anything above).
  const [margin, setMargin] = useState(0);
  // The scroller's ref is set after this component's first layout effects.
  const [, setMounted] = useState(false);
  useLayoutEffect(() => {
    setMounted(true);
    const scroller = scrollRef?.current;
    const start = startRef.current;
    if (!scroller || !start) return;
    // The top spacer starts where the first item would.
    const next =
      start.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    if (Math.abs(next - margin) > 0.5) setMargin(next);
  });
  const virtualizer = useVirtualizer({
    count,
    enabled,
    getScrollElement: () => scrollRef?.current ?? null,
    estimateSize,
    overscan,
    scrollMargin: margin,
  });
  const items = virtualizer.getVirtualItems();
  const first = enabled ? items[0] : undefined;
  const last = enabled ? items[items.length - 1] : undefined;
  const startIndex = enabled ? first?.index : 0;
  const endIndex = enabled ? last?.index : count - 1;
  const report = useRef(onRange);
  report.current = onRange;
  useEffect(() => {
    if (startIndex !== undefined && endIndex !== undefined && endIndex >= 0) {
      report.current?.(startIndex, endIndex);
    }
  }, [startIndex, endIndex]);
  if (!enabled) {
    return {
      startRef,
      indexes: Array.from({ length: count }, (_, index) => index),
      measure: undefined,
      padTop: 0,
      padBottom: 0,
    };
  }
  return {
    startRef,
    indexes: items.map((item) => item.index),
    measure: virtualizer.measureElement,
    padTop: first ? first.start - margin : 0,
    padBottom: last ? Math.max(virtualizer.getTotalSize() - (last.end - margin), 0) : 0,
  };
}
