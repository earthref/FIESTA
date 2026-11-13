/**
 * The plot tabs' layout (pmag-plots, plateau-calculations): the selected plot
 * drawn large, and every plot as a small card to pick from, below it or in a
 * column beside it, whichever leaves the cards the larger view; the cards
 * scroll virtually.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cx } from "@/lib/utils";

/** A card's narrowest width before the grid drops a column, and the gap. */
export const CARD_MIN_WIDTH = 190;
const CARD_GAP = 8;
/** A card's title and borders, around its chart. */
const CARD_CHROME = 28;
/** The plots' padding and the gap between the selected plot and the cards. */
const PANE_GAP = 12;
/** Beside the selected plot, the cards' share of the width (the plot's 3:2). */
const BESIDE_SHARE = 2 / 5;

/** A card's chart, inside its borders. */
export interface CardSize {
  width: number;
  height: number;
}

/**
 * Whether the cards go beside the selected plot rather than below it: where
 * they get the larger view to scroll in. Below, the full width under the
 * plot (`largeHeight` tall, with its header and notes); beside, their share
 * of the width at the full height (and at least a card wide).
 */
function cardsBeside(width: number, height: number, largeHeight: number, cardMin: number) {
  const w = width - 2 * PANE_GAP;
  const h = height - 2 * PANE_GAP;
  const besideWidth = (w - PANE_GAP) * BESIDE_SHARE;
  if (besideWidth < cardMin) return false;
  const below = w * Math.max(0, h - largeHeight - PANE_GAP);
  return besideWidth * h > below;
}

/** Watches an element's size. */
export function useSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () =>
      setSize((prev) =>
        prev.width === element.clientWidth && prev.height === element.clientHeight
          ? prev
          : { width: element.clientWidth, height: element.clientHeight },
      );
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/**
 * A plot tab: `header` (controls and legend) stays put, and the selected
 * plot (`large`) and the `count` cards scroll below it. `index` is the
 * selected card, which the cards scroll to when they sit beside the plot.
 * `scrollRef` is the cards' scroller, for the tab to scroll to the top when
 * its filter changes.
 */
