// The GEOMAGIA site's geography refinements as sidebar filters: a name search
// (any part of the name, ignoring case: a `<column>:"*text*"` query token) and
// a radius search (records within a great-circle distance of a centre: the
// search API's `radius:"<lat>,<lon>,<km>"` token).
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { type FilterChip, FilterEntry } from "@/components/search-filters";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { api } from "@/lib/api";
import type { SearchPage } from "@/lib/types";
import { buildQuery, parseQueryTokens, queryWithout } from "@/lib/utils";
import type { PluginFilterContext } from "@/plugins";

export const RADIUS_TOKEN = "radius";
/** The site's defaults and limit: 500 km, at most half way round (π·6371 km). */
const DEFAULT_RADIUS_KM = 500;
const MAX_RADIUS_KM = Math.PI * 6371;
/** Suggested names, as many as the site's list. */
const SUGGESTIONS = 30;

const inputClass =
  "rounded-sm border border-gray-300 bg-surface px-[0.8em] py-[0.45em] text-[13px] " +
  "placeholder:text-ink-faint focus:border-node focus:outline-hidden";

/** The query with `field`'s tokens replaced by `values`. */
function withTokens(q: string, field: string, values: string[]): string {
  const { tokens, freeText } = parseQueryTokens(queryWithout(q, [field]));
  return buildQuery(freeText, [...tokens, ...values.map((v) => [field, v] as [string, string])]);
}

function tokensOf(q: string, field: string): string[] {
  return parseQueryTokens(q)
    .tokens.filter(([f]) => f === field)
    .map(([, value]) => value);
}

/** A typed name as a contains-pattern (the token's `*` wildcards). */
const pattern = (text: string) => `*${text.replace(/[*"]/g, " ").trim()}*`;
const typedOf = (value: string) => value.replace(/^\*|\*$/g, "");

