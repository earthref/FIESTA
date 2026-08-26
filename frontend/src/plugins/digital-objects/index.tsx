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

interface DigitalObjectsConfig {
  object_table?: string;
  object_title_column?: string;
  file_table?: string;
  file_title_column?: string;
  object_cells?: CellDef[];
  file_cells?: CellDef[];
}

function pluginConfig(config: NodeConfig): DigitalObjectsConfig {
  return (config.plugins["digital-objects"] ?? {}) as DigitalObjectsConfig;
}

function joined(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (value === undefined || value === null) return "";
  return String(value);
}

/** "2.2 MB" — the legacy ERDA file-size rendering, from a byte count. */
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

function ArchiveResultItem({
  hit,
  level,
  cells,
  title,
  subtitle,
}: {
  hit: SearchResult;
  level: SearchLevel;
  cells: CellDef[];
  title: string;
  subtitle?: string;
}) {
  const block = (getPath(hit, `summary.${level.table}`) ?? {}) as Record<string, unknown>;
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
          {cells.map((def) => {
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
  const pconfig = pluginConfig(config);
  const block = getPath(hit, `summary.${level.table}`) as Record<string, unknown> | undefined;
  if (!block) return null;

  if (level.table === pconfig.object_table) {
    const titleColumn = pconfig.object_title_column ?? "title";
    return (
      <ArchiveResultItem
        hit={hit}
        level={level}
        cells={pconfig.object_cells ?? []}
        title={joined(block[titleColumn]) || joined(block.object) || "Untitled object"}
        subtitle={joined(block.description)}
      />
    );
  }

  if (level.table === pconfig.file_table) {
    const titleColumn = pconfig.file_title_column ?? "file";
    return (
      <ArchiveResultItem
        hit={hit}
        level={level}
        cells={pconfig.file_cells ?? []}
        title={joined(block[titleColumn]) || "Untitled file"}
        subtitle={joined(block.description) || joined(block.title)}
      />
    );
  }

  return null;
}

export const digitalObjectsPlugin: PluginModule = { resultItem };
