"""Pose math used to derive the handle, search ray, and approach pose from a
detected fiducial.

Convention: the fiducial is mounted flat against the door face with its +X
axis pointing OUT of the door (toward the robot). +Z points up the door, +Y
points along the door surface (right-hand rule). All offsets in this module
treat the tag frame this way; if a real-world tag is mounted rotated, supply
a different `tag_to_handle` offset in the config or pre-rotate.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from bosdyn.client.math_helpers import Quat, SE2Pose, SE3Pose


@dataclass(frozen=True)
class HandleGeometry:
    handle_in_vision: np.ndarray  # 3,
    door_normal_in_vision: np.ndarray  # 3, unit vector pointing AWAY from door surface (toward robot)


def compute_handle_geometry(vision_T_tag: SE3Pose,
                            tag_to_handle: tuple[float, float, float]) -> HandleGeometry:
    """Apply the configured tag→handle offset to get the handle pose in vision."""
    tag_T_handle = SE3Pose(x=tag_to_handle[0], y=tag_to_handle[1], z=tag_to_handle[2],
                           rot=Quat())
    vision_T_handle = vision_T_tag * tag_T_handle

    # Tag's +X axis in vision: rotate (1, 0, 0) by tag's quaternion.
    tag_x_in_vision = _rotate_vec(vision_T_tag.rot, np.array([1.0, 0.0, 0.0]))

    return HandleGeometry(
        handle_in_vision=np.array([vision_T_handle.x, vision_T_handle.y, vision_T_handle.z]),
        door_normal_in_vision=tag_x_in_vision / np.linalg.norm(tag_x_in_vision),
    )


def build_search_ray(handle: HandleGeometry,
                     half_length_m: float = 0.25) -> tuple[np.ndarray, np.ndarray]:
    """Return (start, end) for AutoGraspCommand search ray, perpendicular to door."""
    n = handle.door_normal_in_vision
    start = handle.handle_in_vision + half_length_m * n   # robot side
    end = handle.handle_in_vision - half_length_m * n     # past the door surface
    return start, end


def approach_pose_in_vision(handle: HandleGeometry, standoff_m: float) -> SE2Pose:
    """Stand pose `standoff_m` in front of the door, facing the door.

    Position is `handle + standoff * door_normal` projected to the floor plane.
    Yaw is the heading from that point toward the handle.
    """
    n = handle.door_normal_in_vision
    n_planar = np.array([n[0], n[1], 0.0])
    n_norm = np.linalg.norm(n_planar)
    if n_norm < 1e-6:
        raise ValueError('door normal is nearly vertical; cannot compute approach pose')
    n_planar /= n_norm

    target_xy = handle.handle_in_vision[:2] + standoff_m * n_planar[:2]
    # Heading: face from target_xy toward handle, i.e. opposite of n_planar.
    heading = math.atan2(-n_planar[1], -n_planar[0])
    return SE2Pose(x=float(target_xy[0]), y=float(target_xy[1]), angle=heading)


def _rotate_vec(q: Quat, v: np.ndarray) -> np.ndarray:
    """Rotate a 3-vector by a Quat (w, x, y, z)."""
    qv = np.array([q.x, q.y, q.z])
    t = 2.0 * np.cross(qv, v)
    return v + q.w * t + np.cross(qv, t)
