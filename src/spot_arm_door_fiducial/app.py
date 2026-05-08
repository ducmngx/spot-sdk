"""Door-opening orchestration: nav → fiducial → approach → OpenDoor.

Reusable Spot primitives (auth, power, stand, fiducial detection, walk-to,
GraphNav) live in src/utils/utils.py. This module owns only the door-specific
logic: choosing AutoGrasp vs AutoPush, building the request, and the high-
level sequence.
"""

from __future__ import annotations

import time

import numpy as np
from bosdyn.api import basic_command_pb2, geometry_pb2
from bosdyn.api.spot import door_pb2
from bosdyn.client import frame_helpers
from bosdyn.client.door import DoorClient
from bosdyn.client.lease import LeaseClient, LeaseKeepAlive

from utils import utils

from .config import DoorConfig
from .geometry import (HandleGeometry, approach_pose_in_vision, build_search_ray,
                       compute_handle_geometry)


def _vec3(p: np.ndarray) -> geometry_pb2.Vec3:
    return geometry_pb2.Vec3(x=float(p[0]), y=float(p[1]), z=float(p[2]))


def _build_request(handle: HandleGeometry, cfg: DoorConfig) -> door_pb2.OpenDoorCommandRequest:
    if cfg.handle_type == 'lever':
        start, end = build_search_ray(handle)
        auto_grasp = door_pb2.DoorCommand.AutoGraspCommand(
            frame_name=frame_helpers.VISION_FRAME_NAME,
            search_ray_start_in_frame=_vec3(start),
            search_ray_end_in_frame=_vec3(end),
            hinge_side=cfg.hinge_enum(),
            swing_direction=cfg.swing_enum(),
        )
        return door_pb2.OpenDoorCommandRequest(
            door_command=door_pb2.DoorCommand.Request(auto_grasp_command=auto_grasp))

    if cfg.handle_type == 'push_bar':
        auto_push = door_pb2.DoorCommand.AutoPushCommand(
            frame_name=frame_helpers.VISION_FRAME_NAME,
            push_point_in_frame=_vec3(handle.handle_in_vision),
            hinge_side=cfg.hinge_enum(),
        )
        return door_pb2.OpenDoorCommandRequest(
            door_command=door_pb2.DoorCommand.Request(auto_push_command=auto_push))

    raise ValueError(f'unsupported handle_type {cfg.handle_type!r}')


def _execute_door_command(robot, request: door_pb2.OpenDoorCommandRequest,
                          timeout_sec: float = 60.0) -> None:
    client = robot.ensure_client(DoorClient.default_service_name)
    response = client.open_door(request)
    feedback_request = door_pb2.OpenDoorFeedbackRequest(door_command_id=response.door_command_id)
    end_time = time.time() + timeout_sec
    while time.time() < end_time:
        fb = client.open_door_feedback(feedback_request)
        if fb.status != basic_command_pb2.RobotCommandFeedbackStatus.STATUS_PROCESSING:
            raise RuntimeError(f'Door command status: {fb.status}')
        if fb.feedback.status == door_pb2.DoorCommand.Feedback.STATUS_COMPLETED:
            robot.logger.info('Opened door.')
            return
        time.sleep(0.5)
    raise TimeoutError('Door command timed out.')


def open_door_for_config(hostname: str, cfg: DoorConfig, *, dry_run: bool = False,
                         skip_nav: bool = False) -> None:
    robot = utils.connect(hostname, client_name='SpotArmDoorFiducial')
    assert robot.has_arm(), 'Robot requires an arm to open a door.'
    utils.check_estop(robot)

    lease_client = robot.ensure_client(LeaseClient.default_service_name)
    lease_client.take()
    with LeaseKeepAlive(lease_client, must_acquire=True, return_at_exit=True):
        if cfg.nav_waypoint and not skip_nav:
            utils.power_on(robot)
            utils.navigate_to_waypoint(robot, cfg.nav_waypoint)

        utils.power_on(robot)
        utils.stand(robot)
        utils.pitch_up(robot)

        robot.logger.info('Looking for fiducial tag_id=%d (%s)...', cfg.tag_id, cfg.name)
        vision_T_tag = utils.find_fiducial(robot, cfg.tag_id, timeout_sec=10.0)
        if vision_T_tag is None:
            raise RuntimeError(f'Fiducial tag_id={cfg.tag_id} not seen.')

        handle = compute_handle_geometry(vision_T_tag, cfg.tag_to_handle)
        robot.logger.info('Handle in vision: %s', handle.handle_in_vision)

        if dry_run:
            robot.logger.info('--dry-run: skipping walk-to and OpenDoor.')
            utils.safe_power_off(robot)
            return

        utils.walk_to_pose(robot, approach_pose_in_vision(handle, cfg.approach_standoff_m))

        # Re-pitch + re-detect after the walk to refresh the handle pose.
        utils.pitch_up(robot)
        vision_T_tag = utils.find_fiducial(robot, cfg.tag_id, timeout_sec=5.0)
        if vision_T_tag is None:
            raise RuntimeError('Lost fiducial after approach.')
        handle = compute_handle_geometry(vision_T_tag, cfg.tag_to_handle)

        _execute_door_command(robot, _build_request(handle, cfg))
        utils.safe_power_off(robot)
        robot.operator_comment(f'Opened door {cfg.name} via fiducial {cfg.tag_id}.')
