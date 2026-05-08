"""Convert annotations.json into doors.yaml consumed by spot_arm_door_fiducial."""

from __future__ import annotations

from pathlib import Path

import yaml

from .schema import Annotations


def write_doors_yaml(annotations: Annotations, out_path: str | Path) -> Path:
    out_path = Path(out_path)
    payload = {'doors': [
        {
            'name': d.name,
            'tag_id': d.tag_id,
            'tag_to_handle': list(d.tag_to_handle),
            'handle_type': d.handle_type,
            'swing': d.swing,
            'hinge': d.hinge,
            **({'nav_waypoint': d.nav_waypoint} if d.nav_waypoint else {}),
            'approach_standoff_m': d.approach_standoff_m,
        }
        for d in annotations.doors
    ]}
    tmp = out_path.with_suffix(out_path.suffix + '.tmp')
    tmp.write_text(yaml.safe_dump(payload, sort_keys=False))
    tmp.replace(out_path)
    return out_path
