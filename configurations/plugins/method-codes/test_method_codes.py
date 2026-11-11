"""The method-codes plugin: the codes file, its validation vocabulary and route."""

import asyncio

import pytest
from fastapi import HTTPException

from fiesta.domain.parse import ParsedContribution
from fiesta.domain.validate import Validator
from fiesta.plugins import active_plugins, all_plugins
from fiesta.plugins.method_codes import load_codes

PLUGIN = "method-codes"


def _with(node, options=None, plugins=None):
    update: dict = {"plugins": {**node.plugins, PLUGIN: options or {}}}
    if plugins is not None:
        update["features"] = node.features.model_copy(update={"plugins": plugins})
    return node.model_copy(update=update)


def test_codes_file_and_frontend_config(magic_node):
    plugin = all_plugins()[PLUGIN]
    assert plugin in active_plugins(magic_node)
    codes = load_codes(magic_node, plugin.options(magic_node))
    assert codes and all("codes" in group for group in codes.values())
    assert plugin.frontend_config(magic_node) == {"has_codes": True}
    # A node without the file has no codes: no vocabulary, the route 404s.
    missing = _with(magic_node, {"file": "none.json"})
    assert plugin.frontend_config(missing) == {"has_codes": False}
    assert plugin.vocabularies(missing) == {}
    route = next(r for r in plugin.build_router().routes if r.path == "")
    with pytest.raises(HTTPException) as raised:
        asyncio.run(route.endpoint(missing))
    assert raised.value.status_code == 404
    assert asyncio.run(route.endpoint(magic_node)) == codes
    with pytest.raises(ValueError, match="file"):
        plugin.options(_with(magic_node, {"file": "../magic.yaml"}))


def test_cv_columns_take_the_codes_case_insensitively(magic_node):
    validator = Validator(magic_node)
    # No MagIC data model column says cv("method_codes") today (they say
    # type("method_codes"), not enforced), so give one a table here.
    validator.model = {
        "tables": {
            "sites": {
                "columns": {"method_codes": {"type": "List", "validations": ['cv("method_codes")']}}
            }
        }
    }
    parsed = ParsedContribution(tables={"sites": [{"method_codes": "lp-dc0:LP-DC1:NOPE-1"}]})
    report = validator.validate(parsed)
    assert [issue.message for issue in report.errors] == [
        "'NOPE-1' is not in the controlled vocabulary 'method_codes'"
    ]
    # Without the plugin the vocabulary is unknown, so nothing is checked.
    off = Validator(_with(magic_node, plugins=["poles"]))
    off.model = validator.model
    assert off.validate(parsed).is_valid
