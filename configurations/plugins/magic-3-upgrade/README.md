# magic-3-upgrade

The MagIC 2.5 → 3.0 upgrade step (legacy `lib/modules/magic/upgrade_contribution.js`):
the restructuring of data model 3.0 that the models' `previous_columns` cannot
express. The core engine (`fiesta.domain.upgrade`) walks the version chain
(2.2 → 2.3 → 2.4 → 2.5 → 3.0), renames, moves, splits and merges columns from
`previous_columns`, merges the rows that describe one entity and reports
everything; this plugin's `UpgradeStep` adds, for the 2.5 → 3.0 step only:

- **Results by level.** A `pmag_results` / `rmag_results` row goes to the
  table of its most specific singular name (synthetic, specimen, sample, site,
  location); a row naming only plural lists is a contribution-level result, which
  3.0 does not have, and is dropped with a warning. A row with directions in
  several coordinate systems or polarities becomes one row per direction
  (stratigraphic `average_*` → tilt correction 100, `tilt_*_uncorr` → 0,
  `normal_*` / `reversed_*` → `dir_polarity` n / r).
- **Criteria.** The wide `pmag_criteria` row becomes one `criteria` row per
  criterion through the 3.0 model's `criteria_map`; `-999` means "not used".
- **Method codes.** Upper-cased, the 3.0 renames applied (`method_code_renames`),
  `IE-ARM`/`IE-IRM`/`IE-CHI` moved into `int_rel_ARM`/`_IRM`/`_chi`, direction
  types and geoids turned into `DE-BFL`/`DE-BFP` and `GE-<geoid>`.
- **Combined columns.** Pole confidence ellipses, anisotropy tensors and
  eigenparameters into their 3.0 list columns; `external_database_names/ids` into
  `NAME[id]` dictionaries; location begin/end latitudes and longitudes into
  `lat_s`/`lat_n`/`lon_w`/`lon_e` by value.
- **Dates.** 2.5 `YYYY:MM:DD:hh:mm:ss` dates in their `*_time_zone`
  (`time_zones` maps 2.5 spellings to IANA zones) into ISO 8601 UTC timestamps.
- **Names and hierarchy.** Natural synthetics are named by their synthetic name;
  measurements create the specimens, samples, sites and locations they name; a
  measurement number below 1000 becomes the treatment step index and, with the
  experiment name, the measurement name; `sequence` numbers the measurements in
  file order.
- **Ages.** Sample, specimen and result ages are adopted up to their site.
- **Expeditions.** Repeated for each location they list (or every location) so
  they join `locations`.
- **Retired tables.** `magic_methods`, `er_citations`, `er_mailinglist`,
  `magic_calibrations` and `magic_instruments` are dropped with an info note.

## Blank defaults (MagIC #521)

Data model 2.5 documented a meaning for some blank cells ("g, the default");
3.0 has no defaults. Each is a choice the contributor makes in the upgrade
report (the upload page's import step and the Upgrade page re-run the upgrade);
the report counts the blanks each one fills or leaves:

| Key | Fills | Default |
|---|---|---|
| `result_quality` | blank 2.5 result flags → `g` | on |
| `result_type` | blank `pmag_results.data_type` → `i` | on |
| `measurement_quality` | blank `measurement_flag` → `g` (3.0 requires a quality) | on |
| `orientation_quality` | blank orientation flag of an oriented sample → `g` | on |
| `direction_type` | a direction without `DE-BFL`/`DE-BFP` → `DE-BFL` | on |
| `int_corr` | blank `specimen_correction` of an intensity → `u` | on |
| `int_scat` | blank `specimen_scat` of Arai statistics → `t` | on |
| `dir_polarity` | blank polarity of a direction → `n` | **off** (MagIC #295, #374) |
| `dir_nrm_origin` | blank NRM origin of a direction → `p` | **off** (MagIC #296) |
| `dir_tilt_correction` | blank tilt correction of a tilt-corrected direction → `-3` | **off** (MagIC #521) |

## Fixed against the legacy upgrade

Pinned by `test_magic_3_upgrade.py`: no invented polarities, NRM origins or tilt
corrections (#295, #296, #374, #521); measurements get a `sequence` (#374) and
the quality 3.0 requires; values a level cannot hold (specimen VGPs, a
specimen result's `data_type`) are reported, not silently dropped (#342); dates
are read as 24-hour times and a value that is not a date is kept and reported
instead of becoming "Invalid date" (#374); an unknown time zone is reported;
`-999` criteria are skipped (legacy compared the string with a number); `IE-CHI`
intensities land in `int_rel_chi` (legacy wrote `int_rel_CHI`, which 3.0 lacks);
list terms are trimmed.

## Options

`plugins.magic-3-upgrade` in the node YAML (all optional):

| Option | Default | |
|---|---|---|
| `from_version` / `to_version` | `"2.5"` / `"3.0"` | the step it supplies; both in `data_model.versions`, adjacent |
| `method_code_renames` | the 3.0 renames (`ST-BC` → `ST-C`, …) | old code → new code |
| `time_zones` | `CDT`, `PDT`, `SAN`, `JER`, `+8 GMT`, `0` | 2.5 time-zone spellings → IANA zones |

No routes and no UI of its own: the upload page and the core Upgrade page
(`/upgrade`) show its report.

## Tests

`test_magic_3_upgrade.py`: `legacy_cases.json` is the legacy mocha suite's
2.5 → 3.0 cases, one by one (an expectation changed by a fix says why in
`changed`); then the fixed bugs and whole-contribution upgrades of the legacy
fixture contributions in `fixtures/` (3552 in 2.2, 7661 in 2.3, 8055 in 2.4,
10507 in 2.5) and of the upload page's 2.5 example.
