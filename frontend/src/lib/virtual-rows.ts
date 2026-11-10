import { useVirtualizer } from "@tanstack/react-virtual";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";

/**
 * Virtual scrolling for a `<table>` inside a scrolling element: only the rows
 * in view plus `overscan` above and below are rendered, between two spacer
 * rows that keep the scroll height. Rows are measured as they render (they
 * are mostly, not always, `estimateSize` tall). Without a `scrollRef` every
 * row renders (short grids: the home page, a portal card).
 *
 * Put `bodyRef` on the `<tbody>`, `measure` and `data-index` on each row,
 * and `padTop` / `padBottom` on the spacer rows.
 */
export function useVirtualRows({
  count,
  scrollRef,
  estimateSize,
  overscan,
}: {
  count: number;
  scrollRef?: RefObject<HTMLElement | null>;
  estimateSize: number;
  overscan: number;
}) {
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const enabled = !!scrollRef;
  // Where the rows start inside the scroller (the header and anything above).
  const [margin, setMargin] = useState(0);
  // The scroller's ref is set after this component's first layout effects.
  const [, setMounted] = useState(false);
  useLayoutEffect(() => {
    setMounted(true);
    const scroller = scrollRef?.current;
    const body = bodyRef.current;
    if (!scroller || !body) return;
    const next =
      body.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    if (Math.abs(next - margin) > 0.5) setMargin(next);
  });
  const virtualizer = useVirtualizer({
    count,
    enabled,
    getScrollElement: () => scrollRef?.current ?? null,
    estimateSize: () => estimateSize,
    overscan,
    scrollMargin: margin,
  });
  const items = virtualizer.getVirtualItems();
  if (!enabled) {
    return {
      bodyRef,
      indexes: Array.from({ length: count }, (_, index) => index),
      measure: undefined,
      padTop: 0,
      padBottom: 0,
    };
  }
  const first = items[0];
  const last = items[items.length - 1];
  return {
    bodyRef,
    indexes: items.map((item) => item.index),
    measure: virtualizer.measureElement,
    padTop: first ? first.start - margin : 0,
    padBottom: last ? Math.max(virtualizer.getTotalSize() - (last.end - margin), 0) : 0,
  };
}
