/**
 * Lab formats in the upload page's import step: files a node's plugins
 * convert to its text format on the server (instrument output; MagIC's are
 * PmagPy's converters, the pmag-lab-formats plugin). GET /import-formats
 * lists them with their options' JSON schema, POST /import-formats/sniff
 * recognises files, POST /import-formats/{key}/convert converts them
 * (fiesta.services.import_formats). The converted text is read into sheets
 * like a node text file the contributor uploaded.
 */
import type { JsonSchema } from "./admin";
import { ApiError, api } from "./api";
import { readBlocks, type Sheet } from "./importer";

export interface LabFormat {
  key: string;
  label: string;
  description: string;
  extensions: string[];
  multi_file: boolean;
  plugin: string;
  options_schema: JsonSchema;
}

export interface LabNote {
  level: "error" | "warning" | "info";
  /** converter: what the tool printed; default: an option left at a default
   * that shapes the result; hint: something worth a second look. */
  kind: "converter" | "default" | "hint";
  message: string;
  count: number;
}

export interface LabConversion {
  format: string;
  label: string;
  plugin: string;
  files: string[];
  tool: { name?: string; version?: string; function?: string };
  options: Record<string, unknown>;
  options_set: string[];
  text: string;
  tables: Record<string, number>;
  /** Row counts of the node's hierarchy tables, top first. */
  hierarchy: { table: string; count: number }[];
  notes: LabNote[];
  report_text: string;
}

/** A lab format in the import file-type menu ("lab:<key>"), beside the
 * browser-read formats. */
export type LabFormatKey = `lab:${string}`;
export const labFormatKey = (key: string): LabFormatKey => `lab:${key}`;
export const isLabFormat = (format: string): format is LabFormatKey => format.startsWith("lab:");
export const labKey = (format: LabFormatKey): string => format.slice(4);

export const labFormatsQuery = {
  queryKey: ["import-formats"],
  queryFn: () => api<LabFormat[]>("/import-formats"),
  staleTime: Number.POSITIVE_INFINITY,
};

interface NamedBytes {
  name: string;
  bytes: ArrayBuffer;
}

/** How a file is read as a lab format: the options the contributor set, the
 * files its conversion reads with it, or (a companion) the file whose
 * conversion reads it. */
export interface LabSettings {
  options: Record<string, unknown>;
  companions: NamedBytes[];
  companionOf: string | null;
}
export const NO_LAB: LabSettings = { options: {}, companions: [], companionOf: null };

const HEAD_BYTES = 16384;

async function toBase64(bytes: ArrayBuffer): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes]));
  });
  return url.slice(url.indexOf(",") + 1);
}

interface Sniffed {
  name: string;
  format: string | null;
  confidence: number;
  companion_of: string | null;
}

export interface SniffResult {
  autoPick: number;
  byName: Map<string, Sniffed>;
}

/** What the server recognises among picked files (their first 16 KB). */
export async function sniffLabFormats(files: NamedBytes[]): Promise<SniffResult> {
  const body = {
    files: await Promise.all(
      files.map(async (f) => ({
        name: f.name,
        head: await toBase64(f.bytes.slice(0, HEAD_BYTES)),
      })),
    ),
  };
  const out = await api<{ auto_pick: number; files: Sniffed[] }>("/import-formats/sniff", {
    method: "POST",
    json: body,
  });
  return { autoPick: out.auto_pick, byName: new Map(out.files.map((f) => [f.name, f])) };
}

/** A picked file's lab format, when the sniff is sure of it (or it is read
 * with another file), with the companions its conversion reads; else null. */
export function sniffedLab(
  name: string,
  files: NamedBytes[],
  sniffed: SniffResult | null,
): { format: LabFormatKey; settings: LabSettings } | null {
  const found = sniffed?.byName.get(name);
  if (!sniffed || !found?.format) return null;
  if (!found.companion_of && found.confidence < sniffed.autoPick) return null;
  const companions = files.filter((f) => sniffed.byName.get(f.name)?.companion_of === name);
  return {
    format: labFormatKey(found.format),
    settings: { options: {}, companions, companionOf: found.companion_of },
  };
}

/** A file read as a lab format: converted on the server with its companions
 * and options, its sheets the converted text's. A companion has none. */
export async function readLabFile(
  format: LabFormatKey,
  file: NamedBytes,
  settings: LabSettings,
): Promise<{ sheets: Sheet[]; lab: LabConversion | null; error: string | null }> {
  if (settings.companionOf) return { sheets: [], lab: null, error: null };
  try {
    const files = await Promise.all(
      [file, ...settings.companions].map(async (f) => ({
        name: f.name,
        data: await toBase64(f.bytes),
      })),
    );
    const lab = await api<LabConversion>(
      `/import-formats/${encodeURIComponent(labKey(format))}/convert`,
      { method: "POST", json: { files, options: settings.options } },
    );
    const sheets = readBlocks(lab.text);
    return { sheets, lab, error: sheets.length ? null : "The conversion has no tables to import." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Converting is a contributor action on the server: it needs a login.
    const signedOut = error instanceof ApiError && error.status === 401;
    return {
      sheets: [],
      lab: null,
      error: signedOut
        ? "Lab files are converted on the server: log in to convert this file."
        : `Failed to convert this file: ${message}`,
    };
  }
}

/** The name of a converted file's report, kept beside it as an attachment. */
export const conversionReportName = (name: string) =>
  `${name.replace(/\.[^.]*$/, "")}-conversion-report.txt`;
