"""Contribution modes and the data-source sync client (no infrastructure)."""

import json
import re
from datetime import UTC, datetime

import httpx
import pytest
from _paths import CONFIG_DIR

from fiesta.nodeconfig import load_deployment
from fiesta.services.legacy import SourceRecord, record_fingerprint
from fiesta.settings import get_settings, parse_contributions_mode
from fiesta.sources.client import SourceAPI


@pytest.fixture(scope="session")
def kdd_node():
    return load_deployment(CONFIG_DIR / "kdd.yaml").node_for("kdd")


@pytest.fixture
def mode(monkeypatch):
    def set_mode(value: str) -> None:
        monkeypatch.setattr(get_settings(), "contributions_mode", value)

    return set_mode


def test_parse_contributions_mode():
    assert parse_contributions_mode("") == ("public", {})
    assert parse_contributions_mode("source") == ("source", {})
    assert parse_contributions_mode(" source, KArAr=public ") == ("source", {"karar": "public"})
    assert parse_contributions_mode("kdd=source") == ("public", {"kdd": "source"})
    with pytest.raises(ValueError, match="mirror"):
        parse_contributions_mode("mirror")


def test_mode_per_node_and_write_guard(kdd_node, mode):
    from fastapi import HTTPException
    from starlette.requests import Request

    from fiesta.apps.deps import require_public_contributions, source_mode_message

    def request(method: str) -> Request:
        return Request({"type": "http", "method": method, "path": "/", "headers": []})

    mode("public")
    assert kdd_node.contributions_mode == "public"
    assert kdd_node.public_config()["contributions_mode"] == "public"
    assert source_mode_message(kdd_node) is None
    require_public_contributions(request("POST"), kdd_node)

    mode("source,kdd=source,karar=public")
    assert kdd_node.contributions_mode == "source"
    assert "earthref.org/KdD" in source_mode_message(kdd_node)
    require_public_contributions(request("GET"), kdd_node)
    with pytest.raises(HTTPException) as refused:
        require_public_contributions(request("PUT"), kdd_node)
    assert refused.value.status_code == 409


def _record(cid: int, body: bytes, **extra) -> dict:
    import hashlib

    name = f"kdd_contribution_{cid}.txt"
    return {
        "id": cid,
        "owner_email": "owner@example.test",
        "published": True,
        "created_at": "2020-01-01T00:00:00+00:00",
        "activated_at": "2020-01-02T00:00:00+00:00",
        "revisions": [
            {
                "key": "legacy",
                "timestamp": "2020-01-02T00:00:00+00:00",
                "canonical": name,
                "files": {
                    name: {
                        "source": f"files/{cid}/{name}",
                        "sha256": hashlib.sha256(body).hexdigest(),
                    }
                },
            }
        ],
    } | extra


