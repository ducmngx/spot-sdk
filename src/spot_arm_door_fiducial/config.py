"""Door config schema and loader.

The config is a YAML file with one entry per door. Each entry maps a fiducial
tag id to the parameters needed to open the door behind it.

Example:

    doors:
      - name: lab_door
        tag_id: 23
        tag_to_handle: [0.0, 0.0, 0.12]
        handle_type: lever
        swing: pull
        hinge: right
        nav_waypoint: lab-entrance
        approach_standoff_m: 1.0
"""

from __future__ import annotations

import dataclasses
from pathlib import Path
from typing import Optional

import yaml
from bosdyn.api.spot import door_pb2

HANDLE_TYPES = {'lever', 'push_bar'}
SWINGS = {'push': door_pb2.DoorCommand.SWING_DIRECTION_PUSH,
          'pull': door_pb2.DoorCommand.SWING_DIRECTION_PULL}
HINGES = {'left': door_pb2.DoorCommand.HINGE_SIDE_LEFT,
          'right': door_pb2.DoorCommand.HINGE_SIDE_RIGHT}


@dataclasses.dataclass(frozen=True)
class DoorConfig:
    name: str
    tag_id: int
    tag_to_handle: tuple[float, float, float]
    handle_type: str
    swing: str
    hinge: str
    nav_waypoint: Optional[str] = None
    approach_standoff_m: float = 1.0

    def hinge_enum(self) -> int:
        return HINGES[self.hinge]

    def swing_enum(self) -> int:
        return SWINGS[self.swing]


def _validate(d: DoorConfig) -> None:
    if d.handle_type not in HANDLE_TYPES:
        raise ValueError(f'{d.name}: handle_type must be one of {HANDLE_TYPES}, got {d.handle_type!r}')
    if d.swing not in SWINGS:
        raise ValueError(f'{d.name}: swing must be one of {set(SWINGS)}, got {d.swing!r}')
    if d.hinge not in HINGES:
        raise ValueError(f'{d.name}: hinge must be one of {set(HINGES)}, got {d.hinge!r}')
    if len(d.tag_to_handle) != 3:
        raise ValueError(f'{d.name}: tag_to_handle must be [x, y, z]')
    if d.approach_standoff_m <= 0:
        raise ValueError(f'{d.name}: approach_standoff_m must be positive')
    if not 1 <= d.tag_id <= 299:
        # Boston Dynamics reserves 520-549 (dock), 580-584 (Spot Station), 585-586
        # (mission interrupt). Only localization tags (1-299) may be doors.
        raise ValueError(
            f'{d.name}: door tag_id must be in 1-299 (localization range); got {d.tag_id}')


def load(path: str | Path) -> dict[int, DoorConfig]:
    """Load a doors YAML and return {tag_id: DoorConfig}."""
    raw = yaml.safe_load(Path(path).read_text())
    if not isinstance(raw, dict) or 'doors' not in raw:
        raise ValueError(f'{path}: missing top-level "doors" list')

    by_tag: dict[int, DoorConfig] = {}
    for entry in raw['doors']:
        cfg = DoorConfig(
            name=entry['name'],
            tag_id=int(entry['tag_id']),
            tag_to_handle=tuple(float(x) for x in entry['tag_to_handle']),
            handle_type=entry['handle_type'],
            swing=entry['swing'],
            hinge=entry['hinge'],
            nav_waypoint=entry.get('nav_waypoint'),
            approach_standoff_m=float(entry.get('approach_standoff_m', 1.0)),
        )
        _validate(cfg)
        if cfg.tag_id in by_tag:
            raise ValueError(f'duplicate tag_id {cfg.tag_id} in config')
        by_tag[cfg.tag_id] = cfg
    return by_tag


def lookup(by_tag: dict[int, DoorConfig], *, tag_id: Optional[int] = None,
           name: Optional[str] = None) -> DoorConfig:
    """Pick a door config by tag id or by name."""
    if tag_id is not None:
        if tag_id not in by_tag:
            raise KeyError(f'no door config for tag_id {tag_id}')
        return by_tag[tag_id]
    if name is not None:
        for cfg in by_tag.values():
            if cfg.name == name:
                return cfg
        raise KeyError(f'no door config named {name!r}')
    raise ValueError('must specify tag_id or name')
