# pmag-lab-formats

Lab instrument files converted to MagIC text in the upload page's import step,
by PmagPy's `convert_2_magic` converters (what pmag_gui's "convert" step and
the `*_magic.py` command-line programs run). A contributor drops a magnetometer
file on the upload page; the import step recognises it, converts it on the
server and shows the converted measurements, specimens, samples, sites and
locations tables as its sheets, exactly as if a MagIC text file had been
uploaded, with the converter's options above them.

It is the first user of the core `import_formats` plugin hook (docs/plugins.md
"Import formats"; routes in docs/api.md).

## Formats

| Key | Converter | Files | Picked when |
|---|---|---|---|
| `pmag-generic` | `generic` | PmagPy's generic tab-delimited file | the header has `specimen`, `treatment`, `treatment_type`, `moment` |
| `pmag-2g-bin` | `_2g_bin` | 2G binary `.dat`, one specimen per file | `.dat` with NUL bytes |
| `pmag-2g-asc` | `_2g_asc` | 2G ASCII `.asc` | `.asc` with a `NAME\tSIZE…` header and `DEMAG` |
| `pmag-cit` | `cit` | a CIT `.sam` file **and the specimen files it lists** (multi-file) | `.sam`; its listed files are read with it |
| `pmag-sio` | `sio` | SIO measurement files | six numeric-ish columns per line, `.dat`/`.sio` |
| `pmag-jr6` | `jr6_jr6` | AGICO JR6 `.jr6` | `.jr6` |
| `pmag-jr6-txt` | `jr6_txt` | AGICO JR6 Rema6 `.txt` | `SPEC.ANGLES` and `TECT.ANGLES` |
| `pmag-utrecht` | `utrecht` | Utrecht `.af`/`.th`/`.tt` | the extension and a comma-separated specimen line |
| `pmag-ldeo` | `ldeo` | LDEO measurement files | a `LAT:` line and a `TREAT` header |
| `pmag-huji` | `huji` | HUJI (new format) | tab-separated rows with a date and a time |

Each format's options are its converter's arguments, under PmagPy's names, with
titles and descriptions for the form: the sample naming convention (`samp_con`,
with `samp_con_chars` for conventions 4-Z and 7-Z), specimen characters
(`specnum`), location, latitude and longitude, lab protocols (`codelist`, SIO,
LDEO, HUJI), orientation convention (2G), lab field and its direction,
replicates (`noave`), analyst, instrument. Not exposed: LDEO's ARM/TRM fields,
HUJI's orientation `datafile`, 2G's `savelast`, and each converter's output file
names. Formats not wrapped yet: AGM, BGC, IODP (SRM, JR6, DSCR, KLY4S), K15,
KLY4S, LIVDB, MINI, MST, PMD, SUFAR4, TDT, VFTB, IRM, XPEEM; each is
one `PmagFormat` subclass with an options model and a sniffer.

## Report

The response's notes (and `<file>-conversion-report.txt`, kept beside the
original files in the upload):

- **Converter output**: `-W-`/`-E-` lines and other lines naming a warning or an
  error, repeats counted, temporary paths removed; `-I-` progress lines and debug
  prints dropped. At most 40 distinct messages.
- **Defaults**: the options that shape the hierarchy (sample naming convention,
  location, lab protocols, the generic format's naming and experiment) the
  contributor left at their default.
- **Hint**: every specimen its own sample and its own site (`42 specimens -> 42
  samples -> 42 sites`), the usual sign of a naming convention that does not
  fit the names.
- The converter (`PmagPy <version> convert_2_magic.<function>`), the files and
  the options used.

## Options (node YAML `plugins.pmag-lab-formats`)

| Option | Default | |
|---|---|---|
| `formats` | every key above | the formats the import step offers |

## Notes

- PmagPy runs offline (`pmag_env.set_env.OFFLINE = True`): its bundled data
  model and method codes, not a download from earthref.org per conversion.
- The converters print to stdout and keep module state, so one conversion runs
  at a time per API process (a lock); a conversion of a typical file takes well
  under a second.
- `fixtures/` holds small files trimmed from PmagPy's `data_files/convert_2_magic`
  examples (published data; PmagPy is BSD-3-Clause), one per format.
- A UI half is not needed: the core upload wizard renders the options from the
  JSON schema (`fiesta/frontend/src/components/lab-format-options.tsx`).
