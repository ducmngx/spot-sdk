# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository overview

The Spot SDK is Boston Dynamics' client SDK for the Spot robot. It is a multi-package Python SDK generated on top of a gRPC/protobuf API. The SDK version is tracked in the top-level `VERSION` file and injected into every package at build time via the `BOSDYN_SDK_VERSION` environment variable — `setup.py` files in this repo will refuse to run without it.

## Top-level layout

- `protos/bosdyn/api/` — Source-of-truth `.proto` files for the public Spot API. The `protos/setup.py` builds a custom `bosdyn-api` wheel that compiles `.proto` → `_pb2.py` / `_pb2_grpc.py` at build time (see the `proto_build` and `BuildPy` commands in `protos/setup.py`). Generated python lives under `bosdyn.api.*`; do not check generated files in.
- `choreography_protos/` — Same pattern as `protos/`, but for the `bosdyn-choreography-protos` wheel.
- `python/` — Hand-written Python client packages, each its own wheel:
  - `bosdyn-core` — base utilities (`bosdyn.util`, geometry helpers).
  - `bosdyn-client` — the main client library (`bosdyn.client.*`); contains a per-service module (e.g. `robot_command.py`, `graph_nav.py`, `data_acquisition.py`, `auth.py`, `estop.py`, ~85 modules total) plus `sdk.py` / `robot.py` which are the canonical entry points. `command_line.py` provides the `bosdyn` CLI.
  - `bosdyn-mission` — mission service client + node helpers.
  - `bosdyn-choreography-client` — choreography client (depends on `bosdyn-choreography-protos`).
  - `bosdyn-orbit` — Orbit (formerly Scout) REST client.
  - `bosdyn-scout` — deprecated, kept for back-compat with `bosdyn-orbit`.
  - `python/examples/` — ~90 standalone example apps, one per directory, each with its own `requirements.txt`. Useful as reference for how clients are wired together.
- `tools/wheels.py` — The build orchestrator. Always invoke wheel builds through this script, not via `setup.py` directly.
- `prebuilt/` — Output directory for built `.whl` files.
- `docs/` — Conceptual docs, payload ICD, generated proto/python references.

## Build & dev setup

All build commands flow through `tools/wheels.py`, which sets `BOSDYN_SDK_VERSION` from `VERSION` and shells out to per-package `setup.py`:

```bash
# Build every wheel into prebuilt/ (bosdyn-api and bosdyn-choreography-protos
# are built specially because they compile .proto files first).
python tools/wheels.py build

# Build a single wheel.
python tools/wheels.py build bosdyn-client

# List wheels that can be built.
python tools/wheels.py list-build

# Developer install: builds + installs bosdyn-api, then editable-installs
# every other bosdyn-* python package so local edits take effect immediately.
python tools/wheels.py dev-setup
```

Useful flags: `-n` dry run, `-v` verbose, `--install-deps` (install proto build deps from `protos/requirements-setup-linux-pinned.txt`), `--skip-git-check` (the build refuses to run on a dirty proto tree by default), `--uninstall-existing`.

If you edit `.proto` files, you must rebuild `bosdyn-api` (or `bosdyn-choreography-protos`) for changes to be visible — the generated `_pb2.py` files are produced during the wheel build, not committed.

## Tests & lint

Tests are pytest-based and live under `python/<package>/tests/` (e.g. `python/bosdyn-client/tests/test_auth_client.py`). Most use mock gRPC servicers from `tests/helpers.py`.

```bash
# Run a package's full test suite (after dev-setup so imports resolve).
cd python/bosdyn-client && pytest

# Run a single test file or test.
pytest python/bosdyn-client/tests/test_auth_client.py
pytest python/bosdyn-client/tests/test_auth_client.py::TestAuthClient::test_foo
```

Lint config for the python tree is `python/pylintrc`. The codebase follows the Google Python style guide (per `python/README.md`). Minimum supported Python is 3.7.

## Architectural notes

