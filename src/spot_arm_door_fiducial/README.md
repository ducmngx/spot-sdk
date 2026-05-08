# spot_arm_door_fiducial

Automated door opening with Spot using AprilTag fiducials. Replaces the
two-click flow in `python/examples/arm_door` with a config-driven pipeline:

    GraphNav → fiducial detection → SE2 approach → OpenDoor (AutoGrasp / AutoPush)

## Setup

From the repo root, with the venv active:

    pip install pyyaml

(`bosdyn-client`, `bosdyn-mission`, etc. should already be installed via the
quickstart.)

## Per-door config

Copy `doors.example.yaml` to `doors.yaml` and edit. Each entry maps a tag id
to the door's mechanical params. See the example file for the full schema.

A fiducial mounted on the door:

- flat against the door face,
- with the tag's +X axis pointing out toward the robot (i.e. you can read it),
- and +Z pointing up the door.

`tag_to_handle` is the meters offset from tag origin to handle in tag frame —
typically `[0, 0, 0.10–0.20]` (handle some cm above tag).

## Run

    PYTHONPATH=src python -m spot_arm_door_fiducial.cli $SPOT_IP \
        --config doors.yaml --door lab_door

Selection options:
- `--door NAME`      pick by config name
- `--tag-id N`       pick by tag id
- (neither)          auto-pick the first detected configured tag
- `--dry-run`        detect + compute but don't move or open
- `--skip-nav`       ignore `nav_waypoint` even if set

Prerequisites at runtime:
- External e-stop running (see `python/examples/estop`).
- Robot has an arm and is not e-stopped.
- If `nav_waypoint` is set, a graph must already be uploaded and the robot
  localized (run `graph_nav_command_line` once if needed).

## Layout

| File | Purpose |
|---|---|
| `cli.py` | argparse, top-level entry point |
| `app.py` | orchestration + door request building (AutoGrasp / AutoPush) |
| `config.py` | YAML schema + `DoorConfig` dataclass |
| `geometry.py` | tag→handle offset, search ray, approach pose (pure math) |

Reusable Spot primitives (auth/connect, power, stand, pitch, fiducial detect,
SE2 walk, GraphNav, image fetch) live in `src/utils/utils.py`.