export function NameSearchFilter({
  ctx,
  column,
  label,
}: {
  ctx: PluginFilterContext;
  column: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const picked = tokensOf(ctx.q, column);
  const chips: FilterChip[] = picked.map((value) => ({
    key: value,
    label: value.includes("*") ? `contains “${typedOf(value)}”` : value,
    onRemove: () =>
      ctx.setQuery(
        withTokens(
          ctx.q,
          column,
          picked.filter((v) => v !== value),
        ),
      ),
  }));
  return (
    <>
      <FilterEntry
        label={label}
        count={"filterCount" in ctx ? ctx.filterCount : null}
        chips={chips}
        onOpen={() => setOpen(true)}
      />
      {open && (
        <NameSearchModal
          ctx={ctx}
          column={column}
          label={label}
          initial={picked.length === 1 ? typedOf(picked[0]) : ""}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function NameSearchModal({
  ctx,
  column,
  label,
  initial,
  onClose,
}: {
  ctx: PluginFilterContext;
  column: string;
  label: string;
  initial: string;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const listId = useId();
  const typed = text.trim();
  // Names matching what is typed, in the search without this filter's own.
  const params = ctx.paramsFor(withTokens(ctx.q, column, typed ? [pattern(typed)] : []));
  const names = useQuery({
    queryKey: ["geomag-series", "names", ctx.table, column, params],
    queryFn: () =>
      api<SearchPage>(`/search/${ctx.table}`, {
        params: { ...params, size: 1, facet: [column], facet_size: SUGGESTIONS },
      }),
    staleTime: 60_000,
  });
  const suggestions = (names.data?.aggregations?.[column] ?? [])
    .map((bucket) => bucket.key)
    .sort((a, b) => a.localeCompare(b));
  const apply = (value: string) => {
    const name = value.trim();
    ctx.setQuery(withTokens(ctx.q, column, name ? [pattern(name)] : []));
    onClose();
  };
  return (
    <Modal
      open
      wide
      largeTitle
      onClose={onClose}
      title={label}
      footer={
        <>
          <Button variant="ghost" className="mr-auto" onClick={() => setText("")} disabled={!text}>
            Clear
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => apply(text)} disabled={typed === initial}>
            Apply
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px] text-ink">
        <label className="flex flex-col gap-1">
          <span className="font-bold">Contains</span>
          <input
            type="search"
            value={text}
            list={listId}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") apply(text);
            }}
            placeholder="Any part of the name"
            className={inputClass}
          />
          <datalist id={listId}>
            {suggestions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
        <p className="text-ink-muted">
          Enter any part of a name; matching ignores case. Suggestions follow the search's other
          filters.
        </p>
        {typed && names.data && (
          <p className="text-ink-muted">
            {names.data.total.toLocaleString()} matching{" "}
            {names.data.total === 1 ? "record" : "records"}.
          </p>
        )}
      </div>
    </Modal>
  );
}

interface Circle {
  lat: number;
  lon: number;
  km: number;
}

function circleOf(value: string): Circle | null {
  const [lat, lon, km] = value.split(",").map(Number);
  return [lat, lon, km].every(Number.isFinite) ? { lat, lon, km } : null;
}

export function RadiusFilter({ ctx, label }: { ctx: PluginFilterContext; label: string }) {
  const [open, setOpen] = useState(false);
  const picked = tokensOf(ctx.q, RADIUS_TOKEN);
  const chips: FilterChip[] = picked.map((value) => {
    const circle = circleOf(value);
    return {
      key: value,
      label: circle ? `${circle.km} km of ${circle.lat}°, ${circle.lon}°` : value,
      title: "Records within this great-circle distance of the centre",
      onRemove: () =>
        ctx.setQuery(
          withTokens(
            ctx.q,
            RADIUS_TOKEN,
            picked.filter((v) => v !== value),
          ),
        ),
    };
  });
  return (
    <>
      {/* Counted as positioned records by no one: no count shown. */}
      <FilterEntry label={label} count={null} chips={chips} onOpen={() => setOpen(true)} />
      {open && (
        <RadiusModal
          ctx={ctx}
          label={label}
          initial={picked.length === 1 ? circleOf(picked[0]) : null}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function RadiusModal({
  ctx,
  label,
  initial,
  onClose,
}: {
  ctx: PluginFilterContext;
  label: string;
  initial: Circle | null;
  onClose: () => void;
}) {
  const [lat, setLat] = useState(initial ? String(initial.lat) : "");
  const [lon, setLon] = useState(initial ? String(initial.lon) : "");
  const [km, setKm] = useState(String(initial?.km ?? DEFAULT_RADIUS_KM));
  const [nLat, nLon, nKm] = [lat, lon, km].map((v) => (v.trim() === "" ? Number.NaN : Number(v)));
  const problems = [
    lat.trim() !== "" && !(nLat >= -90 && nLat <= 90) && "The centre latitude is −90 to 90°.",
    lon.trim() !== "" && !(nLon >= -180 && nLon <= 360) && "The centre longitude is −180 to 360°.",
    !(nKm > 0 && nKm <= MAX_RADIUS_KM) &&
      `The radius is more than 0 and at most ${Math.round(MAX_RADIUS_KM).toLocaleString()} km.`,
    (lat.trim() === "") !== (lon.trim() === "") && "Enter both a centre latitude and longitude.",
  ].filter((p): p is string => !!p);
  const complete = lat.trim() !== "" && lon.trim() !== "" && problems.length === 0;
  const apply = () => {
    ctx.setQuery(withTokens(ctx.q, RADIUS_TOKEN, complete ? [`${nLat},${nLon},${nKm}`] : []));
    onClose();
  };
  const field = (name: string, value: string, set: (v: string) => void, hint: string) => (
    <label className="flex flex-col gap-1">
      <span className="font-bold">{name}</span>
      <input
        type="number"
        inputMode="decimal"
        value={value}
        onChange={(event) => set(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (complete || (!lat && !lon))) apply();
        }}
        placeholder={hint}
        className={inputClass}
      />
    </label>
  );
  return (
    <Modal
      open
      wide
      largeTitle
      onClose={onClose}
      title={label}
      footer={
        <>
          <Button
            variant="ghost"
            className="mr-auto"
            onClick={() => {
              setLat("");
              setLon("");
              setKm(String(DEFAULT_RADIUS_KM));
            }}
            disabled={!lat && !lon}
          >
            Clear
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={!complete && !!(lat || lon)}>
            Apply
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px] text-ink">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {field("Centre latitude (°)", lat, setLat, "e.g. 45.5")}
          {field("Centre longitude (°)", lon, setLon, "e.g. 10.2")}
          {field("Radius (km)", km, setKm, String(DEFAULT_RADIUS_KM))}
        </div>
        {problems.map((problem) => (
          <p key={problem} className="text-red-700">
            {problem}
          </p>
        ))}
        <p className="text-ink-muted">
          Records whose site is within this great-circle distance of the centre (a spherical Earth
          of radius 6,371 km).
        </p>
      </div>
    </Modal>
  );
}
