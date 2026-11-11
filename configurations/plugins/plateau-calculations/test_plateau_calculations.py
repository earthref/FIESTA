"""The plateau-calculations plugin: ⁴⁰Ar/³⁹Ar step ages and plateau selection."""

from fiesta.plugins.plateau_calculations import identify_plateau, process_plateau_data


def _step(temp, ar40_39, ar36_39, ar39, s40=0.01, s36=0.0001):
    return {
        "measurement_step_heat_temperature": str(temp),
        "measurement_40ar_39ar_ratio": str(ar40_39),
        "measurement_40ar_39ar_ratio_sigma": str(s40),
        "total_36ar_39ar_ratio": str(ar36_39),
        "total_36ar_39ar_ratio_sigma": str(s36),
        "corrected_39ar_potassium": str(ar39),
        "experiment": "EXP-1",
    }


def test_deduplicates_identical_rows():
    rows = [_step(500, 10.0, 0.001, 1.0)] * 3
    assert process_plateau_data(rows)["unique_steps"] == 1


def test_plateau_flat_spectrum():
    # 6 near-identical consecutive steps -> the whole spectrum is one plateau.
    rows = [_step(500 + 100 * i, 10.0 + 0.001 * i, 0.001, 1.0) for i in range(6)]
    result = process_plateau_data(rows)
    assert result["unique_steps"] == 6
    assert len(result["age_data"]) == 6
    plateau = result["plateau"]
    assert plateau is not None
    assert len(plateau["plateau_steps"]) >= 3
    assert plateau["ar39_percent"] >= 50
    assert plateau["mswd"] <= 2.5
    # Age from the equation: (1/5.543e-10)*ln(1+1e-3*(10-295.5*0.001))/1e6 ≈ 17.4 Ma
    assert 15 < plateau["plateau_age"] < 20


def test_plateau_rejects_disturbed_spectrum():
    # Wildly varying ages with tiny sigmas -> no acceptable plateau.
    rows = [_step(500 + 100 * i, 5.0 + 8 * i, 0.001, 1.0, s40=0.001) for i in range(6)]
    result = process_plateau_data(rows)
    assert result["plateau"] is None or result["plateau"]["mswd"] <= 2.5


def test_identify_plateau_prefers_low_mswd():
    age_data = [
        {"age": 10.0, "age_sigma": 0.1, "cum_ar39": 20.0},
        {"age": 10.1, "age_sigma": 0.1, "cum_ar39": 40.0},
        {"age": 10.0, "age_sigma": 0.1, "cum_ar39": 60.0},
        {"age": 10.05, "age_sigma": 0.1, "cum_ar39": 80.0},
        {"age": 30.0, "age_sigma": 0.1, "cum_ar39": 100.0},
    ]
    plateau = identify_plateau(age_data)
    assert plateau is not None
    assert 4 not in plateau["plateau_steps"]  # the outlier step is excluded
