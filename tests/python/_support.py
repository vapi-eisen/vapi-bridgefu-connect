"""Shared test helpers: repo paths and optional access to the upstream checkout."""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
UPSTREAM = Path(os.environ.get("LAB_UPSTREAM_REPO", str(Path.home() / "Developer" / "bridgefu-vapi-awsconnect")))


def load_handler():
    spec = importlib.util.spec_from_file_location("direct_session_handler", ROOT / "lambda" / "direct_session" / "handler.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def upstream_module(relative: str, name: str):
    """Import a module from the upstream checkout, or return None when it is absent."""
    path = UPSTREAM / relative
    if not path.is_file():
        return None
    parent = str(path.parent)
    if parent not in sys.path:
        sys.path.insert(0, parent)
    try:
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        # dataclasses under `from __future__ import annotations` resolve types via
        # sys.modules[cls.__module__], so register the module before executing it.
        sys.modules[name] = module
        spec.loader.exec_module(module)
        return module
    except Exception:  # noqa: BLE001 - upstream may need dependencies we do not ship
        sys.modules.pop(name, None)
        return None


def load_cfn(path: Path):
    """Parse a CloudFormation YAML template, turning intrinsic tags into {tag: value} dicts."""
    import yaml

    class Loader(yaml.SafeLoader):
        pass

    def tag(loader, suffix, node):
        if isinstance(node, yaml.ScalarNode):
            return {suffix: loader.construct_scalar(node)}
        if isinstance(node, yaml.SequenceNode):
            return {suffix: loader.construct_sequence(node)}
        return {suffix: loader.construct_mapping(node)}

    Loader.add_multi_constructor("!", tag)
    return yaml.load(Path(path).read_text(encoding="utf-8"), Loader=Loader)
