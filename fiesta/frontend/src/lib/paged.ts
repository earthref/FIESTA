import { keepPreviousData, type QueryKey, useQueries, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

/** How long the visible range must hold before its pages are fetched (a
 * dragged scrollbar passes over pages it never stops on). */
const SETTLE_MS = 120;

function pageData<T>(results: { data?: T }[]): (T | undefined)[] {
  return results.map((result) => result.data);
}

/**
 * The items of a paged result for a virtual grid sized to all of them: page 0
 * (which carries the total) always, and the pages under the grid's visible
 * range (`onRange`, from the grid) once it settles. `items` has one entry per
 * item up to `limit`, undefined where its page has not arrived (a placeholder
 * row). Pages are cached per `queryKey`, so scrolling back is instant.
 */
export function usePagedItems<P, T>({
  queryKey,
  pageSize,
  fetchPage,
  totalOf,
  itemsOf,
  limit = Number.POSITIVE_INFINITY,
  enabled = true,
}: {
  queryKey: QueryKey;
  pageSize: number;
  fetchPage: (page: number) => Promise<P>;
  totalOf: (page: P) => number;
  itemsOf: (page: P) => T[];
  limit?: number;
  enabled?: boolean;
}) {
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [settled, setSettled] = useState<[number, number]>([0, 0]);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(range), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [range]);
  const onRange = useCallback(
    (start: number, end: number) =>
      setRange((prev) => (prev[0] === start && prev[1] === end ? prev : [start, end])),
    [],
  );

  const first = useQuery({
    queryKey: [...queryKey, 0],
    queryFn: () => fetchPage(0),
    enabled,
    placeholderData: keepPreviousData,
  });
  const total = first.data ? Math.max(0, Math.min(totalOf(first.data), limit)) : 0;
  const pages = useMemo(() => {
    const out: number[] = [];
    const last = Math.min(Math.floor(settled[1] / pageSize), Math.ceil(total / pageSize) - 1);
    for (let page = Math.max(1, Math.floor(settled[0] / pageSize)); page <= last; page++) {
      out.push(page);
    }
    return out;
  }, [settled, pageSize, total]);
  const rest = useQueries({
    queries: pages.map((page) => ({
      queryKey: [...queryKey, page],
      queryFn: () => fetchPage(page),
      enabled: enabled && !first.isPlaceholderData,
      staleTime: 60_000,
    })),
    combine: pageData<P>,
  });

  const items = useMemo(() => {
    const out: (T | undefined)[] = Array.from({ length: total }, () => undefined);
    const place = (page: number, data: P | undefined) => {
      if (!data) return;
      itemsOf(data).forEach((item, i) => {
        const index = page * pageSize + i;
        if (index < total) out[index] = item;
      });
    };
    place(0, first.data);
    for (const [i, page] of pages.entries()) place(page, rest[i]);
    return out;
  }, [first.data, rest, pages, total, pageSize, itemsOf]);

  return {
    /** Page 0: the total, aggregations and any totals it carries. */
    first,
    items,
    /** Every item the query matched, before `limit`. */
    matched: first.data ? totalOf(first.data) : 0,
    onRange,
    isFetching: first.isFetching || rest.some((data) => data === undefined),
  };
}