@pytest.mark.asyncio
async def test_sync_meteor_sends_only_changed_records(kdd_node, tmp_path, monkeypatch):
    from fiesta.services import legacy_inventory
    from fiesta.sources import meteor

    bodies = {1: b"tab\tcontribution\nid\n1\n", 2: b"tab\tcontribution\nid\n2\n"}
    records = [_record(cid, body) for cid, body in bodies.items()]
    for cid, body in bodies.items():
        path = tmp_path / "files" / str(cid) / f"kdd_contribution_{cid}.txt"
        path.parent.mkdir(parents=True)
        path.write_bytes(body)

    async def fake_inventory(node, out_dir, *, client=None):
        (out_dir / "inventory.json").write_text(
            json.dumps({"format": 1, "node": "kdd", "source_id": "legacy-kdd", "records": records})
        )
        owner = {"email": "owner@example.test", "name": "Owner", "contributions": [1, 2]}
        (out_dir / "owners.json").write_text(json.dumps([owner]))
        return {
            "contributions": 3,
            "errors": [{"id": 3, "error": "no account for contributor 'Roger Nielsen'"}],
            "unresolved_handles": [],
        }

    monkeypatch.setattr(legacy_inventory, "build_inventory", fake_inventory)
    unchanged = record_fingerprint(SourceRecord.model_validate(records[0]))
    sent = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            assert request.url.path == "/v2/kdd/source/checkpoints"
            return httpx.Response(
                200,
                json={
                    "mode": "source",
                    "source_id": "legacy-kdd",
                    "checkpoints": {"1": unchanged, "7": "gone"},
                },
            )
        assert request.url.path == "/v2/kdd/source/records/2"
        body = request.read()
        assert b'name="legacy/kdd_contribution_2.txt"' in body and bodies[2] in body
        assert b'"owner@example.test"' in body and b"contributions" not in body
        sent.append(2)
        return httpx.Response(200, json={"status": "applied", "bytes": len(bodies[2])})

    api = SourceAPI("http://fiesta.test", "kdd", transport=httpx.MockTransport(handler))
    summary = await meteor.sync_meteor(kdd_node, api, tmp_path)
    assert sent == [2]
    assert summary["unchanged"] == 1 and summary["applied"] == 1
    assert summary["quarantined"] == 1 and summary["errors"] == []
    assert summary["missing_from_source"] == [7]

    dry = await meteor.sync_meteor(kdd_node, api, tmp_path, dry_run=True)
    assert dry["planned"] == [2] and sent == [2]

    # `legacy.exclude_ids` withholds a record from every run.
    legacy = kdd_node.legacy.model_copy(update={"exclude_ids": [2]})
    withheld = await meteor.sync_meteor(
        kdd_node.model_copy(update={"legacy": legacy}), api, tmp_path
    )
    assert withheld["excluded"] == [2] and withheld["applied"] == 0 and sent == [2]


@pytest.mark.asyncio
async def test_sync_meteor_does_nothing_in_public_mode(kdd_node, tmp_path, monkeypatch):
    from fiesta.services import legacy_inventory
    from fiesta.sources import meteor

    async def never(*args, **kwargs):
        raise AssertionError("the source is not read in public mode")

    monkeypatch.setattr(legacy_inventory, "build_inventory", never)
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200, json={"mode": "public", "source_id": "legacy-kdd", "checkpoints": {}}
        )
    )
    api = SourceAPI("http://fiesta.test", "kdd", transport=transport)
    summary = await meteor.sync_meteor(kdd_node, api, tmp_path)
    assert summary["skipped"] == "node is in public mode"


def test_source_schedules_follow_node_sync(kdd_node, tmp_path, monkeypatch):
    """A node with a script gets a `<slug>-source` schedule timed and enabled by
    its `legacy.sync`; a node without one gets none; the file's own wins."""
    from fiesta.ops.config import parse_ops_config

    monkeypatch.setattr(get_settings(), "sources_dir", tmp_path)
    (tmp_path / "kdd.py").write_text("")
    owners = tmp_path / "kdd-owners.json"
    owners.write_text("{}")
    legacy = kdd_node.legacy.model_copy(
        update={"sync": kdd_node.legacy.sync.model_copy(update={"enabled": True})}
    )
    node = kdd_node.model_copy(update={"legacy": legacy})
    karar = load_deployment(CONFIG_DIR / "karar.yaml").node_for("karar")
    config = parse_ops_config(
        f"""
fiesta-ops: 1
sources:
  env_file: /etc/fiesta/source-{{slug}}.env
  owner_map: {tmp_path}/{{slug}}-owners.json
"""
    ).with_sources([node, karar])
    (schedule,) = config.schedules
    assert schedule.name == "kdd-source" and schedule.enabled and schedule.cron == "20 * * * *"
    assert schedule.env_file == "/etc/fiesta/source-kdd.env"
    assert schedule.command[1] == str(tmp_path / "kdd.py")
    assert schedule.command[-2:] == ["--owner-map", str(owners)]
    assert schedule.expected_interval > 3600
    assert kdd_node.legacy.sync.enabled is False  # the checked-in default


