/**
 * Step 1 of the upload page: the lab instrument formats the node's plugins
 * convert on the server (lib/lab-formats), so a contributor knows their
 * instrument's files can be dropped as they are, with an example of each to
 * try or download. Nothing here when the node's plugins offer none.
 */
import type { LabFormat } from "../lib/lab-formats";
import { Button } from "./ui/button";

export function LabFormatList({
  formats,
  nodeKey,
  onTry,
  onDownload,
}: {
  formats: LabFormat[];
  /** The node's name, for "converted to MagIC tables". */
  nodeKey: string;
  onTry: (format: LabFormat) => void;
  onDownload: (format: LabFormat) => void;
}) {
  if (formats.length === 0) return null;
  return (
    <section aria-labelledby="lab-formats-heading" className="text-[13px]">
      <h4 id="lab-formats-heading" className="mb-1 text-[13px] font-bold text-gray-800">
        Or import files straight from a lab instrument:
      </h4>
      <p className="m-0 text-gray-600">
        Drop the instrument's files above as they are. They are recognised and converted to{" "}
        {nodeKey} tables on the server, and the next step shows the converted tables with the
        converter's options (sample naming, location, lab protocols, …) above them. The original
        files and a conversion report are kept with the upload.
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer font-semibold text-node-ink">
          {formats.length} instrument {formats.length === 1 ? "format" : "formats"}
          {formats.some((f) => f.example.length > 0) && ", with examples to try"}
        </summary>
        <ul className="m-0 mt-1 list-none p-0">
          {formats.map((format) => (
            <li
              key={format.key}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-gray-200 py-2 first:border-t-0"
            >
              <span className="font-semibold text-gray-900">{format.label}</span>
              {format.extensions.length > 0 && (
                <span className="font-mono text-[12px] text-gray-600">
                  {format.extensions.join(" ")}
                  {format.multi_file && " + the files it lists"}
                </span>
              )}
              {format.example.length > 0 && (
                <span className="ml-auto flex gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onTry(format)}
                    title={`Import the example (${format.example.join(", ")}). You can always delete it later.`}
                  >
                    Try the example
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onDownload(format)}
                    title={`Download ${format.example.join(", ")}`}
                  >
                    Download
                  </Button>
                </span>
              )}
              {format.description && (
                <span className="w-full text-[12px] text-gray-600">{format.description}</span>
              )}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
