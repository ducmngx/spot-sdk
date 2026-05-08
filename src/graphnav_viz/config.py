"""App config schema for graphnav_viz.

A YAML file (default `./graphnav_viz.yaml`) tells the server where graphs live
and what server settings to use. CLI flags override config values when given.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import yaml
from pydantic import BaseModel, Field


class ExplicitGraph(BaseModel):
    """A graph registered by name with an explicit path.

    Useful for graphs that live outside `graphs_root`, or to give a friendly
    URL slug to a deeply-nested graph.
    """
    name: str
    path: Path


class ServerSettings(BaseModel):
    host: str = '127.0.0.1'
    port: int = 8000


class AppConfig(BaseModel):
    """Top-level config."""
    graphs_root: Optional[Path] = Path('recorded_graphs')
    graphs: list[ExplicitGraph] = Field(default_factory=list)
    server: ServerSettings = Field(default_factory=ServerSettings)


def load_config(path: Optional[Path]) -> AppConfig:
    """Load `path` if it exists; otherwise return defaults.

    Search order when `path` is None:
      1. ./graphnav_viz.yaml in cwd
      2. built-in defaults
    """
    if path is None:
        candidate = Path.cwd() / 'graphnav_viz.yaml'
        if candidate.exists():
            path = candidate
    if path is None:
        return AppConfig()
    if not path.exists():
        raise FileNotFoundError(f'Config file not found: {path}')
    return AppConfig.model_validate(yaml.safe_load(path.read_text()) or {})
