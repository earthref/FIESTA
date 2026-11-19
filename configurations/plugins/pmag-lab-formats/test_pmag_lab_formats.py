"""The pmag-lab-formats plugin: every PmagPy converter it wraps on a small
example file (fixtures/, trimmed from PmagPy's data_files), the sniffers, the
options as PmagPy arguments, and the report notes."""

from pathlib import Path

import pytest
from pydantic import ValidationError

from fiesta.plugins import all_plugins
from fiesta.plugins.base import ImportConversionError
from fiesta.plugins.pmag_lab_formats import (
    FORMAT_KEYS,
    CitFormat,
    CitOptions,
    GenericFormat,
    GenericOptions,
    SioOptions,
    _magic_kwargs,
    hierarchy_hints,
    stdout_notes,
)
from fiesta.services import import_formats as svc

FIXTURES = Path(__file__).parent / "fixtures"
CIT = ["PI47-.sam", "PI47-1a", "PI47-2a", "PI47-3a"]
CASES = {
    "pmag-generic": (["generic_magic_example.txt"], 23),
    "pmag-2g-bin": (["mn001-1a.dat"], 24),
    "pmag-2g-asc": (["DR3B.asc"], 21),
    "pmag-cit": (CIT, 81),
    "pmag-sio": (["sio_af_example.dat"], 14),
    "pmag-jr6": (["AF.jr6"], 30),
    "pmag-jr6-txt": (["AF.txt"], 3),
    "pmag-utrecht": (["Utrecht_Example.af"], 28),
    "pmag-ldeo": (["ldeo_magic_example.dat"], 37),
    "pmag-huji": (["Massada_AF_HUJI.txt"], 30),
}


def _files(names):
    return [svc.UploadedFile(name, (FIXTURES / name).read_bytes()) for name in names]


def test_every_format_is_offered_on_magic(magic_node):
    assert set(svc.import_formats(magic_node)) == set(FORMAT_KEYS) == set(CASES)


@pytest.mark.parametrize("key", list(CASES))
def test_each_converter_reads_its_example(magic_node, key):
    names, n_measurements = CASES[key]
    out = svc.convert(magic_node, key, _files(names), {})
    assert out["tables"]["measurements"] == n_measurements
    assert {"locations", "sites", "samples", "specimens"} <= set(out["tables"])
    assert out["text"].startswith("tab")
    assert out["tool"]["name"] == "PmagPy" and out["tool"]["version"]
    assert out["tool"]["function"].startswith("convert_2_magic.")
    assert out["tool"]["function"] in out["report_text"]
    # No temporary paths leak into the report.
    assert "fiesta-import-" not in out["report_text"]


def test_sniffers_pick_every_example_and_the_cit_specimen_files(magic_node):
    names = sorted({name for names, _ in CASES.values() for name in names})
    results = {r["name"]: r for r in svc.sniff(magic_node, _files(names))}
    for key, (files, _) in CASES.items():
        assert results[files[0]]["format"] == key, files[0]
        assert results[files[0]]["confidence"] >= svc.AUTO_PICK
        assert results[files[0]]["companion_of"] is None
    for name in CIT[1:]:
        assert (results[name]["format"], results[name]["companion_of"]) == ("pmag-cit", CIT[0])


@pytest.mark.parametrize("key", list(CASES))
def test_each_format_offers_its_fixture_as_its_example(magic_node, key):
    """The upload page's "try an example" sends a format's example files on
    their own: they are its test case, and they are read as it."""
    names = CASES[key][0]
    listed = {f["key"]: f for f in svc.describe(magic_node)}
    assert listed[key]["example"] == names
    assert all(svc.example_file(magic_node, key, name).is_file() for name in names)
    results = {r["name"]: r for r in svc.sniff(magic_node, _files(names))}
    assert results[names[0]]["format"] == key
    assert results[names[0]]["confidence"] >= svc.AUTO_PICK
    assert all(results[name]["companion_of"] == names[0] for name in names[1:])


def test_a_cit_conversion_without_its_specimen_files_fails(magic_node):
    with pytest.raises(ImportConversionError, match="PmagPy's CIT"):
        svc.convert(magic_node, "pmag-cit", _files(CIT[:1]), {})


def test_garbage_fails_with_a_message(magic_node):
    with pytest.raises(ImportConversionError):
        svc.convert(magic_node, "pmag-2g-asc", [svc.UploadedFile("x.asc", b"nonsense\n")], {})