- **gRPC client pattern.** Each Spot service has a `.proto` in `protos/bosdyn/api/`, a generated stub in `bosdyn.api.<svc>_service_pb2_grpc`, and a hand-written client in `bosdyn.client.<svc>` that subclasses `bosdyn.client.common.BaseClient`. New service support means: add proto → rebuild `bosdyn-api` → write a `BaseClient` subclass + register it on the SDK.
- **Entry point.** Apps create an `bosdyn.client.sdk.Sdk`, call `create_robot(hostname)` to get a `Robot`, then `robot.ensure_client('service-name')` to get a typed client. Auth, time-sync, estop, and lease are cross-cutting concerns layered on top of `Robot`.
- **Cross-package version coupling.** All `bosdyn-*` wheels are pinned to the same `SDK_VERSION` and depend on each other with `==` constraints, so partial upgrades won't work — rebuild/install the set together.
- **Examples are the integration tests for UX.** When changing a public client API, grep `python/examples/` for usages; they're shipped to customers.

## Custom packages under `src/`

This fork adds three packages under `src/` that are *not* part of the upstream Boston Dynamics SDK. They live outside `python/` so they're never built into wheels; run them directly with `PYTHONPATH=src`.

- `src/utils/utils.py` — shared Spot client primitives reused across the custom packages: `connect()` (SDK + auth + timesync), `power_on`/`safe_power_off`/`stand`/`pitch_up`, `check_estop`, `find_fiducial`/`find_any_fiducial` (`WorldObjectClient`-based), `walk_to_pose` (synchro SE2 trajectory), `navigate_to_waypoint` (GraphNav), `get_images_as_cv2` (lazy cv2 import). Import as `from utils import utils`.
- `src/spot_arm_door_fiducial/` — automated door opener driven by AprilTag fiducials. CLI: `PYTHONPATH=src python -m spot_arm_door_fiducial.cli $SPOT_IP --config doors.yaml --door <name>`. Config (`doors.yaml`) maps fiducial `tag_id` → handle/swing/hinge/nav-waypoint. **Strict rule, enforced in both `spot_arm_door_fiducial.config` and `graphnav_viz.schema`:** only fiducials with `tag_id` in `1–299` (the Boston Dynamics localization range) may be doors. 520–549 (dock), 580–584 (Spot Station dock), and 585–586 (mission interrupt) are reserved.
- `src/graphnav_viz/` — browser-based annotation app for recorded GraphNav maps. CLI: `PYTHONPATH=src python -m graphnav_viz.server` (reads `./graphnav_viz.yaml` if present; see `graphnav_viz.example.yaml`). FastAPI backend + vanilla-JS frontend (canvas 2D + three.js 3D, no build step). Annotations saved per-graph as `<graph>/annotations.json`; `Export doors.yaml` writes a YAML directly consumable by `spot_arm_door_fiducial`. See `src/graphnav_viz/README.md` for the full schema and API.

**Data flow** between them:

```
recorded GraphNav map (recorded_graphs/<name>/)
        │
        ▼
graphnav_viz       →   <graph>/annotations.json   →   <graph>/doors.yaml
(annotation app)        (sidecar; never mutates                    │
                         the recorded graph)                       ▼
                                                       spot_arm_door_fiducial
                                                          (executes on robot)
```

## Conventions

- **`recorded_graphs/`** is the default parent directory for downloaded GraphNav maps; subdirs (up to 2 levels deep) that contain a `graph` proto file are auto-discovered by `graphnav_viz`. The folder is gitignored — graphs are large binary data, not source.
- **`.env`** (per `.env_template`) holds Spot credentials (`BOSDYN_CLIENT_USERNAME`, `BOSDYN_CLIENT_PASSWORD`, `SPOT_IP`). Source it before running anything that talks to a robot. The SDK reads the username/password env vars automatically (see `python/bosdyn-client/src/bosdyn/client/util.py`).
- **`.venv`** holds the editable Spot-SDK install (`bosdyn-client==5.1.4` from PyPI; for the custom packages just set `PYTHONPATH=src`). All custom-package commands are documented to be run from the repo root with `PYTHONPATH=src` so imports resolve without a `pip install -e .`.
