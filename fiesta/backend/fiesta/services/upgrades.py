"""Upgrading uploads written against an older data-model version of a node
(fiesta.domain.upgrade over the node's models and its plugins' steps)."""

from dataclasses import dataclass

from fiesta.domain.parse import ParsedContribution, export_text
from fiesta.domain.upgrade import (
    UpgradeOptions,
    UpgradeReport,
    UpgradeStep,
    detect_version,
    upgrade,
)
from fiesta.nodeconfig import NodeConfig

REPORT_NAME = "upgrade-report.txt"


@dataclass
class UpgradeResult:
    parsed: ParsedContribution
    report: UpgradeReport


def upgrade_steps(node: NodeConfig) -> dict[tuple[str, str], UpgradeStep]:
    """The active plugins' upgrade steps by (from, to) version."""
    from fiesta.plugins import active_plugins

    steps: dict[tuple[str, str], UpgradeStep] = {}
    for plugin in active_plugins(node):
        for step in plugin.upgrade_steps(node):
            key = (step.from_version, step.to_version)
            if key in steps:
                raise ValueError(f"two plugins upgrade {key[0]} to {key[1]}")
            steps[key] = step
    return steps


def detect(node: NodeConfig, parsed: ParsedContribution) -> tuple[str | None, bool]:
    return detect_version(parsed, node.data_model.versions, node.load_data_model)


def upgrade_parsed(
    node: NodeConfig, parsed: ParsedContribution, options: UpgradeOptions | None = None
) -> UpgradeResult | None:
    """`parsed` upgraded to the node's latest data model, or None when it is
    already written in it (or in no version the node knows)."""
    version, guessed = detect(node, parsed)
    versions, latest = node.data_model.versions, node.data_model.latest
    if version is None or version == latest or latest not in versions:
        return None
    start, end = versions.index(version), versions.index(latest)
    if start > end:
        return None
    upgraded, report = upgrade(
        parsed,
        versions[start : end + 1],
        node.load_data_model,
        upgrade_steps(node),
        options,
        guessed=guessed,
        model_name=f"{node.node.key} Data Model",
    )
    return UpgradeResult(upgraded, report)


def upgraded_text(node: NodeConfig, result: UpgradeResult) -> str:
    return export_text(result.parsed, node.load_data_model(node.data_model.latest))
