"""Read a downloaded GraphNav graph (no VTK).

Returns plain-Python dicts ready for JSON serialization. All poses are in
the seed (anchored) frame when anchors are present; if not, falls back to a
BFS layout in an arbitrary frame seeded at the first waypoint.
"""

from __future__ import annotations

import os
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
from bosdyn.api.graph_nav import map_pb2
from bosdyn.client.math_helpers import SE3Pose


@dataclass
class GraphData:
    waypoints: list[dict]   # {id, name, snapshot_id, x, y, z, qw, qx, qy, qz}
    edges: list[dict]       # {from, to}
    fiducials: list[dict]   # {tag_id, category, x, y, z, qw, qx, qy, qz}
    bounds: dict            # {min_x, max_x, min_y, max_y, min_z, max_z}
    anchored: bool


def fiducial_category(tag_id: int) -> str:
    """Classify a fiducial by Boston Dynamics' reserved-range conventions.

    See dev.bostondynamics.com docs on fiducial ranges:
      1-299    localization (only these are eligible to be marked as doors)
      520-549  Spot Dock
      580-584  Spot Dock (Spot Station)
      585-586  mission interrupt
      else     unknown
    """
    if 1 <= tag_id <= 299:
        return 'localization'
    if 520 <= tag_id <= 549:
        return 'dock'
    if 580 <= tag_id <= 584:
        return 'dock_station'
    if 585 <= tag_id <= 586:
        return 'mission_interrupt'
    return 'unknown'


def _se3_from_proto(p) -> SE3Pose:
    return SE3Pose.from_proto(p)


def _waypoint_dict(wp_id: str, name: str, snapshot_id: str, pose: SE3Pose) -> dict:
    return {
        'id': wp_id, 'name': name, 'snapshot_id': snapshot_id,
        'x': pose.x, 'y': pose.y, 'z': pose.z,
        'qw': pose.rot.w, 'qx': pose.rot.x, 'qy': pose.rot.y, 'qz': pose.rot.z,
    }


def _bfs_layout(graph: map_pb2.Graph) -> dict[str, SE3Pose]:
    """Compose edge transforms from the first waypoint outward (unanchored fallback)."""
    from bosdyn.client.math_helpers import Quat
    if not graph.waypoints:
        return {}
    adj: dict[str, list] = {}
    for e in graph.edges:
        adj.setdefault(e.id.from_waypoint, []).append(e)
        adj.setdefault(e.id.to_waypoint, []).append(e)

    poses: dict[str, SE3Pose] = {graph.waypoints[0].id: SE3Pose(0, 0, 0, Quat())}
    queue = [graph.waypoints[0].id]
    while queue:
        cur = queue.pop(0)
        for e in adj.get(cur, []):
            other = e.id.to_waypoint if e.id.from_waypoint == cur else e.id.from_waypoint
            if other in poses:
                continue
            tform = _se3_from_proto(e.from_tform_to)
            poses[other] = (poses[cur] * tform) if e.id.from_waypoint == cur \
                else (poses[cur] * tform.inverse())
            queue.append(other)
    return poses


