"""The plateau-calculations plugin: contributed ⁴⁰Ar/³⁹Ar ages, never refitted."""

from fiesta.plugins.plateau_calculations import age_kind, build_argon, build_steps


def _step(name, seq, age, k39, experiment="EXP-1", **extra):
    return {
        "measurement": name,
        "experiment": experiment,
        "sequence": str(seq),
        "temp": str(500 + 100 * seq),
        "temp_unit": "C",
        "age": str(age),
        "age_sigma_analytical": "0.1",
        "age_unit": "Ma",
        "corrected_39ar_potassium": str(k39),
        **extra,
    }


def test_steps_use_contributed_ages_and_normalised_39ar():
    rows = [_step("B", 2, 10.2, 3.0), _step("A", 1, 9.0, 1.0)]
    result = build_steps(rows)
    steps = result["steps"]
    # Sorted by sequence; ages are the contributed ones, not recomputed.
    assert [s["measurement"] for s in steps] == ["A", "B"]
    assert [s["age"] for s in steps] == [9.0, 10.2]
    assert result["ar39_source"] == "corrected_39ar_potassium"
    assert steps[0]["ar39_start"] == 0 and steps[0]["ar39_end"] == 25.0
    assert steps[1]["ar39_end"] == 100.0


def test_steps_fall_back_to_equal_widths_and_keep_reused_names():
    rows = [
        {"measurement": "A", "age": "1", "experiment": "E"},
        {"measurement": "A", "age": "2", "experiment": "E"},  # legacy name reuse: kept
        {"measurement": "A", "age": "2", "experiment": "E"},  # identical row: dropped
        {"measurement": "C", "experiment": "E"},  # no contributed age: a gap
    ]
    result = build_steps(rows)
    assert result["ar39_source"] is None
    assert [s["age"] for s in result["steps"]] == [1.0, 2.0]
    assert result["steps_without_age"] == 1
    assert result["steps"][1]["ar39_end"] == 100.0 * 2 / 3


def test_isochron_points_come_from_the_corrected_ratios():
    row = _step(
        "A",
        1,
        10,
        1,
        corrected_39ar_k_40ar_rad_atm_ratio="0.1",
        corrected_39ar_k_40ar_rad_atm_ratio_sigma="0.001",
        corrected_36ar_atm_40ar_rad_atm_ratio="0.002",
        corrected_36ar_atm_40ar_rad_atm_ratio_sigma="0.0001",
        corr_coefficient_36_40_over_39_40="0.3",
    )
    step = build_steps([row])["steps"][0]
    assert step["inverse"] == [0.1, 0.001, 0.002, 0.0001, 0.3]
    assert step["normal"] is None


def test_age_kinds():
    assert age_kind("Age Plateau") == "plateau"
    assert age_kind("Inverse Isochron") == "inverse_isochron"
    assert age_kind("Normal Isochron") == "normal_isochron"
    assert age_kind("Total Gas Fusion") == "total_fusion"
    assert age_kind("Weighted Mean") == "other"


def test_build_argon_links_experiments_specimens_and_contributed_ages():
    tables = {
        "measurements": [
            _step("E1A", 1, 10.0, 1, experiment="E1"),
            _step("E1B", 2, 10.1, 1, experiment="E1"),
            _step("S1", 1, 20.0, 1, experiment="33922"),  # experiments row says 33922-01
            _step("X1", 1, 5.0, 1, experiment="LOOSE"),  # no experiments row
        ],
        "experiments": [
            {
                "experiment": "E1",
                "specimen": "SP1",
                "age_calculation_method": "Plateau",
                "age_is_preferred": "t",
                "age": "10.05",
                "age_sigma_analytical": "0.07",
                "age_mswd": "0.5",
                "age_n": "2",
                "age_plateau_width": "100",
                "age_steps": "E1A:E1B",
            },
            {
                "experiment": "E1",
                "specimen": "SP1",
                "age_calculation_method": "Inverse Isochron",
                "age": "10.0",
                "40ar_39ar_ratio": "5.6",
                "40ar_36ar_ratio": "298.6",
            },
            {"experiment": "33922-01", "specimen": "SP2", "age_calculation_method": "Total fusion"},
        ],
        "specimens": [
            {
                "specimen": "SP1",
                "age_experiments": "E1",
                "age": "10.05",
                "age_sigma_analytical": "0.07",
            },
            {"specimen": "SP2", "age": "20"},  # no age_experiments: by experiments.specimen
        ],
    }
    data = build_argon(tables)
    by_name = {e["experiment"]: e for e in data["experiments"]}
    assert set(by_name) == {"E1", "33922-01", "LOOSE"}

    plateau, isochron = by_name["E1"]["ages"]
    assert plateau["kind"] == "plateau" and plateau["preferred"] is True
    assert plateau["age"] == 10.05 and plateau["mswd"] == 0.5 and plateau["steps"] == ["E1A", "E1B"]
    assert isochron["kind"] == "inverse_isochron"
    assert (isochron["ar40_ar39"], isochron["ar40_ar36"]) == (5.6, 298.6)

    assert len(by_name["33922-01"]["steps"]) == 1  # prefix-matched measurements
    assert by_name["LOOSE"]["ages"] == []

    specimens = {s["specimen"]: s for s in data["specimens"]}
    assert specimens["SP1"]["experiments"] == ["E1"]
    assert specimens["SP1"]["age"] == 10.05
    assert specimens["SP2"]["experiments"] == ["33922-01"]
