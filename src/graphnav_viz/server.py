"""FastAPI app: serves graphs from a parent directory + annotations + UI."""

from __future__ import annotations

import argparse
import dataclasses
import logging
from pathlib import Path

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

from . import export, loader
from .config import AppConfig, load_config
from .schema import Annotations

LOG = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).parent / 'static'


def discover_graphs(root: Path, max_depth: int = 2) -> dict[str, Path]:
    """Find graphs under `root` (any directory containing a `graph` proto file).

    Walks up to `max_depth` levels. Names are the path relative to `root`,
    with `/` replaced by `__` so they survive in URLs without escaping.
    If `root` itself is a graph dir, returns {root.name: root}.
    """
    if (root / 'graph').is_file():
        return {root.name: root}
    if not root.is_dir():
        return {}

    out: dict[str, Path] = {}

    def walk(d: Path, depth: int) -> None:
        if (d / 'graph').is_file():
            rel = d.relative_to(root).as_posix()
            out[rel.replace('/', '__')] = d
            return  # don't recurse below a graph dir
        if depth >= max_depth:
            return
        for child in sorted(d.iterdir()):
            if child.is_dir() and child.name not in {'waypoint_snapshots', 'edge_snapshots'}:
                walk(child, depth + 1)

    walk(root, 0)
    return out


def build_graph_map(cfg: AppConfig) -> dict[str, Path]:
    """Discover graphs under `graphs_root`, then merge in explicit entries.

    Explicit entries win on name collision. Missing/non-graph paths are
    logged as warnings and skipped, not fatal.
    """
    graphs: dict[str, Path] = {}
    if cfg.graphs_root is not None:
        graphs.update(discover_graphs(cfg.graphs_root))
    for entry in cfg.graphs:
        if not (entry.path / 'graph').is_file():
            LOG.warning('Skipping explicit graph %r: no `graph` file at %s',
                        entry.name, entry.path)
            continue
        graphs[entry.name] = entry.path
    return graphs


def create_app(cfg: AppConfig) -> FastAPI:
    graphs = build_graph_map(cfg)
    if not graphs:
        raise FileNotFoundError(
            f'No graphs found under {cfg.graphs_root} and no explicit entries.')
    cache: dict[str, loader.GraphData] = {}
    points_cache: dict[str, np.ndarray] = {}

    def _get(name: str) -> tuple[Path, loader.GraphData]:
        if name not in graphs:
            raise HTTPException(404, f'graph {name!r} not found')
        if name not in cache:
            cache[name] = loader.load(graphs[name])
        return graphs[name], cache[name]

    app = FastAPI(title='GraphNav Annotation App')
    app.add_middleware(GZipMiddleware, minimum_size=1024)

    @app.get('/api/graphs')
    def list_graphs():
        out = []
        for name, path in graphs.items():
            entry = {'name': name, 'path': str(path)}
            if name in cache:
                gd = cache[name]
                entry.update(waypoints=len(gd.waypoints), fiducials=len(gd.fiducials),
                             anchored=gd.anchored)
            out.append(entry)
        return out

    @app.get('/api/graphs/{name}')
    def get_graph(name: str):
        _, gd = _get(name)
        return dataclasses.asdict(gd)

    @app.get('/api/graphs/{name}/all_points')
    def get_all_points(name: str):
        path, _ = _get(name)
        if name not in points_cache:
            points_cache[name] = loader.load_all_points_in_seed_cached(path)
        pts = points_cache[name]
        return Response(content=pts.astype(np.float32).tobytes(),
                        media_type='application/octet-stream',
                        headers={'X-Point-Count': str(pts.shape[0])})

    @app.get('/api/graphs/{name}/pointcloud/{snapshot_id}')
    def get_pointcloud(name: str, snapshot_id: str):
        path, _ = _get(name)
        try:
            pts = loader.load_pointcloud(path, snapshot_id)
        except FileNotFoundError:
            raise HTTPException(404, f'snapshot {snapshot_id} not found')
        return Response(content=pts.astype(np.float32).tobytes(),
                        media_type='application/octet-stream')

    @app.get('/api/graphs/{name}/annotations', response_model=Annotations)
    def get_annotations(name: str):
        path, _ = _get(name)
        f = path / 'annotations.json'
        if f.exists():
            return Annotations.model_validate_json(f.read_text())
        return Annotations()

    @app.put('/api/graphs/{name}/annotations', response_model=Annotations)
    def put_annotations(name: str, ann: Annotations):
        path, _ = _get(name)
        f = path / 'annotations.json'
        tmp = f.with_suffix('.json.tmp')
        tmp.write_text(ann.model_dump_json(indent=2))
        tmp.replace(f)
        return ann

    @app.post('/api/graphs/{name}/export/doors')
    def post_export_doors(name: str):
        path, _ = _get(name)
        f = path / 'annotations.json'
        if not f.exists():
            raise HTTPException(400, 'No annotations saved yet.')
        ann = Annotations.model_validate_json(f.read_text())
        out = export.write_doors_yaml(ann, path / 'doors.yaml')
        return {'path': str(out), 'count': len(ann.doors)}

    app.mount('/', StaticFiles(directory=str(STATIC_DIR), html=True), name='static')
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=None,
                        help='Path to graphnav_viz.yaml. Defaults to '
                             './graphnav_viz.yaml if present, else built-in defaults.')
    parser.add_argument('--graphs', default=None,
                        help='Override graphs_root from the config: a parent directory '
                             'containing graph subdirectories, OR a single graph directory. '
                             'Walks up to 2 levels deep.')
    parser.add_argument('--host', default=None)
    parser.add_argument('--port', type=int, default=None)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(name)s: %(message)s')

    cfg = load_config(args.config)
    if args.graphs is not None:
        cfg.graphs_root = Path(args.graphs)
    if args.host is not None:
        cfg.server.host = args.host
    if args.port is not None:
        cfg.server.port = args.port

    uvicorn.run(create_app(cfg), host=cfg.server.host, port=cfg.server.port)


if __name__ == '__main__':
    main()
