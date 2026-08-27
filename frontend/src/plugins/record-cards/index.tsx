import { Cell, DefinitionTable, NoDataCell, ResultCardFrame } from "../../components/result-item";
import type { NodeConfig, SearchLevel, SearchResult } from "../../lib/types";
import { getPath } from "../../lib/utils";
import type { PluginModule, PluginResultItemProps } from "../index";

/** One configured result cell, as sent by the backend plugin's frontend_config. */
interface CellDef {
  column: string;
  label: string;
  width: number;
  format?: "bytes";
}

interface CardDef {
  title_column: string;
  subtitle_column?: string;
  cells: CellDef[];
}

/** Cards keyed by the search table they apply to. */
type RecordCardsConfig = { cards?: Record<string, CardDef> };

function cardFor(config: NodeConfig, table: string): CardDef | undefined {
  const cards = (config.plugins["record-cards"] as RecordCardsConfig | undefined)?.cards;
  return cards?.[table];
}

function joined(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (value === undefined || value === null) return "";
  return String(value);
}

/** "2.20 MB" — a byte count as the legacy repositories render file sizes. */
function formatBytes(value: unknown): string {
  const bytes = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isFinite(bytes)) return joined(value);
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? size : size.toFixed(2)} ${units[unit]}`;
}

function cellText(block: Record<string, unknown>, def: CellDef): string {
  const value = block[def.column];
  return def.format === "bytes" ? formatBytes(value) : joined(value);
}

function RecordCard({
  hit,
  level,
  card,
  block,
}: {
  hit: SearchResult;
  level: SearchLevel;
  card: CardDef;
  block: Record<string, unknown>;
}) {
  const title = joined(block[card.title_column]) || "Untitled";
  const subtitle = card.subtitle_column ? joined(block[card.subtitle_column]) : "";
  return (
    <ResultCardFrame
      doc={hit}
      level={level}
      cells={
        <>
          <Cell width={300} wrap>
            <b>{title}</b>
            {subtitle && (
              <p className="m-0 overflow-hidden text-gray-600" style={{ maxHeight: "4.5em" }}>
                {subtitle}
              </p>
            )}
          </Cell>
          {card.cells.map((def) => {
            const text = cellText(block, def);
            return text ? (
              <Cell key={def.column} width={def.width} wrap>
                <b>{def.label}:</b>
                <br />
                {text}
              </Cell>
            ) : (
              <NoDataCell key={def.column} label={def.label} width={def.width} />
            );
          })}
        </>
      }
      expanded={<DefinitionTable data={block} />}
    />
  );
}

function resultItem({ hit, level, config }: PluginResultItemProps) {
  const card = cardFor(config, level.table);
  if (!card) return null;
  const block = getPath(hit, `summary.${level.table}`) as Record<string, unknown> | undefined;
  if (!block) return null;
  return <RecordCard hit={hit} level={level} card={card} block={block} />;
}

export const recordCardsPlugin: PluginModule = { resultItem };
