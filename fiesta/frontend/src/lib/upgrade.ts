/**
 * Contributions written against an older data-model version (legacy MagIC
 * upgrade_contribution.jsx): POST /upgrade runs the server's upgrade engine
 * (fiesta.domain.upgrade) and returns the text in the node's latest version
 * with a report of what was renamed, merged, dropped or filled.
 */
import { api } from "./api";
import { readBlocks } from "./importer";
import type { DataModel } from "./types";

export interface UpgradeNote {
  level: "error" | "warning" | "info";
  /** renamed | merged | dropped_column | dropped_value | dropped_row |
   * dropped_table | unknown_table | unknown_column | converted | conversion |
   * merged_rows | collision | version */
  kind: string;
  message: string;
  step: string;
  table: string | null;
  column: string | null;
  to: string[];
  count: number;
}

/** A value the old model documented for a blank cell, which the upgrade
 * fills only when `on` (MagIC #521). */
export interface BlankDefault {
  key: string;
  label: string;
  on: boolean;
  /** Blank cells it fills (or would fill). */
  count: number;
  step: string;
}

export interface UpgradeReport {
  from_version: string;
  to_version: string;
  guessed: boolean;
  steps: string[];
  notes: UpgradeNote[];
  defaults: BlankDefault[];
  rows_in: Record<string, number>;
  rows_out: Record<string, number>;
}

export interface UpgradeResult {
  upgraded: boolean;
  from_version: string | null;
  to_version: string;
  guessed: boolean;
  text: string | null;
  report: UpgradeReport | null;
  report_text: string | null;
}

export interface UpgradeOptions {
  /** Columns and tables the old model does not define (MagIC #308). */
  unknown_columns?: "keep" | "drop";
  /** "table.column" -> new name ("" drops it), before upgrading. */
  renames?: Record<string, string>;
  /** BlankDefault.key -> on/off. */
  defaults?: Record<string, boolean>;
}

const VERSION_COLUMNS = ["data_model_version", "magic_version"];

/** Whether the node's multi-table text looks older than `latest`: a table
 * the latest model lacks, or a contribution table naming another version.
 * The server decides; this only saves a request for current files. */
export function mayNeedUpgrade(text: string, model: DataModel | null, latest: string): boolean {
  for (const sheet of readBlocks(text)) {
    if (!sheet.tableName) continue;
    if (model && !model.tables[sheet.tableName]) return true;
    if (sheet.tableName === "contribution") {
      const columns = sheet.rows[1] ?? [];
      const values = sheet.rows[2] ?? [];
      for (const name of VERSION_COLUMNS) {
        const value = values[columns.indexOf(name)]?.trim();
        if (columns.includes(name) && value && value !== latest) return true;
      }
    }
  }
  return false;
}

export function upgradeText(text: string, options: UpgradeOptions = {}): Promise<UpgradeResult> {
  return api<UpgradeResult>("/upgrade", { method: "POST", json: { text, ...options } });
}

/** The report's notes by level, then kind. */
export function notesByLevel(report: UpgradeReport): Record<UpgradeNote["level"], UpgradeNote[]> {
  const out: Record<UpgradeNote["level"], UpgradeNote[]> = { error: [], warning: [], info: [] };
  for (const note of report.notes) out[note.level].push(note);
  return out;
}
