"""Saved search ids: the same state always gets the same id, empty fields do
not change it, and the state is validated and capped."""

import pytest
from pydantic import ValidationError

from fiesta.services.searches import (
    MAX_STATE_BYTES,
    SearchState,
    StateTooLarge,
    canonical,
    check_size,
    search_id,
)


def test_id_ignores_empty_fields_and_key_order():
    a = SearchState(query="basalt", ranges=[], sort="", settings={})
    b = SearchState.model_validate({"settings": {}, "query": "basalt"})
    assert canonical(a) == {"query": "basalt"}
    assert search_id("magic", a) == search_id("magic", b)


def test_id_differs_by_state_and_node():
    base = SearchState(query="basalt")
    assert search_id("magic", base) != search_id("cdr", base)
    assert search_id("magic", base) != search_id(
        "magic", SearchState(query="basalt", mine="in_prep")
    )
    colored = SearchState(query="basalt", settings={"map.color": "age"})
    assert search_id("magic", base) != search_id("magic", colored)


def test_settings_order_does_not_change_id():
    a = SearchState(settings={"poles.vgp": True, "map.color": "age"})
    b = SearchState(settings={"map.color": "age", "poles.vgp": True})
    assert search_id("magic", a) == search_id("magic", b)


def test_state_is_validated():
    with pytest.raises(ValidationError):
        SearchState.model_validate({"level": "Sites"})  # in the path, not the state
    with pytest.raises(ValidationError):
        SearchState(mine="everyone")
    with pytest.raises(ValidationError):
        SearchState(settings={"Bad Key": 1})


def test_state_size_is_capped():
    check_size(SearchState(query="x" * 2000))
    big = SearchState(settings={f"plugin.k{i}": "x" * 500 for i in range(40)})
    assert len(str(big.settings)) > MAX_STATE_BYTES
    with pytest.raises(StateTooLarge):
        check_size(big)