def test_options_become_pmagpy_arguments():
    kwargs = _magic_kwargs(SioOptions(samp_con="4", samp_con_chars=3, codelist=["AF", "ANI"]))
    assert (kwargs["samp_con"], kwargs["codelist"]) == ("4-3", "AF:ANI")
    assert (kwargs["lat"], kwargs["lon"]) == ("", "")
    assert "samp_con_chars" not in kwargs
    assert _magic_kwargs(SioOptions(lat=12.5))["lat"] == 12.5
    cit = CitFormat().kwargs(CitOptions(methods="SO-MAG:FS-FD"))
    assert cit["methods"] == ["SO-MAG", "FS-FD"]
    generic = GenericFormat().kwargs(
        GenericOptions(sample_nc_kind="terminal", sample_nc_value="1", site_nc_kind="delimiter")
    )
    assert (generic["sample_nc"], generic["site_nc"]) == ([1, 1], [2, "-"])
    assert GenericFormat().kwargs(GenericOptions())["sample_nc"] == [1, 0]
    with pytest.raises(ImportConversionError, match="number of characters"):
        GenericFormat().kwargs(GenericOptions(site_nc_kind="initial", site_nc_value="x"))
    with pytest.raises(ValidationError):
        SioOptions(samp_con="6")
    with pytest.raises(ValidationError):
        SioOptions(codelist=[])
    with pytest.raises(ValidationError):
        SioOptions(nope=1)


def test_options_change_the_conversion(magic_node):
    out = svc.convert(magic_node, "pmag-cit", _files(CIT), {"locname": "Breccia dike"})
    assert "Breccia dike" in out["text"]
    assert out["options_set"] == ["locname"]
    kinds = {(n["kind"], n["message"].split(":")[0]) for n in out["notes"]}
    # Left at a default: reported; set by the contributor: not.
    assert ("default", "Sample naming convention") in kinds
    assert ("default", "Location") not in kinds
    assert any(n["kind"] == "hint" for n in out["notes"])
    # PI47-1a .. PI47-3a with one specimen character and a dash between site
    # and sample: three samples PI47-1 .. PI47-3 of one site, PI47; no hint.
    named = svc.convert(magic_node, "pmag-cit", _files(CIT), {"specnum": 1, "samp_con": "2"})
    assert [(h["table"], h["count"]) for h in named["hierarchy"][:4]] == [
        ("locations", 1),
        ("sites", 1),
        ("samples", 3),
        ("specimens", 3),
    ]
    assert not any(n["kind"] == "hint" for n in named["notes"])


def test_the_options_schema_labels_its_enums():
    schema = SioOptions.model_json_schema()["properties"]
    assert schema["samp_con"]["x-enum-labels"]["1"].startswith("1: XXXXY")
    assert schema["codelist"]["x-enum-labels"]["AF"] == "AF demagnetization"
    assert schema["samp_con"]["title"] == "Sample naming convention"


def test_stdout_notes(tmp_path):
    printed = "\n".join(
        [
            "-W- WARNING: missing dip for sample s1",
            "-W- WARNING: missing dip for sample s1",
            f"-I- 24 records written to {tmp_path}/out/measurements.txt",
            "-I- Using cached data model",
            f"-E- cannot read {tmp_path}/in/a.dat",
            "NRM False",
            "some error happened",
            "-I- Using less strict decoding",
        ]
    )
    notes = stdout_notes(printed, [tmp_path])
    assert [(n.level, n.message, n.count) for n in notes] == [
        ("error", "cannot read in/a.dat", 1),
        ("error", "some error happened", 1),
        ("warning", "missing dip for sample s1", 2),
        ("info", "Using less strict decoding", 1),
    ]


def test_hierarchy_hints():
    def text(n_spec, n_samp, n_site):
        blocks = [
            ("specimens", "specimen", n_spec),
            ("samples", "sample", n_samp),
            ("sites", "site", n_site),
        ]
        return "\n>>>>>>>>>>\n".join(
            f"tab\t{table}\n{column}\n" + "\n".join(f"{column}{i}" for i in range(n))
            for table, column, n in blocks
        )

    (hint,) = hierarchy_hints(text(42, 42, 42), "naming")
    assert hint.message.startswith("42 specimens -> 42 samples -> 42 sites: every specimen")
    assert hint.kind == "hint"
    assert hierarchy_hints(text(4, 4, 2), "naming") == []
    assert hierarchy_hints(text(8, 4, 4), "naming") == []
    assert hierarchy_hints(text(8, 4, 2), "naming") == []
    assert hierarchy_hints(text(1, 1, 1), "naming") == []


def test_plugin_options_pick_the_formats(magic_node):
    plugin = all_plugins()["pmag-lab-formats"]
    node = magic_node.model_copy(
        update={"plugins": {**magic_node.plugins, "pmag-lab-formats": {"formats": ["pmag-cit"]}}}
    )
    assert [f.key for f in plugin.import_formats(node)] == ["pmag-cit"]
    with pytest.raises(ValueError, match="unknown formats"):
        plugin.check(node, plugin.Options(formats=["pmag-nope"]))
