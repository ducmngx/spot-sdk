"""Command-line entry point.

    PYTHONPATH=src python -m spot_arm_door_fiducial.cli $SPOT_IP \\
        --config doors.yaml --door lab_door
"""

from __future__ import annotations

import argparse
import sys

from bosdyn.client.util import add_base_arguments, setup_logging

from utils import utils

from . import app, config


def _autodiscover(hostname: str, by_tag: dict[int, config.DoorConfig]) -> config.DoorConfig:
    robot = utils.connect(hostname, client_name='SpotArmDoorFiducialDiscover')
    seen = utils.find_any_fiducial(robot, timeout_sec=5.0)
    for tag_id in seen:
        if tag_id in by_tag:
            return by_tag[tag_id]
    raise RuntimeError(f'No configured fiducial seen. Detected: {sorted(seen)}; '
                       f'configured: {sorted(by_tag)}.')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    add_base_arguments(parser)
    parser.add_argument('--config', required=True, help='Path to doors YAML.')
    sel = parser.add_mutually_exclusive_group()
    sel.add_argument('--door', help='Pick a door by name.')
    sel.add_argument('--tag-id', type=int, help='Pick a door by fiducial tag id.')
    parser.add_argument('--dry-run', action='store_true',
                        help='Detect fiducial and compute geometry but do not move/open.')
    parser.add_argument('--skip-nav', action='store_true',
                        help='Skip GraphNav even if config specifies a waypoint.')
    options = parser.parse_args()
    setup_logging(options.verbose)

    by_tag = config.load(options.config)
    if options.door:
        cfg = config.lookup(by_tag, name=options.door)
    elif options.tag_id is not None:
        cfg = config.lookup(by_tag, tag_id=options.tag_id)
    else:
        cfg = _autodiscover(options.hostname, by_tag)

    app.open_door_for_config(options.hostname, cfg,
                             dry_run=options.dry_run, skip_nav=options.skip_nav)
    return 0


if __name__ == '__main__':
    sys.exit(main())