def load(graph_dir: str | Path) -> GraphData:
    graph_dir = Path(graph_dir)
    graph = map_pb2.Graph()
    graph.ParseFromString((graph_dir / 'graph').read_bytes())

    # Anchor lookup: anchor.id -> SE3Pose in seed frame.
    anchor_by_wp: dict[str, SE3Pose] = {
        a.id: _se3_from_proto(a.seed_tform_waypoint) for a in graph.anchoring.anchors}
    anchored = len(anchor_by_wp) >= len(graph.waypoints) and len(graph.waypoints) > 0

    if anchored:
        wp_pose = anchor_by_wp
    else:
        wp_pose = _bfs_layout(graph)

    waypoints = []
    for wp in graph.waypoints:
        pose = wp_pose.get(wp.id)
        if pose is None:
            continue
        waypoints.append(_waypoint_dict(wp.id, wp.annotations.name or wp.id[:8],
                                        wp.snapshot_id, pose))

    edges = [{'from': e.id.from_waypoint, 'to': e.id.to_waypoint} for e in graph.edges]

    fiducials: list[dict] = []
    if anchored:
        for o in graph.anchoring.objects:
            try:
                tag_id = int(o.id)
            except ValueError:
                # Anchored object with non-integer id — skip; fiducials in this dataset
                # use the tag_id as the object id.
                continue
            pose = _se3_from_proto(o.seed_tform_object)
            fiducials.append({'tag_id': tag_id, 'category': fiducial_category(tag_id),
                              'x': pose.x, 'y': pose.y, 'z': pose.z,
                              'qw': pose.rot.w, 'qx': pose.rot.x,
                              'qy': pose.rot.y, 'qz': pose.rot.z})

    if waypoints:
        xs = [w['x'] for w in waypoints]
        ys = [w['y'] for w in waypoints]
        zs = [w['z'] for w in waypoints]
        bounds = {'min_x': min(xs), 'max_x': max(xs),
                  'min_y': min(ys), 'max_y': max(ys),
                  'min_z': min(zs), 'max_z': max(zs)}
    else:
        bounds = {'min_x': 0, 'max_x': 0, 'min_y': 0, 'max_y': 0, 'min_z': 0, 'max_z': 0}

    return GraphData(waypoints=waypoints, edges=edges, fiducials=fiducials,
                     bounds=bounds, anchored=anchored)


ODOM_FRAME = 'odom'


def load_pointcloud(graph_dir: str | Path, snapshot_id: str) -> np.ndarray:
    """Decode a single waypoint snapshot's point cloud as an Nx3 float32 array
    in its native sensor frame (no anchoring applied)."""
    graph_dir = Path(graph_dir)
    snap = map_pb2.WaypointSnapshot()
    snap.ParseFromString((graph_dir / 'waypoint_snapshots' / snapshot_id).read_bytes())
    n = snap.point_cloud.num_points
    if n == 0:
        return np.zeros((0, 3), dtype=np.float32)
    return np.frombuffer(snap.point_cloud.data, dtype=np.float32).reshape(n, 3)


def load_all_points_in_seed(graph_dir: str | Path) -> np.ndarray:
    """Return every waypoint snapshot's feature cloud, transformed into the
    seed frame and concatenated. Shape (N, 3) float32. Skips snapshots that
    can't be transformed (missing anchor or odom in the snapshot's frame tree).
    """
    from bosdyn.client import frame_helpers   # local to keep the cold-import path light

    graph_dir = Path(graph_dir)
    graph = map_pb2.Graph()
    graph.ParseFromString((graph_dir / 'graph').read_bytes())

    seed_T_wp = {a.id: _se3_from_proto(a.seed_tform_waypoint) for a in graph.anchoring.anchors}
    if not seed_T_wp:
        return np.zeros((0, 3), dtype=np.float32)

    chunks: list[np.ndarray] = []
    snap_dir = graph_dir / 'waypoint_snapshots'
    for wp in graph.waypoints:
        if wp.id not in seed_T_wp:
            continue
        f = snap_dir / wp.snapshot_id
        if not f.exists():
            continue
        snap = map_pb2.WaypointSnapshot()
        snap.ParseFromString(f.read_bytes())
        n = snap.point_cloud.num_points
        if n == 0:
            continue
        try:
            odom_T_cloud = frame_helpers.get_a_tform_b(
                snap.point_cloud.source.transforms_snapshot,
                ODOM_FRAME,
                snap.point_cloud.source.frame_name_sensor)
        except Exception:
            continue
        if odom_T_cloud is None:
            continue
        wp_T_odom = _se3_from_proto(wp.waypoint_tform_ko)
        seed_T_cloud = seed_T_wp[wp.id] * wp_T_odom * odom_T_cloud
        T = seed_T_cloud.to_matrix()
        pts = np.frombuffer(snap.point_cloud.data, dtype=np.float32).reshape(n, 3)
        # Affine: pts @ R.T + t
        chunks.append((pts @ T[:3, :3].T + T[:3, 3]).astype(np.float32))
    if not chunks:
        return np.zeros((0, 3), dtype=np.float32)
    return np.concatenate(chunks, axis=0)