def test_checked_in_source_scripts_are_scheduled(monkeypatch):
    """Every `configurations/sources/<slug>.py` is a served node with a `legacy:` block
    (Meteor, or a script-only source such as GEOMAGIA's), so the ops worker gives it a
    schedule; MagIC's is on, hourly."""
    from fiesta.ops.config import parse_ops_config

    sources = CONFIG_DIR / "sources"
    if not sources.is_dir():  # a checkout or image without the sync scripts
        pytest.skip("no configurations/sources/ in this checkout")
    monkeypatch.setattr(get_settings(), "sources_dir", sources)
    scripts = sorted(p.stem for p in sources.glob("*.py"))
    assert {"kdd", "magic"} <= set(scripts)
    nodes = [load_deployment(CONFIG_DIR / "fiesta.yaml").node_for(s) for s in scripts]
    assert all(n.legacy is not None and n.legacy.kind in ("meteor", "script") for n in nodes)
    config = parse_ops_config("fiesta-ops: 1\n").with_sources(nodes)
    schedules = {s.name: s for s in config.schedules}
    assert set(schedules) == {f"{s}-source" for s in scripts}
    magic = schedules["magic-source"]
    assert magic.enabled and magic.cron == "40 * * * *"
    assert magic.command[1] == str(sources / "magic.py")


# ---- GEOMAGIA: public CSV export -> one contribution per reference ----------

GEOMAGIA_CSV = (
    "Generated using GEOMAGIA50.v3.2 on May/22/2019\n"
    "Age[yr.AD],Sigma-ve[yr.],Sigma+ve[yr.],SigmaAgeID,N_Ba,n_Ba[meas.],n_Ba[acc.],"
    "Ba[microT],SigmaBa[microT],VDM[E22_AmE2],SigmaVDM[E22_AmE2],N_Dir,n_Dir[meas.],"
    "n_Dir[acc.],Dec[deg.],Inc[deg.],Alpha95[deg.],K,MaxAF[mT],MaxTemp[deg.C],PubDataID,"
    "SiteName,LocationName,SiteLat[deg.],SiteLon[deg.],CountryRegionID,ArcheoVolcanic,MatID,"
    "PIMethID,AltMonID,MDMonID,CoolRID,AnisoID,DirMethID,DirAnalysisID,DatMethID,SpecTypeID,"
    "RefID,CompilationID,UploadMonth,UploadYear,Uploader,Editor,LastEditDate,C14ID,UID\n"
    # intensity only, two dating methods, in no compilation
    "  1490,  -9999,  -9999,  1,  1,  -999,  3,  69.00,  1.00,  9.65,  0.14,  -999,  -999,"
    "  -999,  -999.00,  -999.00,  -999.00,  -999.00,  -999,  -999,  -999,  -999,  Vologda,"
    "  59.3000,  39.7000,  49,  Archeo,  1,  1,  -1,  -1,  -1,  -1,  0,  0,  101;102,  2,"
    "  265,  -1,  -999,  2009,  Fabio Donadini,  -999,  -999,  -1,  1915\n"
    # direction only, an unknown demagnetization code kept visible
    "  1795,  20,  20,  1,  -999,  -999,  -999,  -999.00,  -999.00,  -999.00,  -999.00,  39,"
    "  -999,  -999,  331.00,  73.70,  2.00,  125.00,  -999,  -999,  -999,  -999,  Veldbaek,"
    "  55.4600,  8.5000,  55,  Archeo,  0,  -1,  -1,  -1,  -1,  -1,  101,  0,  0,  0,"
    "  206,  1004;1006,  -999,  2009,  Fabio Donadini,  -999,  -999,  -1,  4039\n"
)


