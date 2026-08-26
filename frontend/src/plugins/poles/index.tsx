import { Cell, DefinitionTable, NoDataCell, ResultCardFrame } from "../../components/result-item";
import type { NodeConfig, SearchLevel, SearchResult } from "../../lib/types";
import { getPath } from "../../lib/utils";
import type { PluginModule, PluginResultItemProps, PluginSubTabContext } from "../index";

function firstNumber(value: unknown): number | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  const n = Number(candidate);
  return Number.isFinite(n) ? n : undefined;
}

/** Normalize a longitude to -180..180. */
function normalizeLon(lon: number): number {
  let result = lon % 360;
  if (result > 180) result -= 360;
  if (result < -180) result += 360;
  return result;
}

function formatLat(lat: number): string {
  return `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? "N" : "S"}`;
}

function formatLon(lon: number): string {
  const normalized = normalizeLon(lon);
  return `${Math.abs(normalized).toFixed(1)}°${normalized >= 0 ? "E" : "W"}`;
}

interface Pole {
  lat?: number;
  lon?: number;
  alpha95?: number;
  age?: number;
  ageUnit?: string;
  name: string;
}

function poleOf(hit: SearchResult): Pole {
  const block = getPath(hit, "summary.locations") as Record<string, unknown> | undefined;
  return {
    lat: firstNumber(block?.pole_lat),
    lon: firstNumber(block?.pole_lon),
    alpha95: firstNumber(block?.pole_alpha95),
    age: firstNumber(block?.age ?? block?.pole_age),
    ageUnit:
      typeof block?.age_unit === "string"
        ? block.age_unit
        : Array.isArray(block?.age_unit)
          ? String(block.age_unit[0])
          : undefined,
    name:
      (typeof block?.location === "string" && block.location) ||
      (Array.isArray(block?.location) && String(block.location[0])) ||
      "Pole",
  };
}

function PolesResultItem({ hit, level }: { hit: SearchResult; level: SearchLevel }) {
  const pole = poleOf(hit);
  const locationBlock = getPath(hit, "summary.locations");

  const cells = (
    <>
      {pole.lat !== undefined ? (
        <Cell width={125} wrap>
          <b>Pole Latitude:</b>
          <br />
          {formatLat(pole.lat)}
        </Cell>
      ) : (
        <NoDataCell label="Pole Latitude" width={125} />
      )}
      {pole.lon !== undefined ? (
        <Cell width={125} wrap>
          <b>Pole Longitude:</b>
          <br />
          {formatLon(pole.lon)}
        </Cell>
      ) : (
        <NoDataCell label="Pole Longitude" width={125} />
      )}
      {pole.alpha95 !== undefined ? (
        <Cell width={100} wrap>
          <b>Alpha95:</b>
          <br />
          {pole.alpha95}°
        </Cell>
      ) : (
        <NoDataCell label="Alpha95" width={100} />
      )}
      {pole.age !== undefined ? (
        <Cell width={120} wrap>
          <b>Age:</b>
          <br />
          {pole.age}
          {pole.ageUnit ? ` ${pole.ageUnit}` : ""}
        </Cell>
      ) : (
        <NoDataCell label="Age" width={120} />
      )}
    </>
  );

  const expanded =
    typeof locationBlock === "object" && locationBlock !== null ? (
      <DefinitionTable data={locationBlock as Record<string, unknown>} />
    ) : undefined;

  return (
    <ResultCardFrame
      doc={hit}
      level={level}
      cells={cells}
      expanded={expanded}
      collapsedMaxHeight={155}
    />
  );
}

/** Dependency-free equirectangular pole map (x -180..180, y -90..90, 30° grid). */
function PolesMap({ hits }: PluginSubTabContext) {
  const poles = hits.map(poleOf).filter((pole) => pole.lat !== undefined && pole.lon !== undefined);

  const gridlines: number[] = [];
  for (let deg = -180; deg <= 180; deg += 30) gridlines.push(deg);

  return (
    <div className="py-3">
      <svg
        viewBox="-180 -90 360 180"
        className="w-full max-w-3xl border border-gray-300 bg-white"
        role="img"
        aria-label={`Equirectangular map of ${poles.length} poles`}
      >
        {gridlines.map((deg) => (
          <line
            key={`lon-${deg}`}
            x1={deg}
            y1={-90}
            x2={deg}
            y2={90}
            stroke="#e5e7eb"
            strokeWidth={0.5}
          />
        ))}
        {gridlines
          .filter((deg) => deg >= -90 && deg <= 90)
          .map((deg) => (
            <line
              key={`lat-${deg}`}
              x1={-180}
              y1={deg}
              x2={180}
              y2={deg}
              stroke={deg === 0 ? "#d1d5db" : "#e5e7eb"}
              strokeWidth={deg === 0 ? 0.75 : 0.5}
            />
          ))}
        {poles.map((pole, index) => {
          const x = normalizeLon(pole.lon as number);
          const y = -(pole.lat as number);
          const radius = Math.min(15, Math.max(1, pole.alpha95 ?? 2));
          return (
            <circle
              // biome-ignore lint/suspicious/noArrayIndexKey: poles have no unique id; the set is static per search page
              key={`pole-${index}`}
              cx={x}
              cy={y}
              r={radius}
              fill="var(--node-color)"
              fillOpacity={0.5}
              stroke="var(--node-color)"
              strokeWidth={0.5}
            >
              <title>
                {pole.name}: {formatLat(pole.lat as number)}, {formatLon(pole.lon as number)}
                {pole.alpha95 !== undefined ? ` (α95 ${pole.alpha95}°)` : ""}
              </title>
            </circle>
          );
        })}
      </svg>
      {poles.length === 0 && (
        <p className="mt-2 text-[13px] text-gray-500">No poles with coordinates on this page.</p>
      )}
    </div>
  );
}

function polesFilters(config: NodeConfig): string[] | null {
  const filters = config.plugins.poles?.filters;
  return Array.isArray(filters) ? filters.map(String) : ["age", "geospatial"];
}

export const polesPlugin: PluginModule = {
  resultItem(props: PluginResultItemProps) {
    if (props.level.table !== "poles") return null;
    return <PolesResultItem hit={props.hit} level={props.level} />;
  },
  levelSubTabs(level) {
    if (level.table !== "poles") return [];
    return [{ name: "Poles Map", render: (ctx) => <PolesMap {...ctx} /> }];
  },
  filtersOverride(levelName, config) {
    const polesLevel = config.search_levels.find((entry) => entry.table === "poles");
    if (!polesLevel || polesLevel.name !== levelName) return null;
    return polesFilters(config);
  },
};
