"""Plugin protocol.

Hooks are all optional — a plugin overrides only what it needs. The core
never special-cases a node: everything node-specific flows through these
hooks, keyed off the node YAML's `features.plugins` list, and everything a
plugin lets a node tune is an option declared on its `Options` model and set
in the node YAML's `plugins: {<name>: {...}}` map.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, ValidationError

from fiesta.domain.parse import ParsedContribution
from fiesta.domain.upgrade import UpgradeStep
from fiesta.nodeconfig import NodeConfig, SearchLevel


@dataclass(frozen=True)
class PluginVocabulary:
    """A controlled vocabulary a plugin supplies for the validator's
    `cv("<name>")` checks, when the node's controlled vocabularies have no
    list of that name. `case_insensitive` compares values and items
    upper-cased. `labels` (item -> definition) is what the grid editor's
    vocabulary panel shows beside an item; GET /config/vocabularies/plugins
    serves both."""

    items: frozenset[str]
    case_insensitive: bool = False
    label: str = ""
    labels: dict[str, str] = field(default_factory=dict, hash=False, compare=False)


@dataclass(frozen=True)
class GridTile:
    """A summary grid tile a plugin adds (`search.levels[].columns[].cell`).
    Its UI half renders it through `gridCell`. `label` and `width` are the
    header's defaults, `hint` describes it in the admin UI's grid editor, and a
    `default` tile is one of the columns of a level that configures none
    (after the core's data tiles, before `citations`)."""

    cell: str
    label: str
    width: int
    hint: str = ""
    default: bool = False


@dataclass
class GridTileFields:
    """What a plugin tile's header sorts and filters on, by default: `summary.*`
    paths to sort on (`sort_type` "number" sorts strings as numbers), text
    filter paths, and the `summary._all` columns its menu lists as facets."""

    sort_fields: list[str] = field(default_factory=list)
    sort_type: Literal["keyword", "number", "date", "long"] = "keyword"
    filter_fields: list[str] = field(default_factory=list)
    facets: list[str] = field(default_factory=list)


class PluginOptions(BaseModel):
    """Base of a plugin's `Options`: a pydantic model whose fields (with
    defaults and descriptions) are the plugin's per-node settings. Its JSON
    schema drives the admin UI's options form; unknown keys are an error so a
    typo in the YAML is caught at validation, not ignored."""

    model_config = {"extra": "forbid"}


class ImportOptions(BaseModel):
    """Base of an import format's `Options`: what a contributor sets in the
    upload page's import step to steer the conversion (a naming convention, a
    location name, a lab field). Its JSON schema is served to the SPA, which
    renders it as a form; an enum field may carry `x-enum-labels` ({value:
    label}) in its schema extras for the menu. Unknown keys are an error."""

    model_config = {"extra": "forbid"}


@dataclass(frozen=True)
class ImportNote:
    """One line of a conversion's report. `kind`: "converter" (what the
    converter printed or raised), "default" (an option the contributor left at
    a default that shapes the result), or "hint" (something in the result worth
    a second look, e.g. every specimen its own sample)."""

    level: Literal["error", "warning", "info"]
    message: str
    kind: Literal["converter", "default", "hint"] = "converter"
    count: int = 1


@dataclass
class ImportInput:
    """What a conversion reads: the uploaded files written into `directory`
    (`files[0]` is the one the contributor read as this format, the rest the
    companions it reads with it, see ImportFormat.companions), and an empty
    `work_dir` for the converter's own output. Both are removed afterwards."""

    directory: Path
    files: list[str]
    work_dir: Path


@dataclass
class ImportResult:
    """A conversion: `text` in the node's multi-table text format (what the
    contributor would have uploaded), its report notes, and the tool that made
    it (`{"name", "version", "function"}`), which the report records."""

    text: str
    notes: list[ImportNote] = field(default_factory=list)
    tool: dict[str, str] = field(default_factory=dict)


class ImportConversionError(Exception):
    """A conversion that produced nothing usable: `message` is shown to the
    contributor with the notes gathered so far."""

    def __init__(self, message: str, notes: list[ImportNote] | None = None):
        super().__init__(message)
        self.message = message
        self.notes = notes or []


class ImportFormat:
    """A file format the upload page's import step converts to the node's
    text format on the server (a lab instrument's output, say), supplied by a
    plugin's `import_formats`. Stateless: the core writes the files into a
    temporary directory, runs `convert` in a worker thread, and parses and
    counts the text it returns; nothing is stored."""

    #: Unique among a node's import formats; the API's and the SPA's key.
    key: str = ""
    #: The import file-type menu's label.
    label: str = ""
    #: A sentence for the format's help text.
    description: str = ""
    #: File name extensions it usually has (lower case, with the dot), a hint.
    extensions: tuple[str, ...] = ()
    #: Whether one conversion reads several files (`companions`).
    multi_file: bool = False
    #: An example the upload page offers to try (`GET /import-formats/{key}/
    #: example/{name}`): small published files, the one read as this format
    #: first, then the companions its conversion reads. Empty: none.
    example: tuple[Path, ...] = ()
    #: The contributor's options (see ImportOptions). The plain base: none.
    Options: type[ImportOptions] = ImportOptions

    def sniff(self, filename: str, head: bytes) -> float:
        """How sure (0 to 1) it is that a file is in this format, from its
        name and first bytes. The import step picks a format at 0.8 or more."""
        return 0.0

    def companions(self, filename: str, head: bytes, others: list[str]) -> list[str]:
        """For a multi-file format: which of the other files picked with this
        one (`others`, by name) its conversion reads. Those are sent with it
        and are not read on their own."""
        return []

    def options_schema(self) -> dict[str, Any]:
        return self.Options.model_json_schema()

    def convert(self, node: NodeConfig, files: ImportInput, options: ImportOptions) -> ImportResult:
        """The files converted to the node's text format; raise
        ImportConversionError when nothing usable comes out. Synchronous (it
        runs in a worker thread). `options.model_fields_set` holds the options
        the contributor set; the rest are defaults."""
        raise NotImplementedError


class FiestaPlugin:
    #: Registry key; must match the name used in node YAMLs and the frontend
    #: plugin registry.
    name: str = ""
    #: One or two sentences for the admin UI's plugin list.
    description: str = ""
    #: Per-node options (see PluginOptions). The plain base means "no options".
    Options: type[PluginOptions] = PluginOptions
    #: Slugs of the SPA pages its UI registers (index.tsx `pages`, served at
    #: /<slug>): no node's content page may take one.
    pages: tuple[str, ...] = ()
    #: Summary grid tiles it adds (see GridTile); its UI renders them.
    grid_tiles: tuple[GridTile, ...] = ()

    def options(self, node: NodeConfig) -> PluginOptions:
        """This node's options: the YAML `plugins.<name>` map over the
        defaults. Raises ValueError (with the plugin named) when they do not
        fit the schema."""
        try:
            return self.Options(**node.plugins.get(self.name, {}))
        except ValidationError as exc:
            problems = "; ".join(
                f"{'.'.join(str(p) for p in e['loc']) or '(root)'}: {e['msg']}"
                for e in exc.errors()
            )
            raise ValueError(f"plugin {self.name!r} options: {problems}") from None

    def options_schema(self) -> dict[str, Any]:
        """JSON schema of `Options` (pydantic's), for the admin UI."""
        return self.Options.model_json_schema()

    def check(self, node: NodeConfig, options: PluginOptions) -> None:
        """Validate options against the node (its data model, levels, ...);
        raise ValueError. Runs at startup and before every publication."""

    def jsonld(self, node: NodeConfig, doc: dict, catalog_url: str) -> dict[str, Any]:
        """schema.org properties this plugin adds to a contribution's Dataset
        (fiesta.domain.jsonld; `doc` is its search document): a list extends the
        core's, anything else is set where the core left it unset."""
        return {}

    def derive_docs(
        self,
        node: NodeConfig,
        parsed: ParsedContribution,
        contribution_meta: dict,
        records: list[dict] | None = None,
    ) -> list[dict]:
        """Extra search documents derived from a contribution at summarize
        time (same shape as fiesta.domain.summarize docs: {type, summary,
        rows?}). Re-runs whenever the contribution is (re)processed and on
        `fiesta rebuild`, so derived data is always reproducible. `records`
        are the docs `summarize` built for it (the contribution's and its
        hierarchy records', with the plugins' derived values), for a plugin
        whose docs take a record's fields (`record_tables`); None from a
        caller without them."""
        return []

    def record_tables(self, node: NodeConfig) -> dict[str, str]:
        """Its search tables whose docs are a hierarchy level's records seen
        another way (`{"poles": "locations"}`): each carries that level's
        filter fields (`summary._all`, `_num`, `_has`, `_interval`, positions)
        as the level's own docs do, so the search routes take the level's
        text / number / with-data columns for it and the level's sidebar
        filters apply to and count its docs."""
        return {}

    def derived_columns(self, node: NodeConfig) -> dict[str, Literal["text", "number"]]:
        """Columns it derives on the hierarchy's record docs (`derive_values`),
        by name: a "text" one is a `summary._all.<name>` keyword (a YAML facet
        filter, `<name>:"<value>"` tokens), a "number" one `summary._num.<name>`
        (a YAML range filter, its histogram). The node loader accepts YAML
        filters on them as on data-model columns; a name must not be one."""
        return {}

    def derive_values(self, node: NodeConfig, table: str, rows: list[dict]) -> dict[str, list]:
        """Values of its `derived_columns` for one record doc of a hierarchy
        level (`table`, the doc's rows), `{name: [values]}`: text for a "text"
        column, numbers for a "number" one. Runs whenever the contribution is
        (re)indexed; the contribution doc gets every record's values too."""
        return {}

    def search_levels(self, node: NodeConfig) -> list[SearchLevel]:
        """Extra top-level search tabs. Appended after the node's configured
        levels; the level's `table` should match the `type` of the docs this
        plugin derives."""
        return []

    def search_tables(self, node: NodeConfig) -> list[str]:
        """Extra searchable doc `type`s that are NOT top-level tabs — e.g.
        the `poles` docs surfaced as a sub-tab of the Locations level. These
        become valid `/api/search/{table}` targets without adding a tab."""
        return []

    def search_facets(self, node: NodeConfig) -> list[str]:
        """Extra columns the search API counts as facet buckets
        (`facet=<column>`) for the plugin's own sidebar filter; a picked
        value is the usual `<column>:"<value>"` query token, OR'd within the
        column like a sidebar facet's."""
        return []

    def grid_tile_fields(self, node: NodeConfig, level: SearchLevel, cell: str) -> GridTileFields:
        """The default sort, filter and facet fields of one of its `grid_tiles`
        on a level (from its options); a column's YAML may replace them."""
        return GridTileFields()

    def vocabularies(self, node: NodeConfig) -> dict[str, PluginVocabulary]:
        """Controlled vocabularies by name for `cv("<name>")` validations,
        consulted when the node's own controlled vocabularies lack the name."""
        return {}

    def upgrade_steps(self, node: NodeConfig) -> list[UpgradeStep]:
        """Hooks for data-model version steps whose restructuring the
        models' `previous_columns` cannot express (fiesta.domain.upgrade):
        each UpgradeStep names its from_version and to_version. At most one
        active plugin may supply a given step."""
        return []

    def import_formats(self, node: NodeConfig) -> list[ImportFormat]:
        """File formats the upload page's import step converts to the node's
        text format (fiesta.services.import_formats; GET /import-formats). Keys
        are unique among a node's active plugins."""
        return []

    def build_router(self) -> APIRouter | None:
        """Extra API routes, mounted at /v2/{repository}/plugins/{plugin.name} and
        served only for nodes that activate this plugin; handlers take NodeDep."""
        return None

    def frontend_config(self, node: NodeConfig) -> dict:
        """Arbitrary JSON surfaced to the SPA via GET /api/config under
        `plugins[name]` — the UI plugin reads its options from here."""
        return {}