export function PlotLayout({
  header,
  large,
  count,
  index,
  renderCard,
  scrollRef,
  largeHeight,
  cardMinWidth = CARD_MIN_WIDTH,
  cardAspect = 1,
  empty = "No plots match the filter.",
}: {
  header: ReactNode;
  large: ReactNode;
  count: number;
  index: number;
  renderCard: (index: number, size: CardSize) => ReactNode;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** The selected plot's height with its header and notes. */
  largeHeight: number;
  cardMinWidth?: number;
  /** A card's chart height over its width. */
  cardAspect?: number;
  empty?: string;
}) {
  // The room under the header, which the plot and the cards share.
  const body = useRef<HTMLDivElement>(null);
  const room = useSize(body);
  const beside = cardsBeside(room.width, room.height, largeHeight, cardMinWidth);
  const cards = (
    <VirtualCards
      // A grid per layout: each mounts with its own scroller (and reveal).
      key={beside ? "beside" : "below"}
      count={count}
      scrollRef={scrollRef}
      // Beside the plot, the cards scroll to the selected one.
      reveal={beside ? index : undefined}
      minWidth={cardMinWidth}
      aspect={cardAspect}
      render={renderCard}
    />
  );
  return (
    <div className="flex h-full min-h-[420px] flex-col">
      <div className="space-y-3 px-3 pt-3">{header}</div>
      <div ref={body} className="flex min-h-0 flex-1 flex-col">
        {count === 0 ? (
          <p className="py-8 text-center text-[13px] text-gray-500">{empty}</p>
        ) : beside ? (
          <div className="flex min-h-0 flex-1 gap-3 p-3">
            <div className="min-w-0 flex-[3] overflow-y-auto">{large}</div>
            <div ref={scrollRef} className="relative min-w-0 flex-[2] overflow-y-auto">
              {cards}
            </div>
          </div>
        ) : (
          <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto p-3">
            {large}
            <div className="mt-3">{cards}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The plot cards as a grid that scrolls virtually: as many columns as fit
 * (at least `minWidth` each), and only the rows of cards in view, and two
 * above and below, mounted, so a contribution's hundreds of charts never all
 * draw at once. `reveal` scrolls that card into view once the columns are
 * known.
 */
function VirtualCards({
  count,
  scrollRef,
  reveal,
  minWidth,
  aspect,
  render,
}: {
  count: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  reveal?: number;
  minWidth: number;
  aspect: number;
  render: (index: number, size: CardSize) => ReactNode;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  // Unknown until the grid's width is measured (no rows until then).
  const [columns, setColumns] = useState<number | null>(null);
  // A card's width (its chart's, plus the card's borders).
  const [width, setWidth] = useState(minWidth);
  // Where the grid starts inside the scroller (its padding, a plot above it).
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const update = () => {
      const fit = Math.floor((grid.clientWidth + CARD_GAP) / (minWidth + CARD_GAP));
      const cols = Math.max(1, Math.min(8, fit));
      setColumns(cols);
      setWidth(Math.floor((grid.clientWidth - (cols - 1) * CARD_GAP) / cols));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [minWidth]);
  useLayoutEffect(() => {
    const top = gridRef.current?.offsetTop ?? 0;
    if (top !== margin) setMargin(top);
  });
  const perRow = columns ?? 1;
  const rows = columns ? Math.ceil(count / columns) : 0;
  const chart = { width: width - 2, height: Math.round((width - 2) * aspect) };
  const rowEstimate = chart.height + CARD_CHROME;
  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowEstimate,
    overscan: 2,
    gap: CARD_GAP,
    scrollMargin: margin,
  });
  // Once the columns are known and the virtualizer has its scroller (which
  // mounts with the grid, so after the grid's first effects), the selected
  // card into view.
  // Rows not yet drawn sit at their estimated places, so the scroller goes
  // straight to the row's estimated middle and the virtualizer follows it.
  const pending = useRef(reveal);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!columns || pending.current === undefined || !scroller) return;
    const row = Math.floor(pending.current / columns);
    const middle = margin + row * (rowEstimate + CARD_GAP) + rowEstimate / 2;
    scroller.scrollTop = Math.max(0, middle - scroller.clientHeight / 2);
    pending.current = undefined;
  });
  return (
    <div ref={gridRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((row) => (
        <div
          key={row.key}
          data-index={row.index}
          ref={virtualizer.measureElement}
          className="absolute inset-x-0 top-0 grid"
          style={{
            gap: CARD_GAP,
            gridTemplateColumns: `repeat(${perRow}, minmax(0, 1fr))`,
            transform: `translateY(${row.start - margin}px)`,
          }}
        >
          {Array.from(
            { length: Math.min(perRow, count - row.index * perRow) },
            (_, i) => row.index * perRow + i,
          ).map((i) => render(i, chart))}
        </div>
      ))}
    </div>
  );
}

/** A card to pick a plot with: its title over `children` (the small chart,
 * which only shows; the selected plot is the interactive one). */
export function PlotCard({
  title,
  tooltip,
  selected,
  onSelect,
  children,
}: {
  title: string;
  tooltip?: string;
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      title={tooltip ?? title}
      className={cx(
        "block w-full min-w-0 cursor-pointer overflow-hidden rounded-sm border bg-surface text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
        selected ? "border-node" : "border-gray-300 hover:border-gray-400",
      )}
    >
      <span className="block truncate border-b border-gray-200 px-2 py-1 text-[12px] font-bold text-node-ink">
        {title}
      </span>
      <span className="pointer-events-none block">{children}</span>
    </button>
  );
}

/** A row of toggle buttons (a level, a coordinate system), with counts. */
export function Choices<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string; count?: number }[];
  value?: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="flex items-center gap-1.5">
      <legend className="float-left mr-1.5 font-bold text-gray-700">{label}</legend>
      <div className="inline-flex overflow-hidden rounded-sm border border-gray-300">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
            className={cx(
              "border-l border-gray-300 px-2 py-0.5 first:border-l-0",
              option.value === value
                ? "bg-node font-bold text-white"
                : "bg-surface text-gray-700 hover:bg-gray-50",
            )}
          >
            {option.label}
            {option.count !== undefined && (
              <span
                className={cx("ml-1", option.value === value ? "text-white/80" : "text-gray-500")}
              >
                {option.count}
              </span>
            )}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** The plot filter: a search box and how many plots it leaves. */
export function PlotFilter({
  value,
  onChange,
  label,
  shown,
  total,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  shown: number;
  total: number;
}) {
  return (
    <>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Filter by name…"
        aria-label={label}
        className="w-48 rounded-sm border border-gray-300 px-2 py-1 text-[13px]"
      />
      <span className="text-gray-500">
        {shown === total ? `${total} plot${total === 1 ? "" : "s"}` : `${shown} of ${total} plots`}
      </span>
    </>
  );
}