@pytest.fixture(scope="module")
def geomagia_source():
    import importlib.util

    path = CONFIG_DIR / "sources" / "geomagia.py"
    if not path.is_file():
        pytest.skip("no configurations/sources/ in this checkout")
    spec = importlib.util.spec_from_file_location("geomagia_source", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_geomagia_rows_keep_codes_and_drop_missing_markers(geomagia_source, tmp_path):
    from fiesta.domain.parse import parse_text
    from fiesta.domain.validate import validate_contribution

    csv_path = tmp_path / "geomagia.csv"
    csv_path.write_text(GEOMAGIA_CSV)
    generated, texts, _meta = geomagia_source.build(csv_path, None)
    assert generated.startswith("Generated using GEOMAGIA50.v3.2") and sorted(texts) == [206, 265]

    node = load_deployment(CONFIG_DIR / "fiesta.yaml").node_for("geomagia")
    parsed = parse_text(texts[265])
    assert parsed.tables["contribution"][0]["geomagia_reference_id"] == "265"
    (site,) = parsed.tables["sites"]
    assert site["site"] == site["uid"] == "1915"
    # Missing markers are blank; lookup sentinels (-1, 0) keep their IDs and names.
    assert not site.get("age_min") and not site.get("decl")
    assert site["ac_id"] == "-1" and site["alteration_checks"] == "No measurement"
    assert site["dating_method_id"] == "101:102"
    assert site["dating_methods"] == "Archeological Age:Calibrated 14 C Age"
    assert not site.get("comp_ref")  # -1: in no compilation
    assert (site["region_country"], site["continent"]) == ("Russia", "Asia")
    # VADM from the intensity and site latitude, as the GEOMAGIA site calculates it.
    assert (site["vadm"], site["sigma_vadm"]) == ("9.95", "0.14")
    assert not validate_contribution(node, parsed, "1.0").errors

    direction_parsed = parse_text(texts[206])
    (direction,) = direction_parsed.tables["sites"]
    assert direction["compilations"] == (
        "Schnepp E., Lanos Ph. (2006):Donadini F., Korhonen K., Riisager P., Pesonen L.J. (2006)"
    )
    # A code missing from the glossary stays visible and fails validation.
    assert direction["demag_method"] == "Unknown (ID 101)"
    errors = validate_contribution(node, direction_parsed, "1.0").errors
    assert [e.as_dict()["column"] for e in errors] == ["demag_method"]


def test_geomagia_short_citation(geomagia_source):
    cite = geomagia_source.short_citation
    assert cite("Shaw J.", "1974") == "Shaw (1974)"
    assert cite("Burlatskaya S.P., Chelidze Z.A.", "1990") == "Burlatskaya and Chelidze (1990)"
    assert cite("Aitken M.J., Pesonen L.J., Leino M.A.H.", "1991") == "Aitken et al. (1991)"


@pytest.mark.asyncio
async def test_geomagia_sync_sends_only_changed_references(geomagia_source, tmp_path):
    csv_path = tmp_path / "geomagia.csv"
    csv_path.write_text(GEOMAGIA_CSV)
    generated, texts, meta = geomagia_source.build(csv_path, None)
    records = geomagia_source.source_records(texts, meta, generated, "steward@example.test")
    unchanged = record_fingerprint(records[206])
    sent = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            state = {"mode": "source", "source_id": "geomagia50", "checkpoints": {"206": unchanged}}
            return httpx.Response(200, json=state)
        assert request.url.path == "/v2/geomagia/source/records/265"
        body = request.read()
        assert b'name="geomagia/geomagia_contribution_265.txt"' in body
        assert b'"steward@example.test"' in body
        sent.append(265)
        return httpx.Response(200, json={"status": "applied", "bytes": len(texts[265])})

    api = SourceAPI("http://fiesta.test", "geomagia", transport=httpx.MockTransport(handler))
    summary = await geomagia_source.sync(
        api, texts, meta, generated, {"email": "steward@example.test"}
    )
    assert sent == [265] and summary["applied"] == 1 and summary["unchanged"] == 1
    assert summary["errors"] == [] and summary["missing_from_source"] == []
    assert records[265].created_at.date().isoformat() == "2019-05-22"


# ---- GEOMAGIA: the MySQL catalogue, through a fake DB-API connection ----------


def _archeodij(**values):
    """An ARCHEODIJ row as pymysql returns it (SET columns as "a,b" strings)."""
    row = dict.fromkeys(
        [
            "NUM_14C_SAMPLES",
            "C14_ID",
            "CALIB_14C_AGE",
            "CALIB_14C_AGE_SIGMA_MIN",
            "CALIB_14C_AGE_SIGMA_MAX",
            "NUM_14C_SIGMAS",
            "CALC_CALIB_14C_AGE",
            "CALC_CALIB_14C_AGE_SIGMA_MIN",
            "CALC_CALIB_14C_AGE_SIGMA_MAX",
            "DENDRO_ID",
            "TOT_NUM_DENDRO",
            "NUM_DENDRO_USED",
            "CROSS_REF_ID",
            "CROSS_UID",
        ],
        -1,
    )
    row |= {"SITE_NAME": None, "EDITOR": None, "EDIT_DATE": None, "COMP_REF": "", "K": -1.0}
    row |= {"AN_USE_STATUS_ID": 0, "SUPERSEEDED": 0, "VADM": 1.0, "SIGMA_VADM": 1.0}
    return row | values


GEOMAGIA_DB_ROWS = [
    # intensity only, two dating methods, in no compilation (the CSV test's UID 1915)
    _archeodij(
        UID=1915,
        NUM_SAMPLES=1,
        NUM_ACC_SPEC=3,
        NUM_MEAS_SPEC=0,
        BA=69.0,
        SIGMA_BA=1.0,
        AGE=1490.0,
        AGE_MIN=-1.0,
        AGE_MAX=-1.0,
        NUM_SIGMAS=-1,
        AGE_ERROR_TYPE_ID=1,
        SITE_LAT=59.3,
        SITE_LON=39.7,
        SITE_ID=49,
        PI_METHOD_ID="1",
        AC_ID="-1",
        MD_CK_ID="-1",
        AN_CORR_SET_ID="-1",
        CR_CORR_SET_ID="-1",
        DM_METHOD_ID=0,
        AF_STEP=0.0,
        T_STEP=0,
        DM_ANALYSIS_ID=0,
        SPECIMEN_TYPE_ID="2",
        MATERIAL_ID="1",
        REFERENCE_ID=265,
        DATING_METHOD_ID="101,102",
        NUM_DIR_SAMPLES=-1,
        NUM_DIR_SPECIMENS=-1,
        NUM_DIR_SPEC_COLLECTED=0,
        DECL=999.0,
        INCL=999.0,
        ALPHA_95=-1.0,
        VDM=9.65,
        SIGMA_VDM=0.14,
        SAMPLE_ID="0",
        SITE_HORIZON="0",
        SITE_NAME="Vologda",
        UPLOAD_YEAR=2009,
        UPLOAD_MONTH=0,
        UPLOADER="FD",
    ),
    # volcanic (lava), a -180..180 longitude, anisotropy assessed but not applied
    _archeodij(
        UID=4039,
        NUM_SAMPLES=-1,
        NUM_ACC_SPEC=-1,
        NUM_MEAS_SPEC=-1,
        BA=-1.0,
        SIGMA_BA=-1.0,
        AGE=1795.0,
        AGE_MIN=20.0,
        AGE_MAX=20.0,
        NUM_SIGMAS=2,
        AGE_ERROR_TYPE_ID=1,
        SITE_LAT=55.46,
        SITE_LON=-3.5,
        SITE_ID=55,
        PI_METHOD_ID="-1",
        AC_ID="-1",
        MD_CK_ID="-1",
        AN_CORR_SET_ID="3",
        AN_USE_STATUS_ID=2,
        CR_CORR_SET_ID="-1",
        DM_METHOD_ID=1,
        AF_STEP=-1.0,
        T_STEP=-1,
        DM_ANALYSIS_ID=0,
        SPECIMEN_TYPE_ID="0",
        MATERIAL_ID="4",
        REFERENCE_ID=206,
        DATING_METHOD_ID="0",
        NUM_DIR_SAMPLES=39,
        NUM_DIR_SPECIMENS=-1,
        NUM_DIR_SPEC_COLLECTED=-1,
        DECL=331.0,
        INCL=73.7,
        ALPHA_95=2.0,
        K=125.0,
        COMP_REF="1004,1006",
        SAMPLE_ID="-1",
        SITE_HORIZON="Veldbaek",
        UPLOAD_YEAR=2009,
        UPLOAD_MONTH=3,
        UPLOADER="FD",
        EDITOR="MCB",
        EDIT_DATE="7/24/2017",
    ),
]


class FakeGeomagiaDB:
    """A DB-API connection serving the GEOMAGIA tables the source reads; records every
    statement. Table names come back as Django has them (ARCHEODIJ, REFS)."""

    def __init__(self, lookups):
        self.statements, self.rolled_back = [], False

        def names(table, **override):
            rows = lookups[table]["rows"] | override
            return [
                {"ID": int(i), "name": v[0] if isinstance(v, list) else v} for i, v in rows.items()
            ]

        self.tables = {
            "error_type": names("AgeErrorID"),
            "dating_methods": names("DatMethod", **{"102": "Calibrated <sup>14</sup>C Age"}),
            "pi_methods": names("PIID"),
            "alteration_monit_corr": names("PIAltID"),
            "md_checks": names("PIMDID"),
            "anisotropy_correction": names("PIANID"),
            "measurement_use_status": [
                {"ID": 0, "name": "Not specified"},
                {"ID": 1, "name": "Correction applied"},
                {"ID": 2, "name": "Assessment only"},
            ],
            "cooling_rate": names("PICRID"),
            "dm_methods": names("DirMethID"),
            "dm_analysis": names("DirID"),
            "specimen_types": names("SpecID"),
            "materials": names("MatID"),
            "14c_calibration_software": names("C14Soft"),
            "14c_calibration_dataset": names("C14DataSet"),
            "aa_locations": [
                {"ID": int(i), "NAME": v[0], "CONTINENT": v[1]}
                for i, v in lookups["CRID"]["rows"].items()
            ],
            "comp_reference": [
                {"ID": i, "AUTHORS": v[0], "TITLE": v[1], "YEAR": int(v[2])}
                for i, v in lookups["CompID"]["rows"].items()
            ],
            # SHORT_NAME (an email address) exists but the source never selects it.
            "uploader": [
                {"ID": "FD", "NAME": "Fabio Donadini"},
                {"ID": "MCB", "NAME": "Maxwell Brown"},
            ],
            "REFS": [
                {
                    "ID": 206,
                    "AUTHORS": "Donadini F., Korhonen K., Riisager P., Pesonen L.J.",
                    "TITLE": "Database for Holocene geomagnetic intensity information",
                    "YEAR": 2006,
                    "PUBLICATION_NAME": "Eos",
                    "VOLUME": 87,
                    "PAGES": "137",
                    "DOI": None,
                    "MAGIC_LINK": None,
                },
                {
                    "ID": 265,
                    "AUTHORS": "Kova&#269;eva M.",
                    "TITLE": "Archaeomagnetic results",
                    "YEAR": 2009,
                    "PUBLICATION_NAME": "Phys. Earth Planet. Inter.",
                    "VOLUME": 1,
                    "PAGES": "1-9",
                    "DOI": "10.1000/example",
                    "MAGIC_LINK": "https://earthref.org/MagIC/1",
                },
            ],
            "archeodij_edit_history": [{"UID": 1915, "edited": datetime(2020, 12, 1)}],
            "ARCHEODIJ": GEOMAGIA_DB_ROWS,
        }

    def cursor(self):
        db = self

        class Cursor:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def execute(self, sql, args=()):
                db.statements.append(sql)
                if "information_schema" in sql:
                    self.rows = [{"name": t} for t in db.tables]
                elif match := re.search(r"FROM `([^`]+)`", sql):
                    self.rows = db.tables[match.group(1)]
                else:
                    self.rows = []

            def fetchall(self):
                return self.rows

        return Cursor()

    def rollback(self):
        self.rolled_back = True


def test_geomagia_mysql_reads_the_catalogue_like_the_csv(geomagia_source):
    from fiesta.domain.parse import parse_text
    from fiesta.domain.validate import validate_contribution

    db = FakeGeomagiaDB(geomagia_source.load_lookups())
    generated, texts, meta, times = geomagia_source.build_mysql(db)
    assert generated == "GEOMAGIA50 database" and sorted(texts) == [206, 265]
    # Read-only: SELECTs inside a READ ONLY transaction, ended by a rollback.
    assert db.statements[0] == "START TRANSACTION READ ONLY" and db.rolled_back
    assert all(s.startswith("SELECT") for s in db.statements[1:])
    assert not any("SHORT_NAME" in s for s in db.statements)
    with pytest.raises(ValueError, match="only reads"):
        geomagia_source.MySQLSource(db).query("UPDATE ARCHEODIJ SET BA = 0")

    node = load_deployment(CONFIG_DIR / "fiesta.yaml").node_for("geomagia")
    parsed = parse_text(texts[265])
    head = parsed.tables["contribution"][0]
    assert (head["citation"], head["authors"]) == ("Kovačeva (2009)", "Kovačeva M.")
    assert head["reference"] == "10.1000/example" and head["geomagia_version"] == generated
    (site,) = parsed.tables["sites"]
    assert site["site"] == site["uid"] == "1915" and site["archeo_volcanic"] == "Archeo"
    # The CSV path's rules: missing markers blank (-1, and 0 in counts; 999 for no
    # direction), lookup sentinels kept, codes joined by ':'.
    for blank in ("age_min", "decl", "incl", "num_meas_spec", "af_step", "t_step", "k"):
        assert not site.get(blank), blank
    assert not site.get("sample_id") and not site.get("site_horizon")
    assert (site["ba"], site["num_acc_spec"], site["lat"], site["lon"]) == (
        "69",
        "3",
        "59.3",
        "39.7",
    )
    assert site["ac_id"] == "-1" and site["alteration_checks"] == "No measurement"
    assert site["dating_method_id"] == "101:102"
    assert site["dating_methods"] == "Archeological Age:Calibrated 14C Age"
    assert not site.get("comp_ref") and site["uploader"] == "Fabio Donadini"
    assert (site["region_country"], site["continent"]) == ("Russia", "Asia")
    assert (site["vadm"], site["sigma_vadm"]) == ("9.95", "0.14")  # calculated, not stored
    assert (site["an_use_status_id"], site["anisotropy_use_status"]) == ("0", "Not specified")
    assert not validate_contribution(node, parsed, "1.0").errors

    volcanic_parsed = parse_text(texts[206])
    (volcanic,) = volcanic_parsed.tables["sites"]
    assert volcanic["archeo_volcanic"] == "Volcanic" and volcanic["lon"] == "356.5"
    assert (volcanic["an_use_status_id"], volcanic["anisotropy_use_status"]) == (
        "2",
        "Assessment only",
    )
    assert (volcanic["editor"], volcanic["edit_date"]) == ("Maxwell Brown", "24/07/2017")
    assert volcanic["compilations"].startswith("Schnepp E., Lanos Ph. (2006):")
    assert not validate_contribution(node, volcanic_parsed, "1.0").errors

    # Records are dated by their uploads and edits, so an unchanged one keeps its fingerprint.
    assert times[265] == (datetime(2009, 1, 1, tzinfo=UTC), datetime(2020, 12, 1, tzinfo=UTC))
    assert times[206] == (datetime(2009, 3, 1, tzinfo=UTC), datetime(2017, 7, 24, tzinfo=UTC))
    records = geomagia_source.source_records(texts, meta, generated, "s@example.test", times)
    assert records[265].created_at.year == 2009
    assert records[265].revisions[0].timestamp.year == 2020


def test_geomagia_mysql_settings_come_from_the_environment(geomagia_source):
    assert geomagia_source.mysql_settings({}) is None
    settings = geomagia_source.mysql_settings(
        {"GEOMAGIA_MYSQL_HOST": "db.example", "GEOMAGIA_MYSQL_USER": "reader"}
    )
    assert (settings["host"], settings["port"], settings["database"]) == (
        "db.example",
        3306,
        "geomagia",
    )
    assert settings["user"] == "reader" and settings["charset"] == "utf8mb4"


@pytest.fixture(scope="module")
def magic_source():
    import importlib.util

    path = CONFIG_DIR / "sources" / "magic.py"
    if not path.is_file():
        pytest.skip("no configurations/sources/ in this checkout")
    spec = importlib.util.spec_from_file_location("magic_source", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.asyncio
async def test_magic_heals_broken_version_chains(magic_source, magic_node):
    """MagIC's fix-up of the legacy records: a version another one follows is
    not the latest, and one publication's latest versions holding the same
    records become one chain (oldest first, versions numbered on); those that
    differ stay separate datasets."""
    from fiesta.services.legacy import Inventory

    def rec(cid, version, when, doi, previous=None, latest=True):
        base = _record(cid, b"x")
        return SourceRecord.model_validate(
            base
            | {
                "version": version,
                "previous_id": previous,
                "latest": latest,
                "activated_at": f"{when}T00:00:00+00:00",
                "revisions": [base["revisions"][0] | {"reference_doi": doi}],
            }
        )

    records = [
        # A stale flag: 2 follows 1, yet 1 is still latest.
        rec(1, 1, "2020-01-01", "10.1/a"),
        rec(2, 2, "2021-01-01", "10.1/a", previous=1),
        # One dataset twice: 10 -> 11 (v6) and later 12 (v4), the same records.
        rec(10, 5, "2011-01-01", "10.1/b", latest=False),
        rec(11, 6, "2011-08-09", "10.1/b", previous=10),
        rec(12, 4, "2011-10-07", "10.1/B"),
        # Another dataset of that publication (other records) stays apart.
        rec(13, 1, "2012-01-01", "10.1/b"),
    ]
    held = {
        11: {"sites": {"_n_results": 120}, "_all": {"location": ["Lanzarote"]}},
        12: {"sites": {"_n_results": 120}, "_all": {"location": ["Lanzarote"]}},
        13: {"sites": {"_n_results": 20}, "_all": {"location": ["Tenerife"]}},
    }
    asked = []

    class Legacy:
        async def search(self, index, body, request_timeout=None):
            ids = body["query"]["bool"]["filter"][1]["terms"]["summary.contribution.id"]
            asked.append(sorted(ids))
            return {
                "hits": {
                    "hits": [
                        {"_source": {"summary": {"contribution": {"id": i}} | held[i]}}
                        for i in ids
                        if i in held
                    ]
                }
            }

    inventory = Inventory(format=1, node="magic", source_id="legacy-magic", records=records)
    healed, notes = await magic_source.heal_chains(magic_node, inventory, Legacy())
    out = {r.id: r for r in healed.records}
    assert [r.id for r in healed.records] == [1, 2, 10, 11, 12, 13]
    assert not out[1].latest and out[2].latest
    assert asked == [[11, 12, 13]]
    assert not out[11].latest and out[12].latest and out[12].previous_id == 11
    assert (out[10].version, out[11].version, out[12].version) == (5, 6, 7)
    assert out[13].latest and out[13].previous_id is None
    assert notes == {"stale_latest_cleared": 1, "chains_linked": 1, "links": [[11, 12]]}
    # Healing again changes nothing: a run sends the healed records only once.
    again, notes = await magic_source.heal_chains(magic_node, healed, Legacy())
    assert [record_fingerprint(r) for r in again.records] == [
        record_fingerprint(r) for r in healed.records
    ]
    assert notes["stale_latest_cleared"] == 0 and notes["chains_linked"] == 0
