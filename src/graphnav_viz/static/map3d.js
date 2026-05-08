// 3D viewer: waypoints + edges + fiducials, with on-demand point clouds.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class Map3D {
  constructor(container, graph, state, callbacks) {
    this.container = container;
    this.graph = graph;
    this.state = state;
    this.cb = callbacks;
    this.loadedClouds = new Set();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f1116);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 500);
    this.camera.up.set(0, 0, 1);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    container.appendChild(this.renderer.domElement);

    // Light so MeshLambert surfaces (none right now, but future-proof) light up
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));

    this._build();

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this._fit();

    // Defer first resize until container actually has a size (it starts hidden).
    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(container);
    this._resize();

    this.raycaster = new THREE.Raycaster();
    this.renderer.domElement.addEventListener('click', e => this._onClick(e));

    this._tick();
  }

  refit() {
    this._fit();
    this._resize();
  }

  setScans(arr) {
    if (this.scansObject) {
      this.scene.remove(this.scansObject);
      this.scansObject.geometry.dispose();
      this.scansObject.material.dispose();
      this.scansObject = null;
    }
    if (!arr || !arr.length) return;
    const b = this.graph.bounds;
    const zmin = b.min_z, zspan = Math.max(1e-3, b.max_z - b.min_z);
    const colors = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i += 3) {
      const t = (arr[i + 2] - zmin) / zspan;
      // blue (low) → green → red (high)
      colors[i]     = Math.min(1, Math.max(0, 2 * t - 1));
      colors[i + 1] = Math.max(0, 1 - Math.abs(2 * t - 1));
      colors[i + 2] = Math.min(1, Math.max(0, 1 - 2 * t));
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({ size: 0.04, vertexColors: true,
                                           sizeAttenuation: true });
    this.scansObject = new THREE.Points(geom, mat);
    this.scene.add(this.scansObject);
  }

  _fit() {
    const b = this.graph.bounds;
    const cx = (b.min_x + b.max_x) / 2;
    const cy = (b.min_y + b.max_y) / 2;
    const cz = (b.min_z + b.max_z) / 2;
    const span = Math.max(b.max_x - b.min_x, b.max_y - b.min_y, 2);
    this.camera.position.set(cx, cy - span * 1.2, cz + span * 0.8);
    this.controls?.target.set(cx, cy, cz);
    this.controls?.update();
  }

  _build() {
    const wpById = Object.fromEntries(this.graph.waypoints.map(w => [w.id, w]));

    // Edges
    const linePts = [];
    for (const e of this.graph.edges) {
      const a = wpById[e.from], b = wpById[e.to];
      if (!a || !b) continue;
      linePts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const lineGeom = new THREE.BufferGeometry();
    lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(linePts, 3));
    this.scene.add(new THREE.LineSegments(lineGeom,
      new THREE.LineBasicMaterial({ color: 0xa0aec0, opacity: 0.5, transparent: true })));

    // Waypoints
    const wpGeom = new THREE.SphereGeometry(0.12, 12, 8);
    const wpMat = new THREE.MeshBasicMaterial({ color: 0x63b3ed });
    this.wpMesh = new THREE.InstancedMesh(wpGeom, wpMat, this.graph.waypoints.length);
    const m = new THREE.Matrix4();
    this.wpIndexToId = [];
    this.graph.waypoints.forEach((wp, i) => {
      m.setPosition(wp.x, wp.y, wp.z);
      this.wpMesh.setMatrixAt(i, m);
      this.wpIndexToId.push(wp.id);
    });
    this.scene.add(this.wpMesh);

    // Fiducials colored by category.
    const FIDUCIAL_COLORS_HEX = {
      localization: 0xf56565, dock: 0x4fd1c5, dock_station: 0x38b2ac,
      mission_interrupt: 0xed8936, unknown: 0xa0aec0,
    };
    this.fiducialObjects = [];
    const fGeom = new THREE.BoxGeometry(0.2, 0.2, 0.04);
    for (const f of this.graph.fiducials) {
      const color = FIDUCIAL_COLORS_HEX[f.category] ?? FIDUCIAL_COLORS_HEX.unknown;
      const cube = new THREE.Mesh(fGeom, new THREE.MeshBasicMaterial({ color }));
      cube.position.set(f.x, f.y, f.z);
      cube.userData = { fiducial: f };
      this.scene.add(cube);
      this.fiducialObjects.push(cube);
    }

    // Reference grid on the floor at min_z
    const b = this.graph.bounds;
    const span = Math.max(b.max_x - b.min_x, b.max_y - b.min_y, 5);
    const grid = new THREE.GridHelper(span * 1.5, Math.max(10, Math.round(span)), 0x444444, 0x2a2a2a);
    grid.rotateX(Math.PI / 2);
    grid.position.set((b.min_x + b.max_x) / 2, (b.min_y + b.max_y) / 2, b.min_z - 0.05);
    this.scene.add(grid);
  }

  _resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _tick() {
    this._raf = requestAnimationFrame(() => this._tick());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  async _onClick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    this.raycaster.setFromCamera({ x, y }, this.camera);
    const fHit = this.raycaster.intersectObjects(this.fiducialObjects)[0];
    if (fHit) { this.cb.onSelectFiducial?.(fHit.object.userData.fiducial); return; }
    const wpHit = this.raycaster.intersectObject(this.wpMesh)[0];
    if (wpHit?.instanceId !== undefined) {
      const id = this.wpIndexToId[wpHit.instanceId];
      const wp = this.graph.waypoints.find(w => w.id === id);
      this.cb.onSelectWaypoint?.(wp);
      this._loadCloud(wp);
    }
  }

  async _loadCloud(wp) {
    if (this.loadedClouds.has(wp.id)) return;
    this.loadedClouds.add(wp.id);
    const apiBase = this.cb.apiBase ? this.cb.apiBase() : '/api';
    const buf = await fetch(`${apiBase}/pointcloud/${encodeURIComponent(wp.snapshot_id)}`)
      .then(r => r.arrayBuffer());
    const arr = new Float32Array(buf);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    geom.translate(wp.x, wp.y, wp.z);
    this.scene.add(new THREE.Points(geom, new THREE.PointsMaterial({ color: 0x9ae6b4, size: 0.03 })));
  }
}
