// The sample-tiles plugin's UI: the Geology, Age, Intensity and Method Codes
// summary grid tiles (the legacy result card's cells), each over the
// `summary._all` columns the plugin's options name (README.md).
import { Cell, ClampedField, firstString, listOf, NoDataCell } from "@/components/result-item";
import { ageIntervalOf, ageIntervalTitle, formatAgeInterval } from "@/lib/age";
import type { NodeConfig, SearchResult } from "@/lib/types";
import { getPath } from "@/lib/utils";
import type { PluginModule } from "@/plugins";

/** The plugin's `frontend_config`: its options. */
interface SampleTilesConfig {
  geologic_class_columns: string[];
  geologic_type_columns: string[];
  lithology_columns: string[];
  age_columns: string[];
  age_unit_column: string;
  /** The node's interval the tile shows (`summary._interval.<name>`), when
   * `age_has_interval`; else the age columns as contributed. */
  age_interval: string;
  age_has_interval: boolean;
  intensity_columns: string[];
  method_code_columns: string[];
}

function tilesConfig(config: NodeConfig): SampleTilesConfig {
  return config.plugins["sample-tiles"] as unknown as SampleTilesConfig;
}

/** The values of the first of `columns` the record has (`?? ` between them). */
function firstOf(doc: SearchResult, columns: string[]): unknown {
  for (const column of columns) {
    const value = getPath(doc, `summary._all.${column}`);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** The union of `columns`' values. */
function unionOf(doc: SearchResult, columns: string[]): string[] {
  return columns.flatMap((column) => listOf(getPath(doc, `summary._all.${column}`)));
}

function rangeText(value: unknown): string {
  if (Array.isArray(value) && value.length > 0) {
    const numbers = value.map(Number).filter((n) => Number.isFinite(n));
    if (numbers.length === 0) return listOf(value).join(", ");
    const min = Math.min(...numbers);
    const max = Math.max(...numbers);
    return min === max ? String(min) : `${min} to ${max}`;
  }
  if (value === undefined || value === null) return "";
  return String(value);
}

/** Legacy intensity formatting: values are in Tesla; show nT/µT/mT/T. */
function formatIntensity(tesla: number): string {
  const nano = tesla * 1e9;
  const units: [number, string][] = [
    [1e9, "T"],
    [1e6, "mT"],
    [1e3, "µT"],
  ];
  for (const [threshold, unit] of units) {
    if (Math.abs(nano) >= threshold) return `${trimNumber(nano / threshold)} ${unit}`;
  }
  return `${trimNumber(nano)} nT`;
}

/** numeral "0[.]0[00]": up to three decimals, no trailing zeros. */
function trimNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}

const plugin: PluginModule = {
  gridCell({ column, hit: doc, config }) {
    const options = tilesConfig(config);
    const width = column.width;
    switch (column.cell) {
      // Class / Type / Lithology
      case "geology": {
        const classes = unionOf(doc, options.geologic_class_columns);
        const types = unionOf(doc, options.geologic_type_columns);
        const lithologies = unionOf(doc, options.lithology_columns);
        const defined = [classes, types, lithologies].filter((list) => list.length > 0).length;
        if (defined === 0) return <NoDataCell label="Geologic" width={width} />;
        const clamp = defined === 3 ? 1 : defined === 2 ? 2 : 5;
        return (
          <Cell width={width} wrap>
            {classes.length > 0 && (
              <ClampedField label="Class:" lines={clamp}>
                {classes.join(", ")}
              </ClampedField>
            )}
            {types.length > 0 && (
              <ClampedField label="Type:" lines={clamp}>
                {types.join(", ")}
              </ClampedField>
            )}
            {lithologies.length > 0 && (
              <ClampedField label="Lithology:" lines={clamp}>
                {lithologies.join(", ")}
              </ClampedField>
            )}
          </Cell>
        );
      }

      case "age": {
        if (options.age_has_interval) {
          // Every row's age in years BP, shown in one scale (lib/age.ts).
          const interval = ageIntervalOf(doc, options.age_interval);
          if (!interval) return <NoDataCell label="Age" width={width} />;
          return (
            <Cell width={width} wrap>
              <span title={ageIntervalTitle(interval)}>
                <b>Age:</b>
                <br />
                {formatAgeInterval(interval)}
              </span>
            </Cell>
          );
        }
        const age = rangeText(firstOf(doc, options.age_columns));
        if (!age) return <NoDataCell label="Age" width={width} />;
        const ageUnit = firstString(getPath(doc, `summary._all.${options.age_unit_column}`));
        return (
          <Cell width={width} wrap>
            <b>Age:</b>
            <br />
            {age}
            {ageUnit ? ` ${ageUnit}` : ""}
          </Cell>
        );
      }

      case "intensity": {
        const intensities = listOf(firstOf(doc, options.intensity_columns))
          .map(Number)
          .filter((n) => Number.isFinite(n));
        if (intensities.length === 0) return <NoDataCell label="Intensity" width={width} />;
        const min = Math.min(...intensities);
        const max = Math.max(...intensities);
        return (
          <Cell width={width} wrap>
            {min === max ? (
              <>
                <b>Int:</b>
                <br />
                {formatIntensity(min)}
                <br />
              </>
            ) : (
              <>
                <b>Min Int:</b>
                <br />
                {formatIntensity(min)}
                <br />
                <b>Max Int:</b>
                <br />
                {formatIntensity(max)}
                <br />
              </>
            )}
            <b>N: </b>
            {intensities.length}
          </Cell>
        );
      }

      case "method_codes": {
        const methodCodes = unionOf(doc, options.method_code_columns);
        if (methodCodes.length === 0)
          return (
            <NoDataCell
              label={
                <>
                  Method
                  <br />
                  Codes
                </>
              }
              width={width}
              dataWord={false}
            />
          );
        return (
          <Cell width={width} wrap>
            <ClampedField label="Method Codes:" lines={5}>
              {methodCodes.join(", ")}
            </ClampedField>
          </Cell>
        );
      }

      default:
        return null;
    }
  },
};

export default plugin;
